import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Guest } from '../database/schema';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';
import { InvitaeService } from './invitae.service';

@Controller('invitae')
export class InvitaeController {
  constructor(private readonly invitaeService: InvitaeService) {}

  @Post('confirm')
  confirmAttendance(@Body() dto: ConfirmAttendanceDto): Promise<Guest> {
    return this.invitaeService.confirmAttendance(dto);
  }

  @Get('invitation/:slug')
  getInvitation(@Param('slug') slug: string): Promise<InvitationDto> {
    return this.invitaeService.getInvitation(slug);
  }
}
