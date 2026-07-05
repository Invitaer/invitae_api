import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class NotifyGuestsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  guestIds: string[];
}
