import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { guests, Guest, RsvpStatus, events, users } from '../database/schema';
import { buildGuestFilter } from '../admin/guests/guest-filter';
import { WhatsappClient, SendFailureReason } from '../whatsapp/whatsapp.client';

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
 * `delivery: 'live'` means a real WhatsApp send was attempted per recipient
 * (`notifySelected`). `delivery: 'mock'` means real delivery is NOT yet
 * implemented for this call (`notifyAll` / `notifyPending` — see
 * `sdd/guest-whatsapp-notify/design` decision D6 and the spec's Out of
 * Scope section); `notifiedCount`/`recipients` still resolve real data,
 * only the actual send is stubbed.
 */
export interface NotificationResult {
  delivery: 'live' | 'mock';
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
    if (guestIds.length === 0) return this.emptyResult('live');

    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, guestIds)));

    return this.dispatchLive(eventId, recipients);
  }

  /**
   * Notify every guest of the event, regardless of RSVP status. When
   * `search` is provided, only guests matching it (via the SAME filter used
   * by `GuestsService.findAllPaginated`/`findMatchingIds`) are notified. An
   * omitted `search` preserves the original "notify everyone" behavior.
   * Real delivery is out of scope for this slice — see `NotificationResult`.
   */
  async notifyAll(eventId: string, search?: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(buildGuestFilter(eventId, search));

    return this.dispatchMock(recipients);
  }

  /**
   * Notify only guests whose RSVP status is still PENDING. Always applies
   * the PENDING restriction; `search` (via the SAME shared filter builder)
   * additionally narrows the recipients. Real delivery is out of scope for
   * this slice — see `NotificationResult`.
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

    return this.dispatchMock(recipients);
  }

  /**
   * Sends a real interactive-button WhatsApp message per recipient,
   * SEQUENTIALLY (not in parallel) — a burst raises WABA-wide ecosystem
   * quality signals and `131049` is a per-user throttle anyway, so
   * concurrency buys nothing. One failure never blocks the rest of the
   * batch. See `sdd/guest-whatsapp-notify/design` decision D6.
   */
  private async dispatchLive(eventId: string, recipients: Guest[]): Promise<NotificationResult> {
    if (recipients.length === 0) return this.emptyResult('live');

    const inviterName = await this.resolveInviterName(eventId);
    const outcomes: RecipientOutcome[] = [];
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const guest of recipients) {
      const outcome = await this.whatsappClient.sendWithResult(
        guest.phone,
        `Hola ${guest.name}, ${inviterName} te ha invitado a su evento, ¿quieres confirmar tu asistencia?`,
        [
          { id: `guest_rsvp_yes:${guest.id}`, title: 'Asistiré' },
          { id: `guest_rsvp_no:${guest.id}`, title: 'No podré asistir' },
        ],
      );

      if (outcome.ok) {
        sentCount += 1;
        outcomes.push({ id: guest.id, name: guest.name, phone: guest.phone, status: 'sent' });
        await this.flipInvitationSentBestEffort(guest.id);
      } else if (outcome.reason === SendFailureReason.INVALID_PHONE) {
        // Local pre-send validation failure — never blocks the batch.
        skippedCount += 1;
        outcomes.push({
          id: guest.id,
          name: guest.name,
          phone: guest.phone,
          status: 'skipped',
          reason: outcome.reason,
        });
      } else {
        failedCount += 1;
        outcomes.push({
          id: guest.id,
          name: guest.name,
          phone: guest.phone,
          status: 'failed',
          reason: outcome.reason,
          graphCode: outcome.graphCode,
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

  /** notify-all / notify-pending stay mocked in this slice — no send is attempted. */
  private dispatchMock(recipients: Guest[]): NotificationResult {
    return {
      delivery: 'mock',
      notifiedCount: recipients.length,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      recipients: recipients.map((g) => ({
        id: g.id,
        name: g.name,
        phone: g.phone,
        status: 'skipped',
      })),
    };
  }

  private emptyResult(delivery: 'live' | 'mock'): NotificationResult {
    return {
      delivery,
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
