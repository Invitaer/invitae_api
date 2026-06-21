// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { DatabaseService } from '../database/database.service';

// --- Fixtures ---

// The DB query selects only { id, email, name } — the mock returns the projected shape
const DB_USER_PROJECTED = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
};

const VALID_PAYLOAD = {
  sub: 'user-uuid-1',
  email: 'old-email@example.com', // intentionally stale — strategy must use DB row
  name: 'Old Name',               // intentionally stale — strategy must use DB row
};

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  function buildMockDb(users: unknown[] = []) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(users),
        }),
      }),
    };
  }

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  describe('validate()', () => {
    it('returns { id, email, name } from DB row (not from token) when user exists', async () => {
      // Arrange: DB returns the fresh projected row (only id/email/name — as the query selects)
      dbServiceMock.db = buildMockDb([DB_USER_PROJECTED]);

      // Act
      const result = await strategy.validate(VALID_PAYLOAD);

      // Assert: values come from the DB row, NOT from the stale token payload
      expect(result).toEqual({
        id: DB_USER_PROJECTED.id,
        email: DB_USER_PROJECTED.email,
        name: DB_USER_PROJECTED.name,
      });
    });

    it('does NOT include password in the returned user object', async () => {
      // Arrange: DB returns the projected shape — password is never selected by the query
      dbServiceMock.db = buildMockDb([DB_USER_PROJECTED]);

      // Act
      const result = await strategy.validate(VALID_PAYLOAD);

      // Assert
      expect(result).not.toHaveProperty('password');
    });

    it('throws UnauthorizedException when user no longer exists in DB', async () => {
      // Arrange: DB returns empty array (user was deleted)
      dbServiceMock.db = buildMockDb([] as typeof DB_USER_PROJECTED[]);

      // Act & Assert
      await expect(strategy.validate(VALID_PAYLOAD))
        .rejects.toThrow(UnauthorizedException);

      await expect(strategy.validate(VALID_PAYLOAD))
        .rejects.toThrow('User no longer exists');
    });
  });
});
