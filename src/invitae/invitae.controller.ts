import { Body, Controller, Post } from '@nestjs/common';
import { Guest } from '../database/schema';
import { ConfirmAttendanceDto } from './dto/confirm-attendance.dto';
import { InvitaeService } from './invitae.service';

@Controller('invitae')
export class InvitaeController {
  constructor(private readonly invitaeService: InvitaeService) {}

  @Post('confirm')
  confirmAttendance(@Body() dto: ConfirmAttendanceDto): Promise<Guest> {
    return this.invitaeService.confirmAttendance(dto);
  }
}
