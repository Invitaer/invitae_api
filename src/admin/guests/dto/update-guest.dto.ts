import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { RsvpStatus } from '../../../database/schema/guests.schema';

/** Treat a blank string as "no value" so optional fields validate cleanly. */
const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class UpdateGuestDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsEmail()
  @IsOptional()
  @Transform(emptyToNull)
  email?: string | null;

  @IsUUID()
  @IsOptional()
  tableId?: string;

  @IsBoolean()
  @IsOptional()
  invitationSent?: boolean;

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
