import { IsArray, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export const EVENT_TYPES = [
  'wedding',
  'birthday',
  'baby_shower',
  'general',
  'xv_birth',
] as const;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsDateString()
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(EVENT_TYPES)
  eventType: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: string[];
}
