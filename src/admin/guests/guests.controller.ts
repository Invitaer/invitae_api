import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Guest } from '../../database/schema';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { CurrentEvent } from '../events/decorators/current-event.decorator';
import { EventOwnerGuard } from '../events/guards/event-owner.guard';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { GuestsService } from './guests.service';

@Controller('admin/events/:eventId/guests')
@UseGuards(EventOwnerGuard)
@Auth('admin')
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Get()
  findAll(@CurrentEvent() event: { id: string }): Promise<Guest[]> {
    return this.guestsService.findAll(event.id);
  }

  @Get(':id')
  findOne(
    @CurrentEvent() event: { id: string },
    @Param('id') id: string,
  ): Promise<Guest> {
    return this.guestsService.findOne(event.id, id);
  }

  @Post()
  create(
    @CurrentEvent() event: { id: string },
    @Body() dto: CreateGuestDto,
  ): Promise<Guest> {
    return this.guestsService.create(event.id, dto);
  }

  @Put(':id')
  update(
    @CurrentEvent() event: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateGuestDto,
  ): Promise<Guest> {
    return this.guestsService.update(event.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentEvent() event: { id: string },
    @Param('id') id: string,
  ): Promise<void> {
    return this.guestsService.remove(event.id, id);
  }
}
