import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateGuestDto } from '../admin/guests/dto/create-guest.dto';
import { UpdateGuestDto } from '../admin/guests/dto/update-guest.dto';
import { GuestsService } from '../admin/guests/guests.service';
import { Event, RsvpStatus } from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { UserEventsService } from '../user/events/user-events.service';
import { BotIntent, RsvpFilterStatus } from './bot-intent';
import { parseCommand } from './command.parser';
import { ConversationContext, ConversationStore } from './conversation.store';
import {
  PendingAction,
  advanceFlow,
  startAddGuestFlow,
  startEditGuestFlow,
} from './flow.machine';
import { WhatsappLinkService } from './whatsapp-link.service';
import { WhatsappReply, buttonsReply, listReply, textReply } from './whatsapp-reply';
import { WhatsappClient } from './whatsapp.client';
import { GuestRsvpMatch, parseGuestRsvp } from './guest-rsvp.parser';

export interface WhatsappWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id: string;
          from: string;
          type?: string;
          text?: { body: string };
          interactive?: {
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string };
          };
          button?: { payload: string; text: string };
        }>;
      };
    }>;
  }>;
}

export interface WhatsappMessage {
  id: string;
  from: string;
  type?: string;
  text?: { body: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload: string; text: string };
}

/**
 * Single normalization point for BOTH inbound interactive-reply shapes Meta
 * documents separately: a free-form interactive button (`type:"interactive"`,
 * `interactive.button_reply.id`) and a TEMPLATE quick-reply button
 * (`type:"button"`, `button.payload`). A handler that only inspected
 * `interactive.button_reply` would silently drop every template button tap.
 * Precedence (interactive before button) is fixed because the two shapes are
 * mutually exclusive in practice — see `sdd/guest-whatsapp-notify/design` D3.
 */
export function extractInteractiveId(message: WhatsappMessage): string | undefined {
  return (
    message.interactive?.button_reply?.id ??
    message.interactive?.list_reply?.id ??
    message.button?.payload
  );
}

const MESSAGE_ID_TTL_SECONDS = 86400; // 24h — enough to cover Meta's retry window
const USER_LOCK_TTL_SECONDS = 15; // safety cap so a crashed handler can't wedge a user forever
const USER_LOCK_MAX_ATTEMPTS = 5; // bounded wait so we NEVER drop a message on contention
const USER_LOCK_BACKOFF_MS = 150; // delay between lock acquisition attempts
const MAX_LIST_ROWS = 10; // WhatsApp interactive lists allow at most 10 rows
const MAX_LIST_ROW_TITLE = 24; // WhatsApp interactive-list row titles are capped at 24 chars
const OTP_CODE_PATTERN = /^\d{6}$/;
/**
 * How long a conversation may sit idle before the bot re-confirms which event
 * it is talking about. MUST stay below the ConversationStore's 1800s TTL —
 * otherwise the context would expire before this gate could ever fire, and the
 * user would silently lose the active event instead of being asked about it.
 */
export const EVENT_CONFIRM_STALE_MS = 10 * 60 * 1000;

/**
 * The intents that operate on `ctx.currentEventId` (i.e. every one that ends
 * up inside `withCurrentEvent`). Only these can trigger the re-confirmation
 * gate — navigation intents like MENU or LIST_EVENTS must never be
 * interrupted by it, or the user could not escape the prompt.
 */
const EVENT_SCOPED_INTENT_KINDS: ReadonlySet<BotIntent['kind']> = new Set([
  'EVENT_DETAIL',
  'RSVP_SUMMARY',
  'SEARCH_GUEST',
  'FILTER_BY_STATUS',
  'START_ADD_GUEST',
  'START_EDIT_GUEST',
  'RSVP_CONFIRM',
  'RSVP_DECLINE',
]);

/**
 * The ONLY intents allowed to break out of an active write-flow. Everything
 * else — including every recognized command synonym — is step input, because
 * a guest name, email or field value can normalize to any of them. Keeping
 * this list tiny and explicit is what stops `salir`/`info`/`resumen` from
 * silently destroying or derailing an in-progress add/edit.
 *
 * Exported for the spec so the allowlist can be asserted directly.
 */
export const FLOW_ESCAPE_INTENT_KINDS: ReadonlySet<BotIntent['kind']> = new Set([
  'CANCEL',
  'MENU',
]);

const RSVP_LABELS: Record<RsvpFilterStatus, string> = {
  ACCEPTED: 'Confirmados',
  PENDING: 'Pendientes',
  DECLINED: 'Rechazados',
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly whatsappLinkService: WhatsappLinkService,
    private readonly conversationStore: ConversationStore,
    private readonly whatsappClient: WhatsappClient,
    private readonly userEventsService: UserEventsService,
    private readonly guestsService: GuestsService,
  ) {}

  async handleIncoming(payload: WhatsappWebhookPayload): Promise<void> {
    const message = this.extractMessage(payload);
    if (!message) {
      return;
    }

    const phoneNumber = message.from;

    // Serialize concurrent messages from the same user with a bounded-wait
    // lock. The webhook controller replies 200 unconditionally, so Meta's
    // Cloud API NEVER retries — returning early here would drop the message
    // forever. Therefore, if the lock stays contended after all attempts, we
    // process the message anyway (best-effort) rather than dropping it. The
    // message-id dedup claim below still guards against genuine reprocessing.
    const holdsLock = await this.acquireUserLock(phoneNumber, message.id);

    try {
      const claimed = await this.redisService.setNX(
        `wa:msg:${message.id}`,
        'processed',
        MESSAGE_ID_TTL_SECONDS,
      );

      if (!claimed) {
        this.logger.log(`Duplicate message_id ${message.id} — skipping reprocessing`);
        return;
      }

      // Guest RSVP button taps are recognized and handled here, BEFORE phone
      // resolution: a guest phone is never in `whatsapp_links`, so falling
      // through to `resolvePhone` would hit the PIN-linking reply and
      // silently discard the tap. This branch never touches
      // `ConversationStore`, the flow machine, or organizer state — it always
      // `return`s, so every existing organizer bot path is unaffected by
      // construction. See `sdd/guest-whatsapp-notify/design` decision D2.
      const guardInteractiveId = extractInteractiveId(message);
      const guestRsvpMatch = guardInteractiveId ? parseGuestRsvp(guardInteractiveId) : undefined;
      if (guestRsvpMatch) {
        const guestReply = await this.handleGuestRsvpTap(guestRsvpMatch);
        await this.sendReply(phoneNumber, guestReply);
        return;
      }

      const text = message.text?.body?.trim() ?? '';

      // Resolve the phone BEFORE any OTP handling. A 6-digit text is only an
      // OTP attempt when the phone is UNLINKED — a linked user mid-flow could
      // legitimately send a 6-digit value (e.g. a numeric field), and it must
      // never hijack their active conversation.
      const userId = await this.whatsappLinkService.resolvePhone(phoneNumber);
      if (!userId) {
        if (OTP_CODE_PATTERN.test(text)) {
          const linked = await this.whatsappLinkService.verifyAndLink(text, phoneNumber);
          if (!linked) {
            this.logger.log(`Failed OTP verification attempt from ${phoneNumber}`);
          }
          await this.sendReply(
            phoneNumber,
            linked
              ? textReply(
                  'Listo, tu numero quedo vinculado a tu cuenta. Envia "menu" para ver que puedes hacer.',
                )
              : textReply(
                  'Ese codigo no es valido o expiro. Genera un PIN nuevo desde tu panel y vuelve a enviarlo.',
                ),
          );
          return;
        }
        this.logger.log(`Unlinked phone ${phoneNumber} — replying with linking instructions`);
        await this.sendReply(
          phoneNumber,
          textReply(
            'Hola! Soy el asistente de Invitae. Puedes administrar tus eventos, invitados, y notificaciones desde aqui, genera tu PIN de vinculacion en tu panel y envialo por este chat.',
          ),
        );
        return;
      }

      const stored = await this.conversationStore.get(phoneNumber);
      // A stored context belongs to whoever owned this phone number when it
      // was written. `verifyAndLink` upserts on the unique phoneNumber, so a
      // number CAN be re-linked to a different account — if that happened, the
      // stored event/flow state is another user's and must NEVER be reused.
      const isStoredContextStale = !!stored && stored.userId !== userId;
      if (isStoredContextStale) {
        await this.discardStaleContextBestEffort(phoneNumber);
      }
      const ctx: ConversationContext = stored && !isStoredContextStale ? stored : { userId };

      const interactiveId = extractInteractiveId(message);
      const intent = parseCommand({ text, interactiveId });

      // While a write-flow is active, almost everything the user types is step
      // input — a guest could legitimately be named "Menu" or "Resumen", and
      // an email or a ticket count can normalize to a recognized synonym too.
      // Only the explicit escape hatches below may break out of the flow;
      // EVERYTHING else is fed to the flow machine.
      const consumedByFlow = !!ctx.pendingAction && !FLOW_ESCAPE_INTENT_KINDS.has(intent.kind);

      // After a long silence, re-confirm WHICH event we are talking about
      // before acting on it. Checked before dispatch so the parked intent can
      // be replayed verbatim once the user answers.
      const reconfirmReply = await this.maybeAskEventReconfirmation(intent, ctx, phoneNumber);
      if (reconfirmReply) {
        await this.sendReply(phoneNumber, reconfirmReply);
        return;
      }

      const reply = consumedByFlow
        ? await this.handleFlowInput(ctx, phoneNumber, text, intent)
        : await this.dispatch(intent, ctx, phoneNumber);
      await this.sendReply(phoneNumber, reply);
    } finally {
      // Only release a lock we actually hold, and only if its value is still
      // ours (compare-and-delete) — never steal a later handler's lock that
      // was acquired after ours TTL-expired.
      if (holdsLock) {
        await this.redisService.delIfEquals(`wa:lock:${phoneNumber}`, message.id);
      }
    }
  }

  /**
   * The "are we still on this event?" gate. Returns a reply ONLY when every
   * condition holds: an event is active, the context has gone stale, no write
   * flow is in progress (an in-flight add/edit is never interrupted), and the
   * intent actually needs the current event. Anything else returns `undefined`
   * so the caller dispatches normally.
   *
   * The event NAME is resolved through `withCurrentEvent`, the same ownership
   * choke point every event-scoped command uses — so the name shown is real
   * and membership is re-validated even here.
   */
  private async maybeAskEventReconfirmation(
    intent: BotIntent,
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<WhatsappReply | undefined> {
    if (!ctx.currentEventId || ctx.pendingAction) {
      return undefined;
    }
    if (!EVENT_SCOPED_INTENT_KINDS.has(intent.kind)) {
      return undefined;
    }
    if (ctx.lastInteractionAt === undefined) {
      return undefined;
    }

    if (Date.now() - ctx.lastInteractionAt <= EVENT_CONFIRM_STALE_MS) {
      // Fresh enough to proceed — but stamp the context so a long, chatty
      // session of read-only commands never drifts into the stale window and
      // interrupts the user mid-conversation.
      await this.touchConversationBestEffort(ctx, phoneNumber);
      return undefined;
    }

    return this.withCurrentEvent<WhatsappReply | undefined>(ctx, async (_eventId, event) => {
      try {
        await this.conversationStore.set(phoneNumber, { ...ctx, pendingIntent: intent });
      } catch (err) {
        // Never ask a question whose answer we cannot remember. Worse, an
        // exception here would escape `handleIncoming` — the controller has no
        // try/catch and there is no global exception filter, so it would 500
        // AFTER the `wa:msg:{id}` dedup key was claimed, silently discarding
        // Meta's retry. Falling through to normal dispatch answers the user's
        // actual command instead.
        this.logger.error(
          `Failed to park pending intent for ${phoneNumber} — skipping event re-confirmation`,
          err instanceof Error ? err.stack : String(err),
        );
        return undefined;
      }
      return buttonsReply(
        `Paso un rato desde tu ultimo mensaje. Seguimos trabajando en "${event.name}"?`,
        [
          { id: 'resume_event', title: 'Si, continuar' },
          { id: 'list_events', title: 'Elegir otro evento' },
        ],
      );
    });
  }

  /**
   * Refreshes `lastInteractionAt` (and the sliding TTL) without changing any
   * identity or flow field. Any `pendingIntent` IS dropped: reaching this
   * point means the gate did not fire and the message is being dispatched
   * normally, which makes an intent parked during an earlier interruption
   * obsolete. Re-persisting it verbatim would let the user scroll up, tap the
   * old "Si, continuar" button, and replay a long-dead command.
   *
   * Failures are logged and swallowed — a Redis hiccup here must never stop
   * the user's actual command from being answered.
   */
  private async touchConversationBestEffort(
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<void> {
    await this.persistBestEffort(
      phoneNumber,
      this.withoutPendingIntent(ctx),
      'refresh the conversation timestamp',
    );
  }

  /**
   * Writes a context, logging and swallowing any failure. Every best-effort
   * persist funnels through here: the caller has already decided the user's
   * reply, and `handleIncoming` is invoked from a controller with no
   * try/catch and no global exception filter — so an escaping error would
   * 500 the webhook AFTER the `wa:msg:{id}` dedup key was claimed, meaning
   * Meta's retry is skipped and the message is lost outright.
   */
  private async persistBestEffort(
    phoneNumber: string,
    ctx: ConversationContext,
    operation: string,
  ): Promise<void> {
    try {
      await this.conversationStore.set(phoneNumber, ctx);
    } catch (err) {
      this.logger.error(
        `Failed to ${operation} for ${phoneNumber}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Deletes the whole stored context after a phone re-link is detected. This
   * is the one case where `ConversationStore.clear` is right: the state does
   * not belong to the current owner at all, so nothing in it — not even the
   * active event — may be carried forward. Best-effort: failing to evict it
   * must not block the new owner's message, which already ignores it.
   */
  private async discardStaleContextBestEffort(phoneNumber: string): Promise<void> {
    this.logger.warn(
      `Stored conversation for ${phoneNumber} belongs to a different user — discarding it`,
    );
    try {
      await this.conversationStore.clear(phoneNumber);
    } catch (err) {
      this.logger.error(
        `Failed to clear the re-linked conversation for ${phoneNumber}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Bounded-wait acquisition of the per-user lock. Retries `setNX` up to
   * `USER_LOCK_MAX_ATTEMPTS` times with a `USER_LOCK_BACKOFF_MS` backoff.
   * Returns `true` if the lock was acquired (caller must release it), or
   * `false` if it stayed contended after every attempt — in which case the
   * caller proceeds WITHOUT the lock (best-effort) so the message is never
   * dropped. The token (`message.id`) makes release a safe compare-and-delete.
   */
  private async acquireUserLock(phoneNumber: string, token: string): Promise<boolean> {
    for (let attempt = 1; attempt <= USER_LOCK_MAX_ATTEMPTS; attempt++) {
      const acquired = await this.redisService.setNX(
        `wa:lock:${phoneNumber}`,
        token,
        USER_LOCK_TTL_SECONDS,
      );
      if (acquired) {
        return true;
      }
      if (attempt < USER_LOCK_MAX_ATTEMPTS) {
        await this.delay(USER_LOCK_BACKOFF_MS);
      }
    }
    this.logger.warn(
      `Could not acquire user lock for ${phoneNumber} after ${USER_LOCK_MAX_ATTEMPTS} attempts — processing best-effort without lock`,
    );
    return false;
  }

  /**
   * Isolated so tests can stub the backoff instead of sleeping for real.
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Single call site that maps a `WhatsappReply` to the matching
   * `WhatsappClient` sender. Every reply builder in this service returns a
   * `WhatsappReply` value instead of calling the client directly — this is
   * the ONLY place that decides text vs. interactive-buttons vs.
   * interactive-list, keeping "exactly one outbound message per handled
   * inbound message" enforceable in one spot.
   */
  private async sendReply(phoneNumber: string, reply: WhatsappReply): Promise<void> {
    switch (reply.kind) {
      case 'text':
        await this.whatsappClient.sendText(phoneNumber, reply.body);
        return;
      case 'buttons':
        await this.whatsappClient.sendInteractiveButtons(phoneNumber, reply.body, reply.buttons);
        return;
      case 'list':
        await this.whatsappClient.sendInteractiveList(
          phoneNumber,
          reply.body,
          reply.buttonLabel,
          reply.rows,
        );
        return;
    }
  }

  private async dispatch(
    intent: BotIntent,
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<WhatsappReply> {
    switch (intent.kind) {
      case 'MENU':
        return this.buildMenuReply();

      case 'MENU_MORE':
        return this.buildMoreOptionsReply();

      case 'LIST_EVENTS': {
        const events = await this.userEventsService.findByUser(ctx.userId);
        return this.buildEventsListReply(events);
      }

      case 'SELECT_EVENT':
        return this.handleSelectEvent(intent.eventId, ctx, phoneNumber);

      case 'EVENT_DETAIL':
        return this.withCurrentEvent(ctx, async (_eventId, event) =>
          this.buildEventDetailReply(event),
        );

      case 'SEARCH_GUEST':
        return this.withCurrentEvent(ctx, async (eventId) => {
          const { data } = await this.guestsService.findAllPaginated(eventId, {
            search: intent.term,
            page: 1,
            limit: 10,
          });
          return this.buildGuestListReply(data);
        });

      case 'FILTER_BY_STATUS':
        return this.withCurrentEvent(ctx, async (eventId) => {
          const guests = await this.guestsService.findAll(eventId);
          const filtered = guests.filter((g) => g.rsvpStatus === intent.status);
          return this.buildFilteredGuestsReply(intent.status, filtered);
        });

      case 'RSVP_SUMMARY':
        return this.withCurrentEvent(ctx, async (eventId) => {
          const guests = await this.guestsService.findAll(eventId);
          return this.buildSummaryReply(guests);
        });

      case 'CANCEL':
        // Cancelling abandons the pending FLOW, not the conversation: the
        // active event must survive, or the user has to re-pick it every time
        // they back out of an add/edit.
        await this.conversationStore.set(phoneNumber, this.withoutPending(ctx));
        return textReply('Operacion cancelada.');

      case 'RESUME_EVENT': {
        // Pop the parked intent and replay it so the user's original request
        // runs without retyping. `pendingIntent` is only ever set by the
        // re-confirmation gate, which never parks a RESUME_EVENT — so this
        // cannot recurse.
        const parked = ctx.pendingIntent;
        const resumedCtx = this.withoutPending(ctx);
        // Best-effort: if the pop cannot be persisted the user must STILL get
        // their answer. Throwing here would leave the stale pendingIntent in
        // Redis and re-ask the same question on the next message — an
        // unbounded loop for as long as Redis stays unhealthy.
        await this.persistBestEffort(
          phoneNumber,
          resumedCtx,
          'persist the resumed conversation',
        );
        return parked
          ? this.dispatch(parked, resumedCtx, phoneNumber)
          : this.buildMenuReply();
      }

      case 'START_ADD_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startAddGuestFlow();
          await this.conversationStore.set(phoneNumber, {
            ...this.withoutPendingIntent(ctx),
            pendingAction: pending,
          });
          return textReply('Vamos a agregar un invitado. Escribe el/los nombres.');
        });

      case 'START_EDIT_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startEditGuestFlow(intent.guestId);
          await this.conversationStore.set(phoneNumber, {
            ...this.withoutPendingIntent(ctx),
            pendingAction: pending,
          });
          return textReply('Que campo quieres editar? (nombre, telefono, email, tickets)');
        });

      case 'CONFIRM_ACTION':
        return textReply('No hay ninguna accion pendiente para confirmar.');

      case 'RSVP_CONFIRM':
        return this.withCurrentEvent(ctx, async (eventId) => {
          await this.guestsService.update(eventId, intent.guestId, {
            rsvpStatus: 'ACCEPTED',
          } as UpdateGuestDto);
          return textReply('RSVP confirmado.');
        });

      case 'RSVP_DECLINE':
        return this.withCurrentEvent(ctx, async (eventId) => {
          await this.guestsService.update(eventId, intent.guestId, {
            rsvpStatus: 'DECLINED',
          } as UpdateGuestDto);
          return textReply('RSVP marcado como rechazado.');
        });

      case 'UNKNOWN':
      default:
        return textReply('No entendi ese comando. Envia "menu" para ver las opciones disponibles.');
    }
  }

  /**
   * Consumes one message as input for the active write-flow (`agregar` or
   * `editar`). A `CONFIRM_ACTION` intent (the "confirm" button) is fed as
   * the flow's `CONFIRM` action; anything else is fed as raw text `INPUT`.
   * `advanceFlow` is pure — it NEVER calls `GuestsService` itself. Only a
   * `COMPLETE` result here triggers the actual write, and only after
   * `withCurrentEvent` re-validates membership one more time (the flow may
   * have been sitting idle for a while).
   */
  private async handleFlowInput(
    ctx: ConversationContext,
    phoneNumber: string,
    text: string,
    intent: BotIntent,
  ): Promise<WhatsappReply> {
    const pending = ctx.pendingAction as PendingAction;
    // `CONFIRM` is only meaningful once the flow has actually reached its
    // CONFIRM step. On an INPUT step a confirmation WORD ("si", "ok",
    // "confirmar") is just data — a guest really can be named "Si" — so it is
    // captured as input rather than firing a premature confirmation.
    const awaitingConfirmation = pending.step === 'CONFIRM';
    const result =
      intent.kind === 'CONFIRM_ACTION' && awaitingConfirmation
        ? advanceFlow(pending, { type: 'CONFIRM' })
        : advanceFlow(pending, { type: 'INPUT', value: text });

    switch (result.status) {
      case 'CANCELLED':
        await this.conversationStore.set(phoneNumber, this.withoutPending(ctx));
        return textReply(result.message);

      case 'INVALID':
      case 'ADVANCED':
        await this.conversationStore.set(phoneNumber, {
          ...this.withoutPendingIntent(ctx),
          pendingAction: result.pending,
        });
        return textReply(result.message);

      case 'AWAITING_CONFIRM':
        // The flow just reached its CONFIRM step (all data collected). The
        // Destructive Action Confirmation requirement needs a REAL button
        // for the organizer to tap — the ids below MUST match what
        // `command.parser` recognizes ('confirm' -> CONFIRM_ACTION,
        // 'cancel' -> CANCEL), otherwise this button would be untappable.
        await this.conversationStore.set(phoneNumber, {
          ...this.withoutPendingIntent(ctx),
          pendingAction: result.pending,
        });
        return buttonsReply(result.message, [
          { id: 'confirm', title: 'Confirmar' },
          { id: 'cancel', title: 'Cancelar' },
        ]);

      case 'COMPLETE':
        return this.completeFlow(result.pending, ctx, phoneNumber);
    }
  }

  /**
   * Performs the actual `GuestsService.create`/`.update` write for a
   * completed write-flow. Routed through `withCurrentEvent` — the SAME
   * ownership choke point every other event-scoped operation uses — so
   * membership is re-validated immediately before the write, never trusted
   * from when the flow started.
   */
  private async completeFlow(
    pending: PendingAction,
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<WhatsappReply> {
    return this.withCurrentEvent(ctx, async (eventId) => {
      // The try/catch wraps ONLY the write. If the write succeeds but a later
      // step (clearing the conversation) throws, we must NOT tell the user the
      // save failed — that would make them retry and create a DUPLICATE guest.
      try {
        if (pending.flow === 'AGREGAR') {
          await this.guestsService.create(eventId, {
            name: pending.data.name,
            phone: pending.data.phone,
            tickets: pending.data.tickets,
            email: pending.data.email,
          } as CreateGuestDto);
        } else {
          await this.guestsService.update(eventId, pending.guestId, {
            [pending.field as string]: pending.value,
          } as UpdateGuestDto);
        }
      } catch (err) {
        // Write failed: don't leave the user stuck in CONFIRM. Clear the flow
        // best-effort and report the failure instead of rethrowing (which
        // would surface as a silent no-reply after they tapped confirm).
        this.logger.error(
          `Failed to persist guest write for ${phoneNumber}`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.clearConversationBestEffort(ctx, phoneNumber);
        return textReply(
          'No pude guardar los cambios por un error. Vuelve a intentarlo en unos minutos.',
        );
      }

      // Write succeeded. A failure clearing the conversation here is logged and
      // swallowed — never reported as a write failure.
      await this.clearConversationBestEffort(ctx, phoneNumber);
      return textReply(
        pending.flow === 'AGREGAR'
          ? 'Invitado agregado correctamente.'
          : 'Invitado actualizado correctamente.',
      );
    });
  }

  /**
   * Drops the pending flow/intent while PRESERVING the identity fields
   * (`userId`, `currentEventId`). Finishing or cancelling one action must not
   * make the bot forget which event the conversation is about — only genuinely
   * abandoning the conversation warrants `ConversationStore.clear`.
   */
  private withoutPending(ctx: ConversationContext): ConversationContext {
    const { pendingAction: _pendingAction, pendingIntent: _pendingIntent, ...rest } = ctx;
    return rest;
  }

  /**
   * Drops ONLY the parked `pendingIntent`, keeping any in-progress
   * `pendingAction`. Used on every path that persists while handling a
   * message normally — the parked intent is dead the moment a later message
   * is dispatched instead of answering the gate.
   */
  private withoutPendingIntent(ctx: ConversationContext): ConversationContext {
    const { pendingIntent: _pendingIntent, ...rest } = ctx;
    return rest;
  }

  /**
   * Persists the pending-free context, swallowing (and logging) any error.
   * Used after a guest write so a Redis hiccup here never masquerades as a
   * write failure — the write already succeeded and must be reported as such.
   */
  private async clearConversationBestEffort(
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<void> {
    await this.persistBestEffort(
      phoneNumber,
      this.withoutPending(ctx),
      'clear the pending action after a guest write',
    );
  }

  /**
   * SELECT_EVENT is the only intent that MUTATES the conversation context
   * (persists `currentEventId`). Membership is validated via
   * `UserEventsService.findOne` BEFORE anything is persisted — a
   * non-member's selection attempt never reaches `conversationStore.set`.
   */
  private async handleSelectEvent(
    eventId: string,
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<WhatsappReply> {
    try {
      const event = await this.userEventsService.findOne(eventId, ctx.userId);
      // Switching events invalidates anything parked against the previous one.
      const nextCtx: ConversationContext = {
        ...this.withoutPending(ctx),
        currentEventId: event.id,
      };
      await this.conversationStore.set(phoneNumber, nextCtx);
      return textReply(`Evento seleccionado: ${event.name}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return textReply('No tienes acceso a ese evento.');
      }
      throw err;
    }
  }

  /**
   * Every event-scoped READ command goes through here. `ctx.currentEventId`
   * from Redis is NEVER trusted on its own — membership is re-validated via
   * `UserEventsService.findOne` on EVERY single dispatch, before any
   * `GuestsService` call. This is the sole ownership enforcement point for
   * detalle/buscar/filtrar/resumen; a non-member never reaches GuestsService,
   * even if `currentEventId` is present in the stored context.
   */
  private async withCurrentEvent<T extends WhatsappReply | undefined = WhatsappReply>(
    ctx: ConversationContext,
    action: (eventId: string, event: Event) => Promise<T>,
  ): Promise<T | WhatsappReply> {
    if (!ctx.currentEventId) {
      return textReply('No tienes un evento activo. Envia "mis eventos" para elegir uno.');
    }

    let event: Event;
    try {
      event = await this.userEventsService.findOne(ctx.currentEventId, ctx.userId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return textReply('No tienes acceso a ese evento.');
      }
      throw err;
    }

    return action(ctx.currentEventId, event);
  }

  private buildMenuReply(): WhatsappReply {
    // Reply buttons are capped at 3: the two most common actions get a direct
    // button, and "Mas opciones" (id must match the parser's MENU_MORE) opens
    // the full list. Button ids must be parser-recognized or the button is dead.
    return buttonsReply('Menu principal. Que te gustaria hacer?', [
      { id: 'list_events', title: 'Mis eventos' },
      { id: 'add_guest', title: 'Agregar invitado' },
      { id: 'menu_more', title: 'Mas opciones' },
    ]);
  }

  private buildMoreOptionsReply(): WhatsappReply {
    // The actions that don't fit on the 3 main-menu buttons. Row ids must match
    // what `command.parser` recognizes. `buscar <nombre>` stays a typed command
    // (it needs a free-text argument a list row cannot carry).
    return listReply('Mas opciones', 'Ver opciones', [
      { id: 'detalle', title: 'Detalle del evento' },
      { id: 'resumen', title: 'Resumen' },
      { id: 'filter:confirmados', title: 'Ver confirmados' },
      { id: 'filter:pendientes', title: 'Ver pendientes' },
      { id: 'filter:rechazados', title: 'Ver rechazados' },
    ]);
  }

  /**
   * "mis eventos" is what makes `SELECT_EVENT` reachable at all: it is the
   * ONLY place the `select_event:{id}` row id is ever produced. The id sent
   * here MUST match `SELECT_EVENT_PATTERN` in `command.parser.ts`.
   */
  private buildEventsListReply(events: Pick<Event, 'id' | 'name'>[]): WhatsappReply {
    if (events.length === 0) {
      return textReply('No tienes eventos asociados todavia.');
    }
    // WhatsApp interactive lists allow at most 10 rows — cap here and tell the
    // user how to reach the rest instead of letting the API reject the message.
    // Row titles are also capped at 24 chars (event names are varchar(255)).
    const rows = events
      .slice(0, MAX_LIST_ROWS)
      .map((e) => ({ id: `select_event:${e.id}`, title: this.truncateRowTitle(e.name) }));
    const body =
      events.length > MAX_LIST_ROWS
        ? `Tus eventos (mostrando los primeros ${MAX_LIST_ROWS} de ${events.length}). Usa "buscar" para encontrar el resto:`
        : 'Tus eventos:';
    return listReply(body, 'Elegir evento', rows);
  }

  /**
   * WhatsApp rejects interactive-list row titles longer than 24 chars. Event
   * names are `varchar(255)`, so clamp each title, keeping an ellipsis inside
   * the 24-char budget when truncation happens.
   */
  private truncateRowTitle(title: string): string {
    if (title.length <= MAX_LIST_ROW_TITLE) {
      return title;
    }
    return `${title.slice(0, MAX_LIST_ROW_TITLE - 1)}…`;
  }

  private buildEventDetailReply(event: Event): WhatsappReply {
    return textReply(
      [
        `Evento: ${event.name}`,
        `Fecha: ${event.date}`,
        `Lugar: ${event.location ?? 'sin especificar'}`,
      ].join('\n'),
    );
  }

  /**
   * When a search matches exactly one guest, this doubles as the "guest
   * detail view" the spec's Confirm/Reject-by-Button requirement refers to:
   * it attaches `confirmar:{id}`/`rechazar:{id}` buttons for that guest
   * (ids `command.parser` already recognizes as RSVP_CONFIRM/RSVP_DECLINE).
   * Multiple matches stay a plain text list — WhatsApp interactive button
   * messages are capped at 3 buttons and can't carry one pair per row.
   */
  private buildGuestListReply(
    guests: Array<{ id: string; name: string; rsvpStatus: string }>,
  ): WhatsappReply {
    if (guests.length === 0) {
      return textReply('No se encontraron invitados que coincidan.');
    }
    if (guests.length === 1) {
      const guest = guests[0];
      return buttonsReply(`${guest.name} — estado: ${guest.rsvpStatus}`, [
        { id: `confirmar:${guest.id}`, title: 'Confirmar' },
        { id: `rechazar:${guest.id}`, title: 'Rechazar' },
      ]);
    }
    return textReply(guests.map((g) => `- ${g.name} (${g.rsvpStatus})`).join('\n'));
  }

  private buildFilteredGuestsReply(
    status: RsvpFilterStatus,
    guests: Array<{ name: string }>,
  ): WhatsappReply {
    const label = RSVP_LABELS[status];
    if (guests.length === 0) {
      return textReply(`${label}: no hay invitados en este estado.`);
    }
    return textReply([`${label}:`, ...guests.map((g) => `- ${g.name}`)].join('\n'));
  }

  private buildSummaryReply(
    guests: Array<{ rsvpStatus: string; tickets: number }>,
  ): WhatsappReply {
    const totals = guests.reduce(
      (acc, g) => {
        acc.total += 1;
        acc.tickets += g.tickets ?? 0;
        if (g.rsvpStatus === 'ACCEPTED') acc.accepted += 1;
        else if (g.rsvpStatus === 'PENDING') acc.pending += 1;
        else if (g.rsvpStatus === 'DECLINED') acc.declined += 1;
        return acc;
      },
      { total: 0, accepted: 0, pending: 0, declined: 0, tickets: 0 },
    );

    return textReply(
      [
        'Resumen:',
        `Total invitados: ${totals.total}`,
        `Confirmados: ${totals.accepted}`,
        `Pendientes: ${totals.pending}`,
        `Rechazados: ${totals.declined}`,
        `Tickets totales: ${totals.tickets}`,
      ].join('\n'),
    );
  }

  private extractMessage(payload: WhatsappWebhookPayload): WhatsappMessage | undefined {
    return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  }

  /**
   * Handles a matched guest RSVP button tap. The write is scoped by
   * `guestId` alone — the id was only ever sent to that guest's number, the
   * same trust model the existing public `POST /invitae/confirm` already
   * uses. Last-write-wins: a guest tap overwrites ANY current `rsvpStatus`,
   * including a non-PENDING one set by an organizer, with no precedence
   * check (`sdd/guest-whatsapp-notify/spec` — Superseded Decision).
   */
  private async handleGuestRsvpTap(match: GuestRsvpMatch): Promise<WhatsappReply> {
    const guest = await this.guestsService.findByIdUnscoped(match.guestId);
    if (!guest) {
      // Deliberately neutral: never discloses whether the guestId ever
      // existed (stale button on a deleted guest/event).
      return textReply('Esta invitacion ya no esta disponible.');
    }

    await this.guestsService.update(guest.eventId, guest.id, {
      rsvpStatus: match.status as RsvpStatus,
    });

    return textReply(
      match.status === 'ACCEPTED'
        ? 'Gracias, confirmamos tu asistencia.'
        : 'Gracias por avisarnos, lamentamos que no puedas asistir.',
    );
  }
}
