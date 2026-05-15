import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';
import { users } from '../database/schema/users.schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class AuthService {
  constructor(
    private dbService: DatabaseService,
    private jwtService: JwtService,
    private cryptoService: CryptoService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const [user] = await this.dbService.db.select().from(users).where(eq(users.email, email));

    if (!user || !(await this.cryptoService.compare(password, user.password))) {
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

  async register(email: string, password: string, name: string) {
    const hashedPassword = await this.cryptoService.hash(password);
    const [user] = await this.dbService.db
      .insert(users)
      .values({ email, password: hashedPassword, name })
      .returning();

    const { password: _, ...result } = user;
    return result;
  }
}
