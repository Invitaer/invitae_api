import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { guests, Guest, NewGuest, guestPhones } from '../../database/schema';
import { GuestEventsService } from '../../realtime/guest-events.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { FindGuestsQueryDto } from './dto/find-guests-query.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { buildGuestFilter } from './guest-filter';

export type GuestWithPhones = Guest & { additionalPhones: string[] };

@Injectable()
export class GuestsService {
  private readonly logger = new Logger(GuestsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly guestEvents: GuestEventsService,
  ) {}

  async findAll(eventId: string): Promise<GuestWithPhones[]> {
    const guestList = await this.databaseService.db
      .select()
      .from(guests)
      .where(eq(guests.eventId, eventId));

    if (guestList.length === 0) {
      return [];
    }

    const guestIds = guestList.map((g) => g.id);
    const phoneRows = await this.databaseService.db
      .select()
      .from(guestPhones)
      .where(inArray(guestPhones.guestId, guestIds));

    const phonesByGuestId = phoneRows.reduce<Record<string, string[]>>(
      (acc, row) => {
        if (!acc[row.guestId]) acc[row.guestId] = [];
        acc[row.guestId].push(row.phone);
        return acc;
      },
      {},
    );

    return guestList.map((g) => ({
      ...g,
      additionalPhones: phonesByGuestId[g.id] ?? [],
    }));
  }

  /**
   * Paginated + search-filtered listing for the user-facing guests endpoint.
   * NOTE: `findAll` above is untouched and stays reserved for the admin path.
   */
  async findAllPaginated(
    eventId: string,
    query: FindGuestsQueryDto,
  ): Promise<{ data: GuestWithPhones[]; total: number }> {
    const { search, page = 1, limit = 10 } = query;
    const offset = (page - 1) * limit;
    const filter = buildGuestFilter(eventId, search);
    const db = this.databaseService.db;

    const guestList: Guest[] = await db
      .select()
      .from(guests)
      .where(filter)
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(guests)
      .where(filter);

    if (guestList.length === 0) {
      return { data: [], total: count };
    }

    const guestIds = guestList.map((g) => g.id);
    const phoneRows = await db
      .select()
      .from(guestPhones)
      .where(inArray(guestPhones.guestId, guestIds));

    const phonesByGuestId = phoneRows.reduce<Record<string, string[]>>(
      (acc, row) => {
        if (!acc[row.guestId]) acc[row.guestId] = [];
        acc[row.guestId].push(row.phone);
        return acc;
      },
      {},
    );

    const data: GuestWithPhones[] = guestList.map((g) => ({
      ...g,
      additionalPhones: phonesByGuestId[g.id] ?? [],
    }));

    return { data, total: count };
  }

  /**
   * All guest ids matching the filter, unpaginated. Reuses the SAME filter
   * builder as `findAllPaginated` so filter-aware select-all never drifts
   * from what pagination shows.
   */
  async findMatchingIds(eventId: string, search?: string): Promise<string[]> {
    const filter = buildGuestFilter(eventId, search);
    const rows = await this.databaseService.db
      .select({ id: guests.id })
      .from(guests)
      .where(filter);

    return rows.map((r) => r.id);
  }

  /**
   * Looks up a guest by id ALONE, with no event scoping. Used by the guest
   * WhatsApp RSVP inbound guard (`WhatsappService.handleGuestRsvpTap`),
   * which authenticates the write via the unguessable guestId embedded in
   * the button id rather than through admin/user event membership — the
   * eventId is not yet known at that point in the pipeline (it runs BEFORE
   * `resolvePhone`). See `sdd/guest-whatsapp-notify/design` decision D4.
   */
  async findByIdUnscoped(id: string): Promise<Guest | undefined> {
    const [guest] = await this.databaseService.db
      .select()
      .from(guests)
      .where(eq(guests.id, id));

    return guest;
  }

  async findOne(eventId: string, id: string): Promise<GuestWithPhones> {
    const [guest] = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)));

    if (!guest) throw new NotFoundException(`Guest ${id} not found`);

    const phoneRows = await this.databaseService.db
      .select()
      .from(guestPhones)
      .where(eq(guestPhones.guestId, id));

    return {
      ...guest,
      additionalPhones: phoneRows.map((p) => p.phone),
    };
  }

  async create(
    eventId: string,
    dto: CreateGuestDto,
  ): Promise<GuestWithPhones> {
    const { additionalPhones, ...guestData } = dto;

    return this.databaseService.db.transaction(async (tx) => {
      const [guest] = await tx
        .insert(guests)
        .values({ ...guestData, eventId } as NewGuest)
        .returning();

      if (additionalPhones?.length) {
        await tx
          .insert(guestPhones)
          .values(
            additionalPhones.map((phone) => ({ guestId: guest.id, phone })),
          )
          .returning();
      }

      return { ...guest, additionalPhones: additionalPhones ?? [] };
    });
  }

  async update(
    eventId: string,
    id: string,
    dto: UpdateGuestDto,
  ): Promise<GuestWithPhones> {
    const { additionalPhones, ...guestData } = dto;

    const updated = await this.databaseService.db.transaction(async (tx) => {
      const [guest] = await tx
        .update(guests)
        .set({ ...guestData, updatedAt: new Date() })
        .where(and(eq(guests.eventId, eventId), eq(guests.id, id)))
        .returning();

      if (!guest) throw new NotFoundException(`Guest ${id} not found`);

      if (additionalPhones !== undefined) {
        // Replace all existing phones with the new list
        await tx
          .delete(guestPhones)
          .where(eq(guestPhones.guestId, id));

        if (additionalPhones.length > 0) {
          await tx
            .insert(guestPhones)
            .values(additionalPhones.map((phone) => ({ guestId: id, phone })))
            .returning();
        }

        return { ...guest, additionalPhones };
      }

      // additionalPhones not provided — fetch existing phones
      const existingPhoneRows = await tx
        .select()
        .from(guestPhones)
        .where(eq(guestPhones.guestId, id));

      return {
        ...guest,
        additionalPhones: existingPhoneRows.map((p) => p.phone),
      };
    });

    // Only an RSVP change belongs on the stream: this same method also renames
    // guests and edits tickets, and a frame for those would be noise on every
    // connected organizer.
    if (dto.rsvpStatus !== undefined) {
      await this.broadcastRsvp(eventId, updated);
    }

    return updated;
  }

  /**
   * Announces an RSVP change made from a dashboard.
   *
   * Until this existed, `InvitaeService.confirm` — the PUBLIC rsvp link — was
   * the only publisher, so an organizer editing an RSVP left every other
   * organizer watching the same event with a stale list until they reloaded.
   *
   * Called only AFTER the transaction commits: broadcasting from inside it
   * would announce a change that a rollback then silently undoes.
   */
  private async broadcastRsvp(
    eventId: string,
    guest: GuestWithPhones,
  ): Promise<void> {
    try {
      await this.guestEvents.publish({
        eventId,
        guestId: guest.id,
        // The persisted row, never the dto — it is the only proof of what
        // actually landed in the database.
        rsvpStatus: guest.rsvpStatus,
        at: new Date().toISOString(),
      });
    } catch (error) {
      // The write already committed. Surfacing a Redis outage as a failed
      // update would invite a retry of something that actually worked.
      this.logger.error(
        `Guest ${guest.id} updated but RSVP broadcast failed: ${
          (error as Error).message
        }`,
      );
    }
  }

  async remove(eventId: string, id: string): Promise<void> {
    const [deleted] = await this.databaseService.db
      .delete(guests)
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)))
      .returning();

    if (!deleted) throw new NotFoundException(`Guest ${id} not found`);
  }
}
