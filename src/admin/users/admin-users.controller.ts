import { Controller, Get } from '@nestjs/common';
import { Auth } from '../../auth/decorators/authenticated.decorator';
import { AdminUsersService } from './admin-users.service';

@Controller('admin/users')
@Auth()
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  findAll(): Promise<{ id: string; name: string; email: string }[]> {
    return this.adminUsersService.findAll();
  }
}
