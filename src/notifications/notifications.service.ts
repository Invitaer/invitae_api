import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { guests, Guest, RsvpStatus } from '../database/schema';

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

  /** Notify every guest of the event, regardless of RSVP status. */
  async notifyAll(eventId: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(eq(guests.eventId, eventId));

    return this.dispatch(recipients);
  }

  /** Notify only guests whose RSVP status is still PENDING. */
  async notifyPending(eventId: string): Promise<NotificationResult> {
    const recipients = await this.databaseService.db
      .select()
      .from(guests)
      .where(
        and(
          eq(guests.eventId, eventId),
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
