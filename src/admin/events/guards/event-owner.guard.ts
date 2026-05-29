import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventsService } from '../events.service';

@Injectable()
export class EventOwnerGuard implements CanActivate {
  constructor(private readonly eventsService: EventsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest();
    const eventId: string = request.params.eventId;

    // throws NotFoundException (404) if eventId does not exist
    const event = await this.eventsService.findOne(eventId);

    if (event.userId !== request.user.id) {
      throw new ForbiddenException('You do not own this event');
    }

    request.event = event;
    return true;
  }
}
