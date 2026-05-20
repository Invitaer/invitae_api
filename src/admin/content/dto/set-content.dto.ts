import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';
import { InvitationDto } from './invitation.dto';

export class SetContentDto {
  @IsString()
  key: string;

  @IsString()
  value: string;
}

export class SetInvitationDto {
  @IsString()
  slug!: string;

  @ValidateNested()
  @Type(() => InvitationDto)
  invitation!: InvitationDto;
}
