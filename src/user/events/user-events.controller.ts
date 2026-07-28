import {
  Body,
  Controller,
  Get,
  MessageEvent,
  Param,
  Patch,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { interval, merge, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UpdateEventDto } from '../../admin/events/dto/update-event.dto';
import { Event } from '../../database/schema';
import { GuestEventsService } from '../../realtime/guest-events.service';
import { UserEventsService } from './user-events.service';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

/**
 * Nothing flows on this stream between RSVPs, and proxies, load balancers and
 * some corporate networks drop idle connections after ~30-60s. A frame well
 * inside that window keeps the pipe from being culled mid-event.
 */
export const SSE_HEARTBEAT_MS = 25_000;

@Controller('user/events')
@Auth()
export class UserEventsController {
  constructor(
    private readonly userEventsService: UserEventsService,
    private readonly guestEvents: GuestEventsService,
  ) {}

  @Get()
  findByUser(@CurrentUser() user: AuthUser): Promise<Event[]> {
    return this.userEventsService.findByUser(user.id);
  }

  @Get(':id')
  @UseGuards(UserEventMemberGuard)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<Event> {
    return this.userEventsService.findOne(id, user.id);
  }

  @Get(':id/stats')
  @UseGuards(UserEventMemberGuard)
  getStats(@Param('id') id: string) {
    return this.userEventsService.getStats(id);
  }

  /**
   * Live guest RSVP changes for one event.
   *
   * Authenticated by the controller's `@Auth()` plus the membership guard, the
   * same as every other route here — the browser's `EventSource` cannot set an
   * Authorization header, which is why the JWT now travels as an httpOnly
   * cookie the jwt strategy also accepts.
   */
  @Sse(':id/guests/stream')
  @UseGuards(UserEventMemberGuard)
  streamGuests(@Param('id') id: string): Observable<MessageEvent> {
    return merge(
      this.guestEvents.streamFor(id).pipe(
        map((change): MessageEvent => ({ type: 'guest-rsvp', data: change })),
      ),
      interval(SSE_HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: 'heartbeat', data: {} })),
      ),
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateEventDto,
  ): Promise<Event> {
    return this.userEventsService.update(id, user.id, dto);
  }
}
