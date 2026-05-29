// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');
jest.mock('../crypto/crypto.service');

import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuthUser } from './interfaces/auth-user.interface';

// --- Fixtures ---

const USER_WITH_PASSWORD = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
  password: 'hashed-password',
  createdAt: new Date(),
};

const USER_WITHOUT_PASSWORD = {
  ...USER_WITH_PASSWORD,
  id: 'user-uuid-2',
  password: null as string | null,
};

const AUTH_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
};

describe('AuthService', () => {
  let service: AuthService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };
  let cryptoServiceMock: { hash: jest.Mock; compare: jest.Mock };
  let jwtServiceMock: { sign: jest.Mock };

  function buildMockDb(users: unknown[] = []) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(users),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    };
  }

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };
    cryptoServiceMock = {
      hash: jest.fn(),
      compare: jest.fn(),
    };
    jwtServiceMock = {
      sign: jest.fn().mockReturnValue('signed.jwt.token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: dbServiceMock },
        { provide: CryptoService, useValue: cryptoServiceMock },
        { provide: JwtService, useValue: jwtServiceMock },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('validateUser()', () => {
    it('throws UnauthorizedException when user has null password (social-only account)', async () => {
      // Arrange: user exists but has no password (OAuth-only account)
      dbServiceMock.db = buildMockDb([USER_WITHOUT_PASSWORD]);

      // Act & Assert
      await expect(service.validateUser(USER_WITHOUT_PASSWORD.email, 'any-password'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('returns user without password when credentials are valid', async () => {
      // Arrange: user exists, password matches
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);
      cryptoServiceMock.compare.mockResolvedValue(true);

      // Act
      const result = await service.validateUser(USER_WITH_PASSWORD.email, 'plain-password');

      // Assert: password field stripped from result
      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({
        id: USER_WITH_PASSWORD.id,
        email: USER_WITH_PASSWORD.email,
        name: USER_WITH_PASSWORD.name,
      });
    });
  });

  describe('issueJwt()', () => {
    it('returns a signed JWT string for the given AuthUser', () => {
      // Act
      const token = service.issueJwt(AUTH_USER);

      // Assert
      expect(typeof token).toBe('string');
      expect(token).toBe('signed.jwt.token');
      expect(jwtServiceMock.sign).toHaveBeenCalledWith({
        sub: AUTH_USER.id,
        email: AUTH_USER.email,
        name: AUTH_USER.name,
      });
    });
  });

  describe('login()', () => {
    it('returns access_token and user object when credentials are valid', async () => {
      // Arrange: validateUser path succeeds
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);
      cryptoServiceMock.compare.mockResolvedValue(true);

      // Act
      const result = await service.login(USER_WITH_PASSWORD.email, 'plain-password');

      // Assert: shape matches { access_token, user: { id, email, name } }
      expect(result).toHaveProperty('access_token', 'signed.jwt.token');
      expect(result).toHaveProperty('user');
      expect(result.user).toMatchObject({
        id: USER_WITH_PASSWORD.id,
        email: USER_WITH_PASSWORD.email,
        name: USER_WITH_PASSWORD.name,
      });
      expect(result.user).not.toHaveProperty('password');
    });

    it('throws UnauthorizedException when credentials are invalid', async () => {
      // Arrange: validateUser returns null (wrong password)
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);
      cryptoServiceMock.compare.mockResolvedValue(false);

      // Act & Assert
      await expect(service.login(USER_WITH_PASSWORD.email, 'wrong-password'))
        .rejects.toThrow(UnauthorizedException);
    });
  });
});
