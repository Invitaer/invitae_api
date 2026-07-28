import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { AdminUsersService, AdminUser } from './admin-users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { FindUsersQueryDto } from './dto/find-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('admin/users')
@Auth('admin')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  findAll(
    @Query() query: FindUsersQueryDto,
  ): Promise<{ data: AdminUser[]; total: number }> {
    return this.adminUsersService.findAllPaginated(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<AdminUser> {
    return this.adminUsersService.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateUserDto): Promise<AdminUser> {
    return this.adminUsersService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<AdminUser> {
    return this.adminUsersService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.adminUsersService.remove(id);
  }
}
