import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

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
}
