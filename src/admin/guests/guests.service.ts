import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { guests, Guest, NewGuest } from '../../database/schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

@Injectable()
export class GuestsService {
  constructor(private readonly databaseService: DatabaseService) {}

  findAll(eventId: string): Promise<Guest[]> {
    return this.databaseService.db
      .select()
      .from(guests)
      .where(eq(guests.eventId, eventId));
  }

  async findOne(eventId: string, id: string): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)));

    if (!guest) throw new NotFoundException(`Guest ${id} not found`);
    return guest;
  }

  async create(eventId: string, dto: CreateGuestDto): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .insert(guests)
      .values({ ...dto, eventId } as NewGuest)
      .returning();
    return guest;
  }

  async update(
    eventId: string,
    id: string,
    dto: UpdateGuestDto,
  ): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .update(guests)
      .set({ ...dto, updatedAt: new Date() })
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)))
      .returning();

    if (!guest) throw new NotFoundException(`Guest ${id} not found`);
    return guest;
  }

  async remove(eventId: string, id: string): Promise<void> {
    const [deleted] = await this.databaseService.db
      .delete(guests)
      .where(and(eq(guests.eventId, eventId), eq(guests.id, id)))
      .returning();

    if (!deleted) throw new NotFoundException(`Guest ${id} not found`);
  }
}
