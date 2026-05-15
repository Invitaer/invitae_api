import { IsString } from 'class-validator';

export class SetContentDto {
  @IsString()
  key: string;

  @IsString()
  value: string;
}
