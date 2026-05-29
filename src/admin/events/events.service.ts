import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { events, Event, NewEvent } from '../../database/schema';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(userId: string, dto: CreateEventDto): Promise<Event> {
    try {
      const [event] = await this.databaseService.db
        .insert(events)
        .values({
          userId,
          name: dto.name,
          slug: dto.slug,
          date: new Date(dto.date),
        } as NewEvent)
        .returning();
      return event;
    } catch (error: any) {
      if (
        error?.code === '23505' ||
        (error?.message as string | undefined)?.includes('unique')
      ) {
        throw new ConflictException('Slug already exists');
      }
      throw error;
    }
  }

  findAll(userId: string): Promise<Event[]> {
    return this.databaseService.db
      .select()
      .from(events)
      .where(eq(events.userId, userId));
  }

  async findOne(id: string): Promise<Event> {
    const [event] = await this.databaseService.db
      .select()
      .from(events)
      .where(eq(events.id, id));

    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateEventDto,
  ): Promise<Event> {
    const updateValues: Partial<NewEvent> = {};
    if (dto.name !== undefined) updateValues.name = dto.name;
    if (dto.slug !== undefined) updateValues.slug = dto.slug;
    if (dto.date !== undefined) updateValues.date = new Date(dto.date);

    const [event] = await this.databaseService.db
      .update(events)
      .set(updateValues)
      .where(and(eq(events.id, id), eq(events.userId, userId)))
      .returning();

    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }

  async remove(id: string, userId: string): Promise<void> {
    const [event] = await this.databaseService.db
      .delete(events)
      .where(and(eq(events.id, id), eq(events.userId, userId)))
      .returning();

    if (!event) throw new NotFoundException(`Event ${id} not found`);
  }
}
