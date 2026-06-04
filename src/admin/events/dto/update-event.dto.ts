import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { EVENT_TYPES } from './create-event.dto';

export class UpdateEventDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  slug?: string;

  @IsDateString()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  @IsIn(EVENT_TYPES)
  eventType?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: string[];
}
