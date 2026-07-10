// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));
jest.mock('../database/database.service');
jest.mock('../redis/redis.service');

import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappLinkService } from './whatsapp-link.service';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';

function buildMockDb(rows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(rows);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });

  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });

  return { insert, select, _internals: { returning, values, where, from } };
}

describe('WhatsappLinkService', () => {
  let service: WhatsappLinkService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };
  let redisServiceMock: { set: jest.Mock; get: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };
    redisServiceMock = { set: jest.fn(), get: jest.fn(), del: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappLinkService,
        { provide: DatabaseService, useValue: dbServiceMock },
        { provide: RedisService, useValue: redisServiceMock },
      ],
    }).compile();

    service = module.get<WhatsappLinkService>(WhatsappLinkService);
  });

  describe('startLink', () => {
    it('generates a 6-digit OTP and stores wa:otp:{code}=userId with a 300s TTL', async () => {
      const { code } = await service.startLink('user-uuid-1');

      expect(code).toMatch(/^\d{6}$/);
      expect(redisServiceMock.set).toHaveBeenCalledWith(
        `wa:otp:${code}`,
        'user-uuid-1',
        300,
      );
    });
  });

  describe('verifyAndLink', () => {
    it('creates a whatsapp_links row and deletes the OTP key on a valid code', async () => {
      redisServiceMock.get.mockResolvedValue('user-uuid-1');
      dbServiceMock.db = buildMockDb([
        { id: 'link-1', userId: 'user-uuid-1', phoneNumber: '+5491100000000' },
      ]);

      const result = await service.verifyAndLink('123456', '+5491100000000');

      expect(result).toBe(true);
      expect(dbServiceMock.db.insert).toHaveBeenCalled();
      expect(redisServiceMock.del).toHaveBeenCalledWith('wa:otp:123456');
    });

    it('rejects an expired/unknown OTP without creating a link', async () => {
      redisServiceMock.get.mockResolvedValue(null);

      const result = await service.verifyAndLink('999999', '+5491100000000');

      expect(result).toBe(false);
      expect(dbServiceMock.db.insert).not.toHaveBeenCalled();
      expect(redisServiceMock.del).not.toHaveBeenCalled();
    });
  });

  describe('resolvePhone', () => {
    it('returns the userId when the phone number is linked', async () => {
      dbServiceMock.db = buildMockDb([
        { id: 'link-1', userId: 'user-uuid-1', phoneNumber: '+5491100000000' },
      ]);

      const userId = await service.resolvePhone('+5491100000000');

      expect(userId).toBe('user-uuid-1');
    });

    it('returns null when the phone number has no verified link', async () => {
      dbServiceMock.db = buildMockDb([]);

      const userId = await service.resolvePhone('+5491199999999');

      expect(userId).toBeNull();
    });
  });
});
