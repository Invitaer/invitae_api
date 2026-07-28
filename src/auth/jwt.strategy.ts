import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { eq } from 'drizzle-orm';
import { secrets } from '../config/secrets';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users.schema';
import type { Audience } from './audience';
import { isAdminRole } from './admin-roles';
import { jwtCookieExtractor } from './auth-cookie';

/**
 * Bearer header FIRST, then the cookie belonging to THIS audience.
 *
 * The header stays supported for non-browser callers, and it is safe now that
 * every token declares which application it was minted for: a user token
 * pasted into an admin request is rejected by `validateFor` below, header or
 * not.
 *
 * The cookie extractor is audience-specific on purpose. Both dashboards live
 * on `localhost` in development, so once you have signed into both, the
 * browser attaches BOTH session cookies to every request. Picking "whatever
 * token is present" would authenticate admin routes with a user session.
 */
export function jwtExtractorFor(audience: Audience) {
  return ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    jwtCookieExtractor(audience),
  ]);
}

/**
 * Shared body of both strategies. Kept as a function rather than a base class
 * because `PassportStrategy(Strategy, name)` builds a different class per
 * strategy name, and inheriting from a mixin twice is more confusing than
 * calling one function from two places.
 */
async function validateFor(
  databaseService: DatabaseService,
  payload: { sub?: string; aud?: string },
  audience: Audience,
) {
  // Checked before touching the database: a token for the other application is
  // not a "who is this?" question, it is the wrong door entirely. Tokens minted
  // before the audience split carry no `aud` and fail here too, which logs
  // everyone out once — the intended one-time cost of the change.
  if (payload.aud !== audience) {
    throw new UnauthorizedException('Token was issued for a different application');
  }

  const rows = await databaseService.db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, payload.sub as string));

  if (rows.length === 0) {
    throw new UnauthorizedException('User no longer exists');
  }

  // Read from the DB on every request, never from the token: a 7-day JWT would
  // otherwise keep admin access alive long after the role was revoked.
  if (audience === 'admin' && !isAdminRole(rows[0].role)) {
    throw new ForbiddenException('This account has no admin access');
  }

  return rows[0];
}

@Injectable()
export class JwtAdminStrategy extends PassportStrategy(Strategy, 'jwt-admin') {
  constructor(private readonly databaseService: DatabaseService) {
    super({
      jwtFromRequest: jwtExtractorFor('admin'),
      ignoreExpiration: false,
      secretOrKey: secrets.JWT_SECRET,
    });
  }

  validate(payload: any) {
    return validateFor(this.databaseService, payload, 'admin');
  }
}

@Injectable()
export class JwtUserStrategy extends PassportStrategy(Strategy, 'jwt-user') {
  constructor(private readonly databaseService: DatabaseService) {
    super({
      jwtFromRequest: jwtExtractorFor('user'),
      ignoreExpiration: false,
      secretOrKey: secrets.JWT_SECRET,
    });
  }

  validate(payload: any) {
    return validateFor(this.databaseService, payload, 'user');
  }
}
