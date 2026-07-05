import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { GuestsService } from '../../admin/guests/guests.service';
import { CreateGuestDto } from '../../admin/guests/dto/create-guest.dto';
import { UpdateGuestDto } from '../../admin/guests/dto/update-guest.dto';
import {
  NotificationResult,
  NotificationsService,
} from '../../notifications/notifications.service';
import { Guest } from '../../database/schema';
import { NotifyGuestsDto } from './dto/notify-guests.dto';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

@Controller('user/events/:id/guests')
@Auth()
export class UserGuestsController {
  constructor(
    private readonly guestsService: GuestsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  @UseGuards(UserEventMemberGuard)
  findAll(@Param('id') eventId: string): Promise<Guest[]> {
    return this.guestsService.findAll(eventId);
  }

  @Post()
  @UseGuards(UserEventMemberGuard)
  create(
    @Param('id') eventId: string,
    @Body() dto: CreateGuestDto,
  ): Promise<Guest> {
    return this.guestsService.create(eventId, dto);
  }

  // --- Notifications (mock — real delivery pending, see NotificationsService) ---

  @Post('notify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserEventMemberGuard)
  notifySelected(
    @Param('id') eventId: string,
    @Body() dto: NotifyGuestsDto,
  ): Promise<NotificationResult> {
    return this.notificationsService.notifySelected(eventId, dto.guestIds);
  }

  @Post('notify-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserEventMemberGuard)
  notifyAll(@Param('id') eventId: string): Promise<NotificationResult> {
    return this.notificationsService.notifyAll(eventId);
  }

  @Post('notify-pending')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserEventMemberGuard)
  notifyPending(@Param('id') eventId: string): Promise<NotificationResult> {
    return this.notificationsService.notifyPending(eventId);
  }

  @Patch(':guestId')
  @UseGuards(UserEventMemberGuard)
  update(
    @Param('id') eventId: string,
    @Param('guestId') guestId: string,
    @Body() dto: UpdateGuestDto,
  ): Promise<Guest> {
    return this.guestsService.update(eventId, guestId, dto);
  }

  @Delete(':guestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(UserEventMemberGuard)
  remove(
    @Param('id') eventId: string,
    @Param('guestId') guestId: string,
  ): Promise<void> {
    return this.guestsService.remove(eventId, guestId);
  }
}
