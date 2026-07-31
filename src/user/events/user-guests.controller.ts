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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { GuestsService, GuestWithPhones } from '../../admin/guests/guests.service';
import { CreateGuestDto } from '../../admin/guests/dto/create-guest.dto';
import { FindGuestsQueryDto } from '../../admin/guests/dto/find-guests-query.dto';
import { UpdateGuestDto } from '../../admin/guests/dto/update-guest.dto';
import {
  NotificationResult,
  NotificationsService,
} from '../../notifications/notifications.service';
import { Guest } from '../../database/schema';
import { NotifyFilterDto } from './dto/notify-filter.dto';
import { NotifyGuestsDto } from './dto/notify-guests.dto';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

@Controller('user/events/:id/guests')
@Auth('user')
export class UserGuestsController {
  constructor(
    private readonly guestsService: GuestsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  @UseGuards(UserEventMemberGuard)
  findAll(
    @Param('id') eventId: string,
    @Query() query: FindGuestsQueryDto,
  ): Promise<{ data: GuestWithPhones[]; total: number }> {
    return this.guestsService.findAllPaginated(eventId, query);
  }

  @Get('ids')
  @UseGuards(UserEventMemberGuard)
  findMatchingIds(
    @Param('id') eventId: string,
    @Query('search') search?: string,
  ): Promise<string[]> {
    return this.guestsService.findMatchingIds(eventId, search);
  }

  @Post()
  @UseGuards(UserEventMemberGuard)
  create(
    @Param('id') eventId: string,
    @Body() dto: CreateGuestDto,
  ): Promise<Guest> {
    return this.guestsService.create(eventId, dto);
  }

  // --- Notifications (real WhatsApp delivery, see NotificationsService) ---

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
  notifyAll(
    @Param('id') eventId: string,
    @Body() dto: NotifyFilterDto,
  ): Promise<NotificationResult> {
    return this.notificationsService.notifyAll(eventId, dto.search);
  }

  @Post('notify-pending')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserEventMemberGuard)
  notifyPending(
    @Param('id') eventId: string,
    @Body() dto: NotifyFilterDto,
  ): Promise<NotificationResult> {
    return this.notificationsService.notifyPending(eventId, dto.search);
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
