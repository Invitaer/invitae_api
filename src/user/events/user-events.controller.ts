import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UpdateEventDto } from '../../admin/events/dto/update-event.dto';
import { Event } from '../../database/schema';
import { UserEventsService } from './user-events.service';

@Controller('user/events')
@Auth()
export class UserEventsController {
  constructor(private readonly userEventsService: UserEventsService) {}

  @Get()
  findByUser(@CurrentUser() user: AuthUser): Promise<Event[]> {
    return this.userEventsService.findByUser(user.id);
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
