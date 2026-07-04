import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { guests, Guest, NewGuest, guestPhones } from '../../database/schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

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
