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

    const claimed = await this.redisService.setNX(
      `wa:msg:${message.id}`,
      'processed',
      MESSAGE_ID_TTL_SECONDS,
    );

    if (!claimed) {
      this.logger.log(`Duplicate message_id ${message.id} — skipping reprocessing`);
      return;
    }

    const phoneNumber = message.from;
    const text = message.text?.body?.trim() ?? '';

    if (OTP_CODE_PATTERN.test(text)) {
      const linked = await this.whatsappLinkService.verifyAndLink(text, phoneNumber);
      if (!linked) {
        this.logger.log(`Failed OTP verification attempt from ${phoneNumber}`);
      }
      return;
    }

    const userId = await this.whatsappLinkService.resolvePhone(phoneNumber);
    if (!userId) {
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
    await this.whatsappClient.sendText(phoneNumber, reply);
  }

  private async dispatch(
    intent: BotIntent,
    ctx: ConversationContext,
    phoneNumber: string,
  ): Promise<string> {
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
        return 'Operacion cancelada.';

      case 'START_ADD_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startAddGuestFlow();
          await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: pending });
          return 'Vamos a agregar un invitado. Decime el nombre.';
        });

      case 'START_EDIT_GUEST':
        return this.withCurrentEvent(ctx, async () => {
          const pending = startEditGuestFlow(intent.guestId);
          await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: pending });
          return 'Que campo queres editar? (nombre, telefono, email, tickets)';
        });

      case 'CONFIRM_ACTION':
        return 'No hay ninguna accion pendiente para confirmar.';

      case 'RSVP_CONFIRM':
        return this.withCurrentEvent(ctx, async (eventId) => {
          await this.guestsService.update(eventId, intent.guestId, {
            rsvpStatus: 'ACCEPTED',
          } as UpdateGuestDto);
          return 'RSVP confirmado.';
        });

      case 'RSVP_DECLINE':
        return this.withCurrentEvent(ctx, async (eventId) => {
          await this.guestsService.update(eventId, intent.guestId, {
            rsvpStatus: 'DECLINED',
          } as UpdateGuestDto);
          return 'RSVP marcado como rechazado.';
        });

      case 'UNKNOWN':
      default:
        return 'No entendi ese comando. Envia "menu" para ver las opciones disponibles.';
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
  ): Promise<string> {
    const pending = ctx.pendingAction as PendingAction;
    const result =
      intent.kind === 'CONFIRM_ACTION'
        ? advanceFlow(pending, { type: 'CONFIRM' })
        : advanceFlow(pending, { type: 'INPUT', value: text });

    switch (result.status) {
      case 'CANCELLED':
        await this.conversationStore.clear(phoneNumber);
        return result.message;

      case 'INVALID':
      case 'ADVANCED':
      case 'AWAITING_CONFIRM':
        await this.conversationStore.set(phoneNumber, { ...ctx, pendingAction: result.pending });
        return result.message;

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
  ): Promise<string> {
    return this.withCurrentEvent(ctx, async (eventId) => {
      if (pending.flow === 'AGREGAR') {
        await this.guestsService.create(eventId, {
          name: pending.data.name,
          phone: pending.data.phone,
          tickets: pending.data.tickets,
          email: pending.data.email,
        } as CreateGuestDto);
        await this.conversationStore.clear(phoneNumber);
        return 'Invitado agregado correctamente.';
      }

      await this.guestsService.update(eventId, pending.guestId, {
        [pending.field as string]: pending.value,
      } as UpdateGuestDto);
      await this.conversationStore.clear(phoneNumber);
      return 'Invitado actualizado correctamente.';
    });
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
  ): Promise<string> {
    try {
      const event = await this.userEventsService.findOne(eventId, ctx.userId);
      const nextCtx: ConversationContext = { ...ctx, currentEventId: event.id };
      await this.conversationStore.set(phoneNumber, nextCtx);
      return `Evento seleccionado: ${event.name}`;
    } catch (err) {
      if (err instanceof NotFoundException) {
        return 'No tenes acceso a ese evento.';
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
    action: (eventId: string, event: Event) => Promise<string>,
  ): Promise<string> {
    if (!ctx.currentEventId) {
      return 'No tenes un evento activo. Envia "mis eventos" para elegir uno.';
    }

    let event: Event;
    try {
      event = await this.userEventsService.findOne(ctx.currentEventId, ctx.userId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return 'No tenes acceso a ese evento.';
      }
      throw err;
    }

    return action(ctx.currentEventId, event);
  }

  private buildMenuReply(): string {
    return [
      'Menu principal:',
      '- mis eventos',
      '- detalle',
      '- buscar <nombre>',
      '- filtrar confirmados/pendientes/rechazados',
      '- resumen',
      '- cancelar',
    ].join('\n');
  }

  private buildEventsListReply(events: Pick<Event, 'id' | 'name'>[]): string {
    if (events.length === 0) {
      return 'No tenes eventos asociados todavia.';
    }
    return ['Tus eventos:', ...events.map((e) => `- ${e.name}`)].join('\n');
  }

  private buildEventDetailReply(event: Event): string {
    return [
      `Evento: ${event.name}`,
      `Fecha: ${event.date}`,
      `Lugar: ${event.location ?? 'sin especificar'}`,
    ].join('\n');
  }

  private buildGuestListReply(guests: Array<{ name: string; rsvpStatus: string }>): string {
    if (guests.length === 0) {
      return 'No se encontraron invitados que coincidan.';
    }
    return guests.map((g) => `- ${g.name} (${g.rsvpStatus})`).join('\n');
  }

  private buildFilteredGuestsReply(
    status: RsvpFilterStatus,
    guests: Array<{ name: string }>,
  ): string {
    const label = RSVP_LABELS[status];
    if (guests.length === 0) {
      return `${label}: no hay invitados en este estado.`;
    }
    return [`${label}:`, ...guests.map((g) => `- ${g.name}`)].join('\n');
  }

  private buildSummaryReply(
    guests: Array<{ rsvpStatus: string; tickets: number }>,
  ): string {
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

    return [
      'Resumen:',
      `Total invitados: ${totals.total}`,
      `Confirmados: ${totals.accepted}`,
      `Pendientes: ${totals.pending}`,
      `Rechazados: ${totals.declined}`,
      `Tickets totales: ${totals.tickets}`,
    ].join('\n');
  }

  private extractMessage(payload: WhatsappWebhookPayload): WhatsappMessage | undefined {
    return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  }
}
