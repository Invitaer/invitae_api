import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore, ConversationContext } from './conversation.store';
import { WhatsappClient } from './whatsapp.client';
import { UserEventsService } from '../user/events/user-events.service';
import { GuestsService } from '../admin/guests/guests.service';
import { parseCommand } from './command.parser';
import { BotIntent, RsvpFilterStatus } from './bot-intent';
import { Event } from '../database/schema';
import {
  advanceFlow,
  startAddGuestFlow,
  startEditGuestFlow,
  PendingAction,
} from './flow.machine';
import { CreateGuestDto } from '../admin/guests/dto/create-guest.dto';
import { UpdateGuestDto } from '../admin/guests/dto/update-guest.dto';
import { WhatsappReply, textReply, buttonsReply, listReply } from './whatsapp-reply';

export interface WhatsappWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id: string;
          from: string;
          text?: { body: string };
          interactive?: {
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string };
          };
        }>;
      };
    }>;
  }>;
}

interface WhatsappMessage {
  id: string;
  from: string;
  text?: { body: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}

const MESSAGE_ID_TTL_SECONDS = 86400; // 24h — enough to cover Meta's retry window
const USER_LOCK_TTL_SECONDS = 15; // safety cap so a crashed handler can't wedge a user forever
const USER_LOCK_MAX_ATTEMPTS = 5; // bounded wait so we NEVER drop a message on contention
const USER_LOCK_BACKOFF_MS = 150; // delay between lock acquisition attempts
const MAX_LIST_ROWS = 10; // WhatsApp interactive lists allow at most 10 rows
const MAX_LIST_ROW_TITLE = 24; // WhatsApp interactive-list row titles are capped at 24 chars
const OTP_CODE_PATTERN = /^\d{6}$/;

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
          return;
        }
        this.logger.log(`Unlinked phone ${phoneNumber} — replying with linking instructions`);
        return;
      }

      const stored = await this.conversationStore.get(phoneNumber);
      const ctx: ConversationContext = stored ?? { userId };

      const interactiveId =
        message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
      const intent = parseCommand({ text, interactiveId });

      // While a write-flow is active, every message is fed into the flow
      // machine UNLESS it is an explicit CANCEL (always escapes, handled by
      // `dispatch`'s CANCEL case) or a recognized command that isn't raw
      // step-input/confirmation (e.g. "menu"), which is allowed to bypass the
      // flow and dispatch normally.
      const consumedByFlow =
        !!ctx.pendingAction && (intent.kind === 'UNKNOWN' || intent.kind === 'CONFIRM_ACTION');

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
        await this.conversationStore.clear(phoneNumber);
        return textReply('Operacion cancelada.');

      case 'START_ADD_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startAddGuestFlow();
          await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: pending });
          return textReply('Vamos a agregar un invitado. Decime el nombre.');
        });

      case 'START_EDIT_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startEditGuestFlow(intent.guestId);
          await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: pending });
          return textReply('Que campo queres editar? (nombre, telefono, email, tickets)');
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
    const result =
      intent.kind === 'CONFIRM_ACTION'
        ? advanceFlow(pending, { type: 'CONFIRM' })
        : advanceFlow(pending, { type: 'INPUT', value: text });

    switch (result.status) {
      case 'CANCELLED':
        await this.conversationStore.clear(phoneNumber);
        return textReply(result.message);

      case 'INVALID':
      case 'ADVANCED':
        await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: result.pending });
        return textReply(result.message);

      case 'AWAITING_CONFIRM':
        // The flow just reached its CONFIRM step (all data collected). The
        // Destructive Action Confirmation requirement needs a REAL button
        // for the organizer to tap — the ids below MUST match what
        // `command.parser` recognizes ('confirm' -> CONFIRM_ACTION,
        // 'cancel' -> CANCEL), otherwise this button would be untappable.
        await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: result.pending });
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
        await this.clearConversationBestEffort(phoneNumber);
        return textReply(
          'No pude guardar los cambios por un error. Volve a intentarlo en unos minutos.',
        );
      }

      // Write succeeded. A failure clearing the conversation here is logged and
      // swallowed — never reported as a write failure.
      await this.clearConversationBestEffort(phoneNumber);
      return textReply(
        pending.flow === 'AGREGAR'
          ? 'Invitado agregado correctamente.'
          : 'Invitado actualizado correctamente.',
      );
    });
  }

  /**
   * Clears the conversation context, swallowing (and logging) any error. Used
   * after a guest write so a Redis hiccup while clearing never masquerades as a
   * write failure — the write already succeeded and must be reported as such.
   */
  private async clearConversationBestEffort(phoneNumber: string): Promise<void> {
    try {
      await this.conversationStore.clear(phoneNumber);
    } catch (err) {
      this.logger.error(
        `Failed to clear conversation for ${phoneNumber} after guest write`,
        err instanceof Error ? err.stack : String(err),
      );
    }
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
      const nextCtx: ConversationContext = { ...ctx, currentEventId: event.id };
      await this.conversationStore.set(phoneNumber, nextCtx);
      return textReply(`Evento seleccionado: ${event.name}`);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return textReply('No tenes acceso a ese evento.');
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
  private async withCurrentEvent(
    ctx: ConversationContext,
    action: (eventId: string, event: Event) => Promise<WhatsappReply>,
  ): Promise<WhatsappReply> {
    if (!ctx.currentEventId) {
      return textReply('No tenes un evento activo. Envia "mis eventos" para elegir uno.');
    }

    let event: Event;
    try {
      event = await this.userEventsService.findOne(ctx.currentEventId, ctx.userId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return textReply('No tenes acceso a ese evento.');
      }
      throw err;
    }

    return action(ctx.currentEventId, event);
  }

  private buildMenuReply(): WhatsappReply {
    return textReply(
      [
        'Menu principal:',
        '- mis eventos',
        '- detalle',
        '- buscar <nombre>',
        '- filtrar confirmados/pendientes/rechazados',
        '- resumen',
        '- cancelar',
      ].join('\n'),
    );
  }

  /**
   * "mis eventos" is what makes `SELECT_EVENT` reachable at all: it is the
   * ONLY place the `select_event:{id}` row id is ever produced. The id sent
   * here MUST match `SELECT_EVENT_PATTERN` in `command.parser.ts`.
   */
  private buildEventsListReply(events: Pick<Event, 'id' | 'name'>[]): WhatsappReply {
    if (events.length === 0) {
      return textReply('No tenes eventos asociados todavia.');
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
}
