import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { Event, events, Guest, guests } from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';
import { projectInvitation } from './invitation.projection';

/**
 * Public projection of a guest — the only guest fields a non-authenticated
 * invitation page is allowed to see. Never expose phone/email/table PII here.
 */
export interface PublicGuest {
  id: string;
  name: string;
  tickets: number;
  rsvpStatus: Guest['rsvpStatus'];
}

export interface GuestInvitationResponse extends InvitationDto {
  guest: PublicGuest;
}

@Injectable()
export class InvitaeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  async confirmAttendance(dto: ConfirmAttendanceDto): Promise<PublicGuest> {
    const event = await this.findEventBySlug(dto.slug);
    const eventId = event.id;

    // RSVP is a PUBLIC, unauthenticated write, gated on the invitation actually
    // having been published — not merely on the event row existing. An event row
    // is created the moment the admin saves the event; the write path must stay
    // closed until its invitation content exists. Assert BEFORE any mutation.
    if (!(await this.readStoredInvitation(event))) {
      throw new NotFoundException(`Invitation '${dto.slug}' not found`);
    }

    // Scope the write by (guestId AND eventId): a guest can only be confirmed
    // through the invitation of the event they actually belong to. A mismatch
    // returns no row → 404, without revealing whether the guest exists elsewhere.
    const [guest] = await this.databaseService.db
      .update(guests)
      .set({
        rsvpStatus: dto.attending ? 'ACCEPTED' : 'DECLINED',
        updatedAt: new Date(),
      })
      .where(and(eq(guests.id, dto.guestId), eq(guests.eventId, eventId)))
      .returning();

    if (!guest) {
      throw new NotFoundException(
        `Guest ${dto.guestId} not found for this invitation`,
      );
    }
    return this.toPublicGuest(guest);
  }

  async getInvitation(slug: string): Promise<InvitationDto> {
    const event = await this.findEventBySlug(slug);
    return this.loadInvitation(event);
  }

  async getGuestInvitation(
    slug: string,
    guestId: string,
  ): Promise<GuestInvitationResponse> {
    const event = await this.findEventBySlug(slug);
    const invitation = await this.loadInvitation(event);
    const guest = await this.findEventGuest(event.id, guestId);
    return { ...invitation, guest: this.toPublicGuest(guest) };
  }

  /**
   * Resolves a public slug to its event row. `events.slug` is unique at the DB
   * level, so the row is the single source of truth for who owns a public URL —
   * no separate Redis index to go stale or be claimed by another event.
   */
  private async findEventBySlug(slug: string): Promise<Event> {
    const [event] = await this.databaseService.db
      .select()
      .from(events)
      .where(eq(events.slug, slug));

    if (!event) throw new NotFoundException(`Invitation '${slug}' not found`);
    return event;
  }

  /**
   * Loads the stored presentation content and projects the event row over it, so
   * the served payload can never disagree with the DB about identity, names,
   * date or type.
   */
  /**
   * Single definition of the stored-content key. Returns the raw JSON string, or
   * null when the invitation was never published.
   */
  private async readStoredInvitation(event: Event): Promise<string | null> {
    return this.redisService.get(`event:${event.id}:invitation`);
  }

  private async loadInvitation(event: Event): Promise<InvitationDto> {
    const raw = await this.readStoredInvitation(event);
    if (!raw) {
      throw new NotFoundException(`Invitation '${event.slug}' not found`);
    }
    return projectInvitation(JSON.parse(raw) as InvitationDto, event);
  }

  /** Loads a guest scoped to the event; 404 if it belongs to another event. */
  private async findEventGuest(
    eventId: string,
    guestId: string,
  ): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.id, guestId), eq(guests.eventId, eventId)));

    if (!guest) {
      throw new NotFoundException(
        `Guest ${guestId} not found for this invitation`,
      );
    }
    return guest;
  }

  private toPublicGuest(guest: Guest): PublicGuest {
    return {
      id: guest.id,
      name: guest.name,
      tickets: guest.tickets,
      rsvpStatus: guest.rsvpStatus,
    };
  }
}
