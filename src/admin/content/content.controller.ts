import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ContentService } from './content.service';
import { SetContentDto } from './dto/set-content.dto';
import { InvitationDto } from './dto/invitation.dto';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { CurrentEvent } from '../events/decorators/current-event.decorator';
import { EventOwnerGuard } from '../events/guards/event-owner.guard';
import { Event } from '../../database/schema';

@Controller('admin/events/:eventId/content')
@Auth('admin')
@UseGuards(EventOwnerGuard)
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  // ── Generic key-value ────────────────────────────────────────────────────

  @Get()
  getAllKeys(@CurrentEvent() event: Event): Promise<string[]> {
    return this.contentService.getAllKeys(event.id);
  }

  @Get(':key')
  getContent(
    @CurrentEvent() event: Event,
    @Param('key') key: string,
  ): Promise<{ key: string; value: string | null }> {
    return this.contentService.getContent(event.id, key);
  }

  @Post()
  setContent(
    @CurrentEvent() event: Event,
    @Body() dto: SetContentDto,
  ): Promise<{ key: string; value: string }> {
    return this.contentService.setContent(event.id, dto.key, dto.value);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteContent(
    @CurrentEvent() event: Event,
    @Param('key') key: string,
  ): Promise<void> {
    return this.contentService.deleteContent(event.id, key);
  }

  // ── Invitation (1 per event — eventId-keyed Redis) ────────────────────────

  @Post('invitation')
  setInvitation(
    @CurrentEvent() event: Event,
    @Body() dto: InvitationDto,
  ): Promise<InvitationDto> {
    return this.contentService.setInvitation(event, dto);
  }

  @Get('invitation')
  getInvitation(@CurrentEvent() event: Event): Promise<InvitationDto> {
    return this.contentService.getInvitation(event);
  }

  @Delete('invitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteInvitation(@CurrentEvent() event: Event): Promise<void> {
    return this.contentService.deleteInvitation(event.id);
  }
}
