// Mock secrets before any import so validation never runs at import time.
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
    API_PUBLIC_URL: 'https://api.invitaer.dev',
    USER_DASHBOARD_URL: 'https://app.invitaer.dev',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import {
  EmailVerificationService,
  VERIFICATION_TTL_SECONDS,
} from './email-verification.service';

const USER = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  name: 'Test User',
};

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let redisMock: {
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    setNX: jest.Mock;
  };
  let mailMock: { sendEmailVerification: jest.Mock };
  let dbMock: { db: { update: jest.Mock; select?: jest.Mock } };
  let updateReturning: jest.Mock;

  /** Mirrors the drizzle chain `db.update(users).set(...).where(...).returning(...)`. */
  function buildUpdateChain(result: unknown[]) {
    updateReturning = jest.fn().mockResolvedValue(result);
    return jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    });
  }

  beforeEach(async () => {
    redisMock = {
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(undefined),
      setNX: jest.fn().mockResolvedValue(true),
    };
    mailMock = {
      sendEmailVerification: jest.fn().mockResolvedValue({ ok: true, messageId: 'mid' }),
    };
    dbMock = { db: { update: buildUpdateChain([{ id: USER.id }]) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailVerificationService,
        { provide: RedisService, useValue: redisMock },
        { provide: MailService, useValue: mailMock },
        { provide: DatabaseService, useValue: dbMock },
      ],
    }).compile();

    service = module.get(EmailVerificationService);
  });

  describe('sendFor()', () => {
    it('stores the token in Redis bound to the user id, with a TTL', async () => {
      await service.sendFor(USER);

      expect(redisMock.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = redisMock.set.mock.calls[0];
      expect(key).toMatch(/^auth:verify:/);
      expect(value).toBe(USER.id);
      expect(ttl).toBe(VERIFICATION_TTL_SECONDS);
    });

    it('emails a verification URL carrying the same token that was stored', async () => {
      await service.sendFor(USER);

      const storedKey: string = redisMock.set.mock.calls[0][0];
      const token = storedKey.replace('auth:verify:', '');

      expect(mailMock.sendEmailVerification).toHaveBeenCalledWith(
        USER.email,
        expect.objectContaining({ name: USER.name }),
      );
      const { verificationUrl } = mailMock.sendEmailVerification.mock.calls[0][1];
      expect(verificationUrl).toContain(`token=${token}`);
    });

    it('generates a distinct token on every call', async () => {
      await service.sendFor(USER);
      await service.sendFor(USER);

      const first = redisMock.set.mock.calls[0][0];
      const second = redisMock.set.mock.calls[1][0];
      expect(first).not.toBe(second);
    });

    it('deletes the token when the email fails, so no unusable link stays valid', async () => {
      mailMock.sendEmailVerification.mockResolvedValue({ ok: false, error: 'smtp down' });

      const result = await service.sendFor(USER);

      expect(result.ok).toBe(false);
      const storedKey: string = redisMock.set.mock.calls[0][0];
      expect(redisMock.del).toHaveBeenCalledWith(storedKey);
    });

    it('never throws when the mail transport fails', async () => {
      mailMock.sendEmailVerification.mockRejectedValue(new Error('boom'));

      await expect(service.sendFor(USER)).resolves.toEqual(
        expect.objectContaining({ ok: false }),
      );
    });
  });

  describe('verify()', () => {
    it('returns false for an unknown or expired token without touching the database', async () => {
      redisMock.get.mockResolvedValue(null);

      const result = await service.verify('not-a-real-token');

      expect(result).toBe(false);
      expect(dbMock.db.update).not.toHaveBeenCalled();
    });

    it('stamps emailVerifiedAt and consumes the token on success', async () => {
      redisMock.get.mockResolvedValue(USER.id);

      const result = await service.verify('good-token');

      expect(result).toBe(true);
      expect(dbMock.db.update).toHaveBeenCalledTimes(1);
      expect(redisMock.del).toHaveBeenCalledWith('auth:verify:good-token');
    });

    it('is single-use: the token is consumed so a replay finds nothing', async () => {
      redisMock.get.mockResolvedValueOnce(USER.id).mockResolvedValueOnce(null);

      await expect(service.verify('good-token')).resolves.toBe(true);
      await expect(service.verify('good-token')).resolves.toBe(false);
      expect(dbMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('returns false when the token points at a user that no longer exists', async () => {
      redisMock.get.mockResolvedValue('deleted-user');
      dbMock.db.update = buildUpdateChain([]);

      await expect(service.verify('good-token')).resolves.toBe(false);
    });
  });

  describe('resendTo()', () => {
    /** Mirrors `db.select().from(users).where(...)`. */
    function stubSelect(rows: unknown[]) {
      (dbMock.db as Record<string, unknown>).select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
      });
    }

    it('sends a fresh link for a registered, still-unconfirmed account', async () => {
      stubSelect([{ ...USER, emailVerifiedAt: null }]);

      await service.resendTo(USER.email);

      expect(mailMock.sendEmailVerification).toHaveBeenCalledTimes(1);
    });

    it('sends nothing for an address that is not registered', async () => {
      stubSelect([]);

      await service.resendTo('nobody@example.com');

      expect(mailMock.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('sends nothing when the account is already confirmed', async () => {
      stubSelect([{ ...USER, emailVerifiedAt: new Date() }]);

      await service.resendTo(USER.email);

      expect(mailMock.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('never throws — the endpoint must answer identically either way', async () => {
      (dbMock.db as Record<string, unknown>).select = jest.fn(() => {
        throw new Error('db down');
      });

      await expect(service.resendTo(USER.email)).resolves.toBeUndefined();
    });
  });

  describe('cooldown()', () => {
    it('allows the first request and blocks the immediate retry', async () => {
      redisMock.setNX.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.claimResendSlot(USER.email)).resolves.toBe(true);
      await expect(service.claimResendSlot(USER.email)).resolves.toBe(false);
    });
  });
});
