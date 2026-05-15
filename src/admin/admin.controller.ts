import { Controller, Get } from '@nestjs/common';
import { Auth } from '../auth/decorators/authenticated.decorator';

@Controller('admin')
@Auth()
export class AdminController {
  @Get()
  index(): { message: string } {
    return { message: 'Invitae Admin API' };
  }
}
