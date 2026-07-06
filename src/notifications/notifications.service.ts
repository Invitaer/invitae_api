import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { guests, Guest, RsvpStatus } from '../database/schema';
import { buildGuestFilter } from '../admin/guests/guest-filter';

/**
 * Result of a notification dispatch.
 *
 * PENDING: this is a MOCK response. Real delivery (WhatsApp/SMS/Mail — the
 * WHATSAPP_API_URL / SMS_API_URL / MAIL_* secrets already exist but are unused)
 * is NOT implemented yet. The recipient resolution below is real; only the
 * actual sending is stubbed. See the TODO in `dispatch`.
 */
export interface NotificationResult {
  status: 'mock';
  pending: true;
  notifiedCount: number;
  recipients: NotificationRecipient[];
}

export interface NotificationRecipient {
  id: string;
  name: string;
  phone: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Notify a specific set of guests, scoped to the event. */
  async notifySelected(
    eventId: string,
    guestIds: string[],
  ): Promise<NotificationResult> {
    if (guestIds.length === 0) return this.dispatch([]);

    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, guestIds)));

    return this.dispatch(recipients);
  }

  /**
   * Notify every guest of the event, regardless of RSVP status. When
   * `search` is provided, only guests matching it (via the SAME filter used
   * by `GuestsService.findAllPaginated`/`findMatchingIds`) are notified. An
   * omitted `search` preserves the original "notify everyone" behavior.
   */
  async notifyAll(eventId: string, search?: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(buildGuestFilter(eventId, search));

    return this.dispatch(recipients);
  }

  /**
   * Notify only guests whose RSVP status is still PENDING. Always applies
   * the PENDING restriction; `search` (via the SAME shared filter builder)
   * additionally narrows the recipients.
   */
  async notifyPending(
    eventId: string,
    search?: string,
  ): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(
        and(
          buildGuestFilter(eventId, search),
          eq(guests.rsvpStatus, RsvpStatus.PENDING),
        ),
      );

    return this.dispatch(recipients);
  }

  /**
   * TODO(pending): send the actual notification through WhatsApp/SMS/Mail and
   * flip `guests.invitationSent`. For now it resolves the recipients and
   * returns a mock result without contacting any provider.
   */
  private dispatch(recipients: Guest[]): NotificationResult {
    return {
      status: 'mock',
      pending: true,
      notifiedCount: recipients.length,
      recipients: recipients.map((g) => ({
        id: g.id,
        name: g.name,
        phone: g.phone,
      })),
    };
  }
}
