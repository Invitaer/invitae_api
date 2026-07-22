import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { guests, Guest, NewGuest, guestPhones } from '../../database/schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { FindGuestsQueryDto } from './dto/find-guests-query.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { buildGuestFilter } from './guest-filter';

export type GuestWithPhones = Guest & { additionalPhones: string[] };

@Injectable()
export class GuestsService {
  constructor(private readonly databaseService: DatabaseService) {}

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

    return this.databaseService.db.transaction(async (tx) => {
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
  }

  async remove(eventId: string, id: string): Promise<void> {
    const [deleted] = await this.databaseService.db
      .delete(guests)
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)))
      .returning();

    if (!deleted) throw new NotFoundException(`Guest ${id} not found`);
  }
}
