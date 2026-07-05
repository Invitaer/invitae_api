import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { eq } from 'drizzle-orm';
import { secrets } from '../config/secrets';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly databaseService: DatabaseService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secrets.JWT_SECRET,
    });
  }

  async validate(payload: any) {
    const rows = await this.databaseService.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, payload.sub));

    if (rows.length === 0) {
      throw new UnauthorizedException('User no longer exists');
    }

    return rows[0];
  }
}