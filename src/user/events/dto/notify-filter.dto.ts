import { IsOptional, IsString } from 'class-validator';

export class NotifyFilterDto {
  @IsOptional()
  @IsString()
  search?: string;
}
