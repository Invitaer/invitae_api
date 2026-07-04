import {
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
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

  @IsInt()
  @Min(1)
  @IsOptional()
  tickets?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  tableNumber?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  additionalPhones?: string[];
}
