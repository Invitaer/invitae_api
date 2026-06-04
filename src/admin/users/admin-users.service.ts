import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema';

@Injectable()
export class AdminUsersService {
  constructor(private readonly databaseService: DatabaseService) {}

  findAll(): Promise<{ id: string; name: string; email: string }[]> {
    return this.databaseService.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users);
  }
}
