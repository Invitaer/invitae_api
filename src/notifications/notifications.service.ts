import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { buildGuestFilter } from '../admin/guests/guest-filter';
import { DatabaseService } from '../database/database.service';
import { Guest, RsvpStatus, events, guestPhones, guests, users } from '../database/schema';
import {
  DEFAULT_INVITE_MESSAGE,
  GUEST_INVITE_TEMPLATE_LANG,
  GUEST_INVITE_TEMPLATE_NAME,
} from '../whatsapp/guest-invite-template.const';
import { normalizeWhatsappRecipient } from '../whatsapp/phone.util';
import { SendFailureReason, SendOutcome, WhatsappClient } from '../whatsapp/whatsapp.client';

/** A recipient guest plus every extra number registered in `guest_phones`. */
type GuestWithPhones = Guest & { additionalPhones: string[] };

export interface RecipientOutcome {
  id: string;
  name: string;
  phone: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: SendFailureReason;
  graphCode?: number;
}

/**
 * Result of a notification dispatch.
 *
 * `delivery` is always `'live'`: every entry point (`notifySelected`,
 * `notifyAll`, `notifyPending`) attempts a real WhatsApp send per recipient.
 * The field is kept — rather than dropped — because dashboard clients read
 * it, and the earlier `'mock'` value is simply never produced anymore.
 */
export interface NotificationResult {
  delivery: 'live';
  notifiedCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  recipients: RecipientOutcome[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly whatsappClient: WhatsappClient,
  ) {}

  /**
   * Notify a specific set of guests, scoped to the event. Sends a REAL
   * WhatsApp interactive-button message per recipient (`delivery: 'live'`).
   */
  async notifySelected(eventId: string, guestIds: string[]): Promise<NotificationResult> {
    if (guestIds.length === 0) return this.emptyResult();

    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, guestIds)));

    return this.dispatchLive(eventId, await this.hydratePhones(recipients));
  }

  /**
   * Notify every guest of the event, regardless of RSVP status. When
   * `search` is provided, only guests matching it (via the SAME filter used
   * by `GuestsService.findAllPaginated`/`findMatchingIds`) are notified. An
   * omitted `search` preserves the original "notify everyone" behavior.
   * Sends for real, exactly like `notifySelected` (`delivery: 'live'`).
   */
  async notifyAll(eventId: string, search?: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(buildGuestFilter(eventId, search));

    return this.dispatchLive(eventId, await this.hydratePhones(recipients));
  }

  /**
   * Notify only guests whose RSVP status is still PENDING. Always applies
   * the PENDING restriction; `search` (via the SAME shared filter builder)
   * additionally narrows the recipients. Sends for real, exactly like
   * `notifySelected` (`delivery: 'live'`).
   */
  async notifyPending(eventId: string, search?: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(
        and(
          buildGuestFilter(eventId, search),
          eq(guests.rsvpStatus, RsvpStatus.PENDING),
        ),
      );

    return this.dispatchLive(eventId, await this.hydratePhones(recipients));
  }

  /**
   * Attaches every number registered in `guest_phones` to its guest. Skips
   * the query entirely for an empty recipient set so a filter that matches
   * nobody costs exactly one round trip.
   */
  private async hydratePhones(recipients: Guest[]): Promise<GuestWithPhones[]> {
    if (recipients.length === 0) return [];

    const phoneRows = await this.databaseService.db
      .select()
      .from(guestPhones)
      .where(inArray(guestPhones.guestId, recipients.map((g) => g.id)));

    const additionalByGuestId = phoneRows.reduce<Record<string, string[]>>((acc, row) => {
      (acc[row.guestId] ??= []).push(row.phone);
      return acc;
    }, {});

    return recipients.map((g) => ({
      ...g,
      additionalPhones: additionalByGuestId[g.id] ?? [],
    }));
  }

  /**
   * Sends a real interactive-button WhatsApp message per recipient,
   * SEQUENTIALLY (not in parallel) — a burst raises WABA-wide ecosystem
   * quality signals and `131049` is a per-user throttle anyway, so
   * concurrency buys nothing. One failure never blocks the rest of the
   * batch. See `sdd/guest-whatsapp-notify/design` decision D6.
   */
  private async dispatchLive(
    eventId: string,
    recipients: GuestWithPhones[],
  ): Promise<NotificationResult> {
    if (recipients.length === 0) return this.emptyResult();

    const inviterName = await this.resolveInviterName(eventId);
    const outcomes: RecipientOutcome[] = [];
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const guest of recipients) {
      const body = `Hola ${guest.name}, ${inviterName} te ha invitado a su evento, ¿te gustaría confirmar tu asistencia?`;
      const buttons = [
        { id: `guest_rsvp_yes:${guest.id}`, title: 'Asistiré' },
        { id: `guest_rsvp_no:${guest.id}`, title: 'No podré asistir' },
      ];

      // Fan out to the primary number AND every additional number, deduped by
      // normalized wa_id so a primary==additional guest is never double-sent.
      const targets = this.dedupeRecipientNumbers([guest.phone, ...guest.additionalPhones]);

      if (targets.length === 0) {
        skippedCount += 1;
        outcomes.push({
          id: guest.id,
          name: guest.name,
          phone: guest.phone,
          status: 'skipped',
          reason: SendFailureReason.INVALID_PHONE,
        });
        continue;
      }

      let anySent = false;
      let firstHardFailure: { reason: SendFailureReason; graphCode?: number } | undefined;

      for (const number of targets) {
        const outcome = await this.sendInvitation(number, body, buttons, guest, inviterName);

        if (outcome.ok) {
          anySent = true;
        } else if (outcome.reason !== SendFailureReason.INVALID_PHONE && !firstHardFailure) {
          firstHardFailure = { reason: outcome.reason, graphCode: outcome.graphCode };
        }
      }

      // Aggregate ONE outcome per guest: any success wins, else the first
      // non-INVALID_PHONE failure, else (all attempts invalid) skip.
      if (anySent) {
        sentCount += 1;
        outcomes.push({ id: guest.id, name: guest.name, phone: guest.phone, status: 'sent' });
        await this.flipInvitationSentBestEffort(guest.id);
      } else if (firstHardFailure) {
        failedCount += 1;
        outcomes.push({
          id: guest.id,
          name: guest.name,
          phone: guest.phone,
          status: 'failed',
          reason: firstHardFailure.reason,
          graphCode: firstHardFailure.graphCode,
        });
      } else {
        skippedCount += 1;
        outcomes.push({
          id: guest.id,
          name: guest.name,
          phone: guest.phone,
          status: 'skipped',
          reason: SendFailureReason.INVALID_PHONE,
        });
      }
    }

    return {
      delivery: 'live',
      notifiedCount: recipients.length,
      sentCount,
      failedCount,
      skippedCount,
      recipients: outcomes,
    };
  }

  /**
   * Sends ONE invitation to ONE number: free-form first, approved template
   * ONLY when Graph reports the 24h customer service window is closed
   * (`131047`) — a cold guest who never messaged the bot. Any other failure
   * is returned as-is: `MARKETING_THROTTLED` means "wait", `INVALID_PHONE`
   * means "fix the number", and neither is helped by a template.
   *
   * The template result REPLACES the free-form result, so the caller still
   * sees exactly one outcome per number (and therefore one per guest).
   */
  private async sendInvitation(
    number: string,
    body: string,
    buttons: { id: string; title: string }[],
    guest: GuestWithPhones,
    inviterName: string,
  ): Promise<SendOutcome> {
    const freeForm = await this.whatsappClient.sendWithResult(number, body, buttons);

    if (freeForm.ok || freeForm.reason !== SendFailureReason.WINDOW_CLOSED) {
      return freeForm;
    }

    return this.whatsappClient.sendTemplateWithResult(
      number,
      GUEST_INVITE_TEMPLATE_NAME,
      GUEST_INVITE_TEMPLATE_LANG,
      [guest.name, inviterName, DEFAULT_INVITE_MESSAGE],
      [`guest_rsvp_yes:${guest.id}`, `guest_rsvp_no:${guest.id}`],
    );
  }

  /**
   * Drops empty/whitespace numbers and deduplicates the rest by their
   * normalized wa_id (`normalizeWhatsappRecipient`), keeping the first
   * occurrence's original string. `sendWithResult` normalizes again, so
   * returning the raw value is safe (the normalization is idempotent).
   */
  private dedupeRecipientNumbers(numbers: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of numbers) {
      if (!raw || raw.trim() === '') continue;
      const key = normalizeWhatsappRecipient(raw);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      result.push(raw);
    }

    return result;
  }

  private emptyResult(): NotificationResult {
    return {
      delivery: 'live',
      notifiedCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      recipients: [],
    };
  }

  /**
   * Resolves the inviter's display name ONCE per dispatch call — never per
   * recipient. `events.userId -> users.name`, falling back to `events.name`
   * when the resolved user name is empty/whitespace-only.
   */
  private async resolveInviterName(eventId: string): Promise<string> {
    const [event] = await this.databaseService.db
      .select({ userId: events.userId, name: events.name })
      .from(events)
      .where(eq(events.id, eventId));

    if (!event) return '';

    const [user] = await this.databaseService.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, event.userId));

    const trimmedUserName = user?.name?.trim();
    return trimmedUserName ? trimmedUserName : event.name;
  }

  /** Best-effort, log-and-swallow — a failure here never blocks the response. */
  private async flipInvitationSentBestEffort(guestId: string): Promise<void> {
    try {
      await this.databaseService.db
        .update(guests)
        .set({ invitationSent: true })
        .where(eq(guests.id, guestId));
    } catch (err) {
      this.logger.error(
        `Failed to flip invitationSent for guest ${guestId}: ${(err as Error).message}`,
      );
    }
  }
}
