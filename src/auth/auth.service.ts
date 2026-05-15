import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users.schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const [user] = await this.db.db.select().from(users).where(eq(users.email, email));

    if (!user || user.password !== password) {
      return null;
    }

    const { password: _, ...result } = user;
    return result;
  }

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, email: user.email };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  async createUser(email: string, password: string, name: string) {
    const [user] = await this.db.db
      .insert(users)
      .values({ email, password, name })
      .returning();

    const { password: _, ...result } = user;
    return result;
  }
}