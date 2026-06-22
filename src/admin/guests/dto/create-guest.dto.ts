import { IsEmail, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { RsvpStatus } from '../../../database/schema/guests.schema';

export class CreateGuestDto {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsUUID()
  @IsOptional()
  tableId?: string;

  @IsEnum(RsvpStatus)
  @IsOptional()
  rsvpStatus?: RsvpStatus;
}
