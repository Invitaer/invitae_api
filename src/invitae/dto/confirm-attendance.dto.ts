import { IsBoolean, IsUUID } from 'class-validator';

export class ConfirmAttendanceDto {
  @IsUUID()
  guestId: string;

  @IsBoolean()
  attending: boolean;
}
