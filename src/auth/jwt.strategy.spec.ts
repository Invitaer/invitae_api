// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAdminStrategy, JwtUserStrategy, jwtExtractorFor } from './jwt.strategy';
import { authCookieName } from './auth-cookie';
import { DatabaseService } from '../database/database.service';
import { UserRole } from '../database/schema';

// --- Fixtures ---

// The DB query selects only { id, email, name, role } — the mock returns the projected shape
const DB_USER_PROJECTED = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
  role: UserRole.USER,
};

const DB_ADMIN_PROJECTED = { ...DB_USER_PROJECTED, role: UserRole.ADMIN };

const userPayload = {
  sub: 'user-uuid-1',
  email: 'old-email@example.com', // intentionally stale — strategy must use DB row
  name: 'Old Name', // intentionally stale — strategy must use DB row
  aud: 'user',
};

const adminPayload = { ...userPayload, aud: 'admin' };

describe('jwtExtractorFor', () => {
  const asRequest = (req: unknown) => req as Parameters<ReturnType<typeof jwtExtractorFor>>[0];

  it('reads the Bearer header when present', () => {
    expect(
      jwtExtractorFor('user')(
        asRequest({ headers: { authorization: 'Bearer header-jwt' } }),
      ),
    ).toBe('header-jwt');
  });

  it('falls back to its own cookie, which is how EventSource authenticates', () => {
    expect(
      jwtExtractorFor('user')(
        asRequest({ headers: {}, cookies: { [authCookieName('user')]: 'cookie-jwt' } }),
      ),
    ).toBe('cookie-jwt');
  });

  it('never picks up the other audience cookie', () => {
    // Both cookies ride along on every request once you have used both apps.
    expect(
      jwtExtractorFor('admin')(
        asRequest({ headers: {}, cookies: { [authCookieName('user')]: 'user-jwt' } }),
      ),
    ).toBeNull();
  });

  it('returns null when neither is present', () => {
    expect(jwtExtractorFor('user')(asRequest({ headers: {} }))).toBeNull();
  });
});

function buildMockDb(users: unknown[] = []) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(users),
      }),
    }),
  };
}

async function buildStrategies(rows: unknown[]) {
  const dbServiceMock = { db: buildMockDb(rows) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      JwtAdminStrategy,
      JwtUserStrategy,
      { provide: DatabaseService, useValue: dbServiceMock },
    ],
  }).compile();

  return {
    admin: module.get(JwtAdminStrategy),
    user: module.get(JwtUserStrategy),
  };
}

describe('JwtUserStrategy.validate()', () => {
  it('returns the fresh DB row rather than the values baked into the token', async () => {
    const { user } = await buildStrategies([DB_USER_PROJECTED]);

    await expect(user.validate(userPayload)).resolves.toEqual({
      id: DB_USER_PROJECTED.id,
      email: DB_USER_PROJECTED.email,
      name: DB_USER_PROJECTED.name,
      role: DB_USER_PROJECTED.role,
    });
  });

  it('does NOT include password in the returned user object', async () => {
    const { user } = await buildStrategies([DB_USER_PROJECTED]);

    await expect(user.validate(userPayload)).resolves.not.toHaveProperty('password');
  });

  it('throws UnauthorizedException when the user no longer exists in DB', async () => {
    const { user } = await buildStrategies([]);

    await expect(user.validate(userPayload)).rejects.toThrow(UnauthorizedException);
    await expect(user.validate(userPayload)).rejects.toThrow('User no longer exists');
  });

  it('lets an admin use the user dashboard — admins own events too', async () => {
    const { user } = await buildStrategies([DB_ADMIN_PROJECTED]);

    await expect(
      user.validate({ ...userPayload, aud: 'user' }),
    ).resolves.toMatchObject({ role: UserRole.ADMIN });
  });
});

describe('JwtAdminStrategy.validate()', () => {
  it('accepts an admin-audience token from a user whose role is still ADMIN', async () => {
    const { admin } = await buildStrategies([DB_ADMIN_PROJECTED]);

    await expect(admin.validate(adminPayload)).resolves.toMatchObject({
      role: UserRole.ADMIN,
    });
  });

  /**
   * The hole this whole change exists to close: `@Auth()` used to mean nothing
   * more than "is signed in", so any authenticated USER could call /admin/*.
   */
  it('accepts a SUPER_ADMIN — it outranks ADMIN, it is not a lesser role', async () => {
    // A strict `role === ADMIN` check would lock the highest-privileged
    // account out of the panel it exists to run. The enum has three values.
    const { admin } = await buildStrategies([
      { ...DB_USER_PROJECTED, role: UserRole.SUPER_ADMIN },
    ]);

    await expect(admin.validate(adminPayload)).resolves.toMatchObject({
      role: UserRole.SUPER_ADMIN,
    });
  });

  it('rejects a non-admin even when the token itself is valid and admin-audience', async () => {
    // Role is read from the DB on every request, so a demotion takes effect
    // immediately instead of waiting for a 7-day token to expire.
    const { admin } = await buildStrategies([DB_USER_PROJECTED]);

    await expect(admin.validate(adminPayload)).rejects.toThrow(ForbiddenException);
  });
});

describe('audience mismatch', () => {
  it('refuses a user token presented to an admin route', async () => {
    const { admin } = await buildStrategies([DB_ADMIN_PROJECTED]);

    // Even for a genuine admin: the token was minted for the other app, so
    // pasting it as a Bearer header must not open admin routes.
    await expect(admin.validate(userPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses an admin token presented to a user route', async () => {
    const { user } = await buildStrategies([DB_ADMIN_PROJECTED]);

    await expect(user.validate(adminPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a token with no audience claim at all — those predate the split', async () => {
    const { user } = await buildStrategies([DB_USER_PROJECTED]);
    const { aud: _aud, ...legacy } = userPayload;

    await expect(user.validate(legacy)).rejects.toThrow(UnauthorizedException);
  });
});
