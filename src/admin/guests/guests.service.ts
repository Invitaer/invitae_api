import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { guests, Guest, NewGuest } from '../../database/schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

@Injectable()
export class GuestsService {
  constructor(private readonly databaseService: DatabaseService) {}

  findAll(): Promise<Guest[]> {
    return this.databaseService.db.select().from(guests);
  }

  async findOne(id: string): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .select()
      .from(guests)
      .where(eq(guests.id, id));

    if (!guest) throw new NotFoundException(`Guest ${id} not found`);
    return guest;
  }

  async create(dto: CreateGuestDto): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .insert(guests)
      .values(dto as NewGuest)
      .returning();
    return guest;
  }

  async update(id: string, dto: UpdateGuestDto): Promise<Guest> {
    const [guest] = await this.databaseService.db
      .update(guests)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(guests.id, id))
      .returning();

    if (!guest) throw new NotFoundException(`Guest ${id} not found`);
    return guest;
  }

  async remove(id: string): Promise<void> {
    await this.databaseService.db.delete(guests).where(eq(guests.id, id));
  }
}
