import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ilike, or, sql, eq } from 'drizzle-orm';
import { CryptoService } from '../../crypto/crypto.service';
import { DatabaseService } from '../../database/database.service';
import { UserRole, users } from '../../database/schema';
import { CreateUserDto } from './dto/create-user.dto';
import { FindUsersQueryDto } from './dto/find-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const SAFE_USER_FIELDS = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
} as const;

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
  ) {}

  async findAllPaginated(
    query: FindUsersQueryDto,
  ): Promise<{ data: AdminUser[]; total: number }> {
    const { search, page = 1, limit = 10 } = query;
    const offset = (page - 1) * limit;

    const filter =
      search !== undefined && search !== ''
        ? or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`))
        : undefined;

    const db = this.databaseService.db;

    const data: AdminUser[] = await db
      .select(SAFE_USER_FIELDS)
      .from(users)
      .where(filter)
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(filter);

    return { data, total: count };
  }

  async findOne(id: string): Promise<AdminUser> {
    const [user] = await this.databaseService.db
      .select(SAFE_USER_FIELDS)
      .from(users)
      .where(eq(users.id, id));

    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async create(dto: CreateUserDto): Promise<AdminUser> {
    const hashedPassword = await this.cryptoService.hash(dto.password);

    try {
      const [user] = await this.databaseService.db
        .insert(users)
        .values({
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
          role: dto.role ?? UserRole.USER,
        })
        .returning(SAFE_USER_FIELDS);

      return user;
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException('A user with this email already exists');
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateUserDto): Promise<AdminUser> {
    const updateData: Record<string, unknown> = {};

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.role !== undefined) updateData.role = dto.role;
    if (dto.password !== undefined) {
      updateData.password = await this.cryptoService.hash(dto.password);
    }

    const [user] = await this.databaseService.db
      .update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning(SAFE_USER_FIELDS);

    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async remove(id: string): Promise<void> {
    const [deleted] = await this.databaseService.db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });

    if (!deleted) throw new NotFoundException(`User ${id} not found`);
  }
}
