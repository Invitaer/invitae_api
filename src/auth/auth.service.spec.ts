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
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database/database.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuthUser } from './interfaces/auth-user.interface';
import { EmailVerificationService } from './email-verification.service';
import { UserRole } from '../database/schema';

// --- Fixtures ---

const USER_WITH_PASSWORD = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
  password: 'hashed-password',
  role: UserRole.USER,
  emailVerifiedAt: new Date(),
  createdAt: new Date(),
};

/** Same account, promoted — the only kind allowed into the admin dashboard. */
const ADMIN_WITH_PASSWORD = {
  ...USER_WITH_PASSWORD,
  id: 'user-uuid-4',
  role: UserRole.ADMIN,
};

/** Same account, still unconfirmed — `login` must refuse this one. */
const UNVERIFIED_USER = {
  ...USER_WITH_PASSWORD,
  id: 'user-uuid-3',
  emailVerifiedAt: null as Date | null,
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
  role: UserRole.USER,
};

describe('AuthService', () => {
  let service: AuthService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };
  let cryptoServiceMock: { hash: jest.Mock; compare: jest.Mock };
  let jwtServiceMock: { sign: jest.Mock };
  let emailVerificationMock: { sendFor: jest.Mock };

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
    emailVerificationMock = {
      sendFor: jest.fn().mockResolvedValue({ ok: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: dbServiceMock },
        { provide: CryptoService, useValue: cryptoServiceMock },
        { provide: JwtService, useValue: jwtServiceMock },
        { provide: EmailVerificationService, useValue: emailVerificationMock },
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
    it('stamps the audience into the token so the other app can reject it', () => {
      const token = service.issueJwt(AUTH_USER, 'user');

      expect(token).toBe('signed.jwt.token');
      expect(jwtServiceMock.sign).toHaveBeenCalledWith({
        sub: AUTH_USER.id,
        email: AUTH_USER.email,
        name: AUTH_USER.name,
        aud: 'user',
      });
    });

    it('mints a distinguishable token per audience', () => {
      service.issueJwt(AUTH_USER, 'admin');

      expect(jwtServiceMock.sign).toHaveBeenCalledWith(
        expect.objectContaining({ aud: 'admin' }),
      );
    });
  });

  describe('login()', () => {
    it('returns the token and user object when credentials are valid', async () => {
      // Arrange: validateUser path succeeds
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);
      cryptoServiceMock.compare.mockResolvedValue(true);

      // Act
      const result = await service.login(USER_WITH_PASSWORD.email, 'plain-password', 'user');

      // Assert: shape matches { token, user: { id, email, name } }
      expect(result).toHaveProperty('token', 'signed.jwt.token');
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
      await expect(service.login(USER_WITH_PASSWORD.email, 'wrong-password', 'user'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException when the email was never confirmed', async () => {
      // Arrange: correct password, but emailVerifiedAt is null
      dbServiceMock.db = buildMockDb([UNVERIFIED_USER]);
      cryptoServiceMock.compare.mockResolvedValue(true);

      // Act & Assert
      await expect(service.login(UNVERIFIED_USER.email, 'plain-password', 'user'))
        .rejects.toThrow(ForbiddenException);
    });

    it('issues no token for an unconfirmed account', async () => {
      // A 403 that still signed a JWT would defeat the whole gate.
      dbServiceMock.db = buildMockDb([UNVERIFIED_USER]);
      cryptoServiceMock.compare.mockResolvedValue(true);

      await expect(
        service.login(UNVERIFIED_USER.email, 'plain-password', 'user'),
      ).rejects.toThrow();

      expect(jwtServiceMock.sign).not.toHaveBeenCalled();
    });

    it('rejects wrong credentials BEFORE checking verification status', async () => {
      // Otherwise the 403-vs-401 difference tells an attacker which addresses
      // are registered but unconfirmed.
      dbServiceMock.db = buildMockDb([UNVERIFIED_USER]);
      cryptoServiceMock.compare.mockResolvedValue(false);

      await expect(service.login(UNVERIFIED_USER.email, 'wrong-password', 'user'))
        .rejects.toThrow(UnauthorizedException);
    });
  });

  describe('login() — admin audience', () => {
    beforeEach(() => {
      cryptoServiceMock.compare.mockResolvedValue(true);
    });

    it('lets an ADMIN into the admin dashboard', async () => {
      dbServiceMock.db = buildMockDb([ADMIN_WITH_PASSWORD]);

      const result = await service.login(ADMIN_WITH_PASSWORD.email, 'plain-password', 'admin');

      expect(result.token).toBe('signed.jwt.token');
      expect(jwtServiceMock.sign).toHaveBeenCalledWith(
        expect.objectContaining({ aud: 'admin' }),
      );
    });

    it('lets a SUPER_ADMIN in too — it outranks ADMIN rather than replacing it', async () => {
      dbServiceMock.db = buildMockDb([
        { ...USER_WITH_PASSWORD, role: UserRole.SUPER_ADMIN },
      ]);

      await expect(
        service.login(USER_WITH_PASSWORD.email, 'plain-password', 'admin'),
      ).resolves.toHaveProperty('token');
    });

    it('refuses a plain USER even with the right password', async () => {
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);

      await expect(
        service.login(USER_WITH_PASSWORD.email, 'plain-password', 'admin'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('signs nothing for a rejected non-admin', async () => {
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);

      await expect(
        service.login(USER_WITH_PASSWORD.email, 'plain-password', 'admin'),
      ).rejects.toThrow();

      expect(jwtServiceMock.sign).not.toHaveBeenCalled();
    });

    it('still lets that same USER into the user dashboard', async () => {
      // The rejection is about which app, not about the account being broken.
      dbServiceMock.db = buildMockDb([USER_WITH_PASSWORD]);

      await expect(
        service.login(USER_WITH_PASSWORD.email, 'plain-password', 'user'),
      ).resolves.toHaveProperty('token');
    });
  });

  describe('register()', () => {
    beforeEach(() => {
      dbServiceMock.db.insert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([UNVERIFIED_USER]),
        }),
      });
    });

    it('sends a confirmation email for the freshly created account', async () => {
      await service.register(UNVERIFIED_USER.email, 'plain-password', UNVERIFIED_USER.name);

      expect(emailVerificationMock.sendFor).toHaveBeenCalledWith(
        expect.objectContaining({
          id: UNVERIFIED_USER.id,
          email: UNVERIFIED_USER.email,
        }),
      );
    });

    it('still returns the created user when the email cannot be delivered', async () => {
      // The row is already committed — failing the request would leave an
      // account the caller believes was never created.
      emailVerificationMock.sendFor.mockResolvedValue({ ok: false, error: 'smtp down' });

      const result = await service.register(
        UNVERIFIED_USER.email,
        'plain-password',
        UNVERIFIED_USER.name,
      );

      expect(result).toMatchObject({ id: UNVERIFIED_USER.id });
      expect(result).not.toHaveProperty('password');
    });
  });
});
