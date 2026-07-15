// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));
jest.mock('../redis/redis.service');

import { Test, TestingModule } from '@nestjs/testing';
import { ConversationStore } from './conversation.store';
import { RedisService } from '../redis/redis.service';

describe('ConversationStore', () => {
  let store: ConversationStore;
  let redisServiceMock: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redisServiceMock = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationStore,
        { provide: RedisService, useValue: redisServiceMock },
      ],
    }).compile();

    store = module.get<ConversationStore>(ConversationStore);
  });

  describe('get', () => {
    it('returns the parsed context when present', async () => {
      redisServiceMock.get.mockResolvedValue(
        JSON.stringify({ userId: 'user-1', currentEventId: 'event-1' }),
      );

      const ctx = await store.get('+5491100000000');

      expect(redisServiceMock.get).toHaveBeenCalledWith('wa:ctx:+5491100000000');
      expect(ctx).toEqual({ userId: 'user-1', currentEventId: 'event-1' });
    });

    it('returns null when there is no context (expired or never set)', async () => {
      redisServiceMock.get.mockResolvedValue(null);

      const ctx = await store.get('+5491100000000');

      expect(ctx).toBeNull();
    });
  });

  describe('set', () => {
    it('persists the context as JSON with a 30-minute (1800s) sliding TTL', async () => {
      const ctx = { userId: 'user-1', currentEventId: 'event-1' };

      await store.set('+5491100000000', ctx);

      expect(redisServiceMock.set).toHaveBeenCalledWith(
        'wa:ctx:+5491100000000',
        JSON.stringify(ctx),
        1800,
      );
    });
  });

  describe('clear', () => {
    it('deletes the context key', async () => {
      await store.clear('+5491100000000');

      expect(redisServiceMock.del).toHaveBeenCalledWith('wa:ctx:+5491100000000');
    });
  });
});
