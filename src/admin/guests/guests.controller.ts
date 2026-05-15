import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Guest } from '../../database/schema';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { GuestsService } from './guests.service';
import { Auth } from '../../auth/decorators/authenticated.decorator';

@Controller('admin/guests')
@Auth()
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Get()
  findAll(): Promise<Guest[]> {
    return this.guestsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Guest> {
    return this.guestsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateGuestDto): Promise<Guest> {
    return this.guestsService.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGuestDto): Promise<Guest> {
    return this.guestsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.guestsService.remove(id);
  }
}
