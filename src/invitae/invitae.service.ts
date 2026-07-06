import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { Guest, guests } from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';

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
  private readonly INV_IDX_PREFIX = 'inv_idx:';

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  async confirmAttendance(dto: ConfirmAttendanceDto): Promise<PublicGuest> {
    const eventId = await this.resolveEventId(dto.slug);

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
    const eventId = await this.resolveEventId(slug);
    return this.loadInvitation(slug, eventId);
  }

  async getGuestInvitation(
    slug: string,
    guestId: string,
  ): Promise<GuestInvitationResponse> {
    const eventId = await this.resolveEventId(slug);
    const invitation = await this.loadInvitation(slug, eventId);
    const guest = await this.findEventGuest(eventId, guestId);
    return { ...invitation, guest: this.toPublicGuest(guest) };
  }

  /** Maps a public slug to its event id via the Redis slug index. */
  private async resolveEventId(slug: string): Promise<string> {
    const eventId = await this.redisService.get(
      `${this.INV_IDX_PREFIX}${slug}`,
    );
    if (!eventId) throw new NotFoundException(`Invitation '${slug}' not found`);
    return eventId;
  }

  private async loadInvitation(
    slug: string,
    eventId: string,
  ): Promise<InvitationDto> {
    const raw = await this.redisService.get(`event:${eventId}:invitation`);
    if (!raw) throw new NotFoundException(`Invitation '${slug}' not found`);
    return JSON.parse(raw) as InvitationDto;
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
