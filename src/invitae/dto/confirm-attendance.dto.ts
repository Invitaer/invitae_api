import { IsBoolean, IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class ConfirmAttendanceDto {
  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsUUID()
  guestId: string;

  @IsBoolean()
  attending: boolean;
}
