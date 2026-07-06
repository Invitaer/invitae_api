import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';
import {
  GuestInvitationResponse,
  InvitaeService,
  PublicGuest,
} from './invitae.service';

@Controller('invitae')
export class InvitaeController {
  constructor(private readonly invitaeService: InvitaeService) {}

  @Post('confirm')
  confirmAttendance(@Body() dto: ConfirmAttendanceDto): Promise<PublicGuest> {
    return this.invitaeService.confirmAttendance(dto);
  }

  @Get('invitation/:slug')
  getInvitation(@Param('slug') slug: string): Promise<InvitationDto> {
    return this.invitaeService.getInvitation(slug);
  }

  @Get('invitation/:slug/guest/:guestId')
  getGuestInvitation(
    @Param('slug') slug: string,
    @Param('guestId') guestId: string,
  ): Promise<GuestInvitationResponse> {
    return this.invitaeService.getGuestInvitation(slug, guestId);
  }
}
