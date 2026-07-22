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
    afterEach(() => {
      jest.useRealTimers();
    });

    it('persists the context as JSON with a 30-minute (1800s) sliding TTL', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      const ctx = { userId: 'user-1', currentEventId: 'event-1' };

      await store.set('+5491100000000', ctx);

      expect(redisServiceMock.set).toHaveBeenCalledWith(
        'wa:ctx:+5491100000000',
        JSON.stringify({ ...ctx, lastInteractionAt: Date.now() }),
        1800,
      );
    });

    it('stamps lastInteractionAt on EVERY write so it can never drift out of sync with the sliding TTL', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
      await store.set('+5491100000000', { userId: 'user-1' });
      const first = JSON.parse(redisServiceMock.set.mock.calls[0][1]);

      jest.setSystemTime(new Date('2026-07-19T12:05:00.000Z'));
      await store.set('+5491100000000', { userId: 'user-1', lastInteractionAt: first.lastInteractionAt });
      const second = JSON.parse(redisServiceMock.set.mock.calls[1][1]);

      expect(second.lastInteractionAt).toBe(Date.now());
      expect(second.lastInteractionAt).toBeGreaterThan(first.lastInteractionAt);
    });

    it('round-trips pendingIntent through get', async () => {
      redisServiceMock.get.mockResolvedValue(
        JSON.stringify({
          userId: 'user-1',
          currentEventId: 'event-1',
          pendingIntent: { kind: 'RSVP_SUMMARY' },
        }),
      );

      const ctx = await store.get('+5491100000000');

      expect(ctx?.pendingIntent).toEqual({ kind: 'RSVP_SUMMARY' });
    });
  });

  describe('clear', () => {
    it('deletes the context key', async () => {
      await store.clear('+5491100000000');

      expect(redisServiceMock.del).toHaveBeenCalledWith('wa:ctx:+5491100000000');
    });
  });
});
