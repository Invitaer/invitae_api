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
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

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

  // ── Invitation (1 per user) ──────────────────────────────────────────────

  @Post('invitation')
  setInvitation(
    @CurrentUser() user: { id: string },
    @Body() dto: InvitationDto,
  ): Promise<InvitationDto> {
    return this.contentService.setInvitation(user.id, dto);
  }

  @Get('invitation')
  getInvitation(@CurrentUser() user: { id: string }): Promise<InvitationDto> {
    return this.contentService.getInvitation(user.id);
  }

  @Delete('invitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteInvitation(@CurrentUser() user: { id: string }): Promise<void> {
    return this.contentService.deleteInvitation(user.id);
  }
}
