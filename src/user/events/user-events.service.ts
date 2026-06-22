import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { eventUsers, events, guests, Event, NewEvent } from '../../database/schema';
import { UpdateEventDto } from '../../admin/events/dto/update-event.dto';

@Injectable()
export class UserEventsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async findOne(eventId: string, userId: string): Promise<Event> {
    const [event] = await this.databaseService.db
      .select({
        id: events.id,
        userId: events.userId,
        name: events.name,
        slug: events.slug,
        date: events.date,
        eventType: events.eventType,
        location: events.location,
        createdAt: events.createdAt,
      })
      .from(events)
      .innerJoin(eventUsers, eq(eventUsers.eventId, events.id))
      .where(and(eq(events.id, eventId), eq(eventUsers.userId, userId)));

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    return event;
  }

  async getStats(eventId: string): Promise<{
    total: number;
    confirmed: number;
    notConfirmed: number;
    accepted: number;
    notAccepted: number;
  }> {
    const [row] = await this.databaseService.db
      .select({
        total: count(),
        accepted: sql<number>`count(*) filter (where ${guests.rsvpStatus} = 'ACCEPTED')`,
        declined: sql<number>`count(*) filter (where ${guests.rsvpStatus} = 'DECLINED')`,
        pending: sql<number>`count(*) filter (where ${guests.rsvpStatus} = 'PENDING')`,
      })
      .from(guests)
      .where(eq(guests.eventId, eventId));

    const total = Number(row?.total ?? 0);
    const accepted = Number(row?.accepted ?? 0);
    const declined = Number(row?.declined ?? 0);
    const pending = Number(row?.pending ?? 0);

    return {
      total,
      confirmed: accepted + declined,
      notConfirmed: pending,
      accepted,
      notAccepted: declined,
    };
  }

  findByUser(userId: string): Promise<Event[]> {
    return this.databaseService.db
      .select({
        id: events.id,
        userId: events.userId,
        name: events.name,
        slug: events.slug,
        date: events.date,
        eventType: events.eventType,
        location: events.location,
        createdAt: events.createdAt,
      })
      .from(events)
      .innerJoin(eventUsers, eq(eventUsers.eventId, events.id))
      .where(eq(eventUsers.userId, userId));
  }

  async update(eventId: string, userId: string, dto: UpdateEventDto): Promise<Event> {
    const [membership] = await this.databaseService.db
      .select()
      .from(eventUsers)
      .where(and(eq(eventUsers.eventId, eventId), eq(eventUsers.userId, userId)));

    if (!membership) {
      throw new ForbiddenException('You are not a member of this event');
    }

    const updateValues: Partial<NewEvent> = {};
    if (dto.name !== undefined) updateValues.name = dto.name;
    if (dto.slug !== undefined) updateValues.slug = dto.slug;
    if (dto.date !== undefined) updateValues.date = new Date(dto.date);
    if (dto.eventType !== undefined) updateValues.eventType = dto.eventType;
    if (dto.location !== undefined) updateValues.location = dto.location;

    const [event] = await this.databaseService.db
      .update(events)
      .set(updateValues)
      .where(eq(events.id, eventId))
      .returning();

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    return event;
  }
}
