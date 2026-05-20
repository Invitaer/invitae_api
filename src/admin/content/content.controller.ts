import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ContentService } from './content.service';
import { SetContentDto } from './dto/set-content.dto';
import { InvitationDto } from './dto/invitation.dto';
import { Auth } from '../../auth/decorators/authenticated.decorator';

@Controller('admin/content')
@Auth()
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  // ── Generic key-value ────────────────────────────────────────────────────

  @Get()
  getAllKeys(): Promise<string[]> {
    return this.contentService.getAllKeys();
  }

  @Get(':key')
  getContent(@Param('key') key: string): Promise<{ key: string; value: string | null }> {
    return this.contentService.getContent(key);
  }

  @Post()
  setContent(@Body() dto: SetContentDto): Promise<{ key: string; value: string }> {
    return this.contentService.setContent(dto.key, dto.value);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteContent(@Param('key') key: string): Promise<void> {
    return this.contentService.deleteContent(key);
  }

  // ── Invitations ──────────────────────────────────────────────────────────

  @Post('invitation')
  setInvitation(@Body() dto: InvitationDto): Promise<InvitationDto> {
    return this.contentService.setInvitation(dto);
  }

  @Get('invitation/:slug')
  getInvitation(@Param('slug') slug: string): Promise<InvitationDto> {
    return this.contentService.getInvitation(slug);
  }

  @Delete('invitation/:slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteInvitation(@Param('slug') slug: string): Promise<void> {
    return this.contentService.deleteInvitation(slug);
  }
}
