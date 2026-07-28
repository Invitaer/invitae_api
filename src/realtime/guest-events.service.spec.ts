// Mock secrets before any import: importing RedisService pulls in the secrets
// module, which validates the full env at import time.
jest.mock('../config/secrets', () => ({
  secrets: { REDIS_HOST: 'localhost', REDIS_PORT: '6379', REDIS_PASSWORD: '' },
}));

import { firstValueFrom, toArray } from 'rxjs';
import { take } from 'rxjs/operators';
import { GuestEventsService, GuestRsvpChangedEvent } from './guest-events.service';
import { RedisService } from '../redis/redis.service';

type MessageHandler = (channel: string, raw: string) => void;

/**
 * Stands in for ioredis. `duplicate()` hands back a separate fake so the test
 * can assert the subscriber never shares the command connection.
 */
function buildRedisMock() {
  const handlers: MessageHandler[] = [];
  const subscriber = {
    subscribe: jest.fn().mockResolvedValue(1),
    on: jest.fn((eventName: string, handler: MessageHandler) => {
      if (eventName === 'message') handlers.push(handler);
    }),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  const client = {
    publish: jest.fn().mockResolvedValue(1),
    duplicate: jest.fn(() => subscriber),
  };

  return {
    redisService: { client } as unknown as RedisService,
    client,
    subscriber,
    emit(raw: string, channel = GuestEventsService.CHANNEL) {
      handlers.forEach((h) => h(channel, raw));
    },
  };
}

const CHANGE: GuestRsvpChangedEvent = {
  eventId: 'event-1',
  guestId: 'guest-1',
  rsvpStatus: 'ACCEPTED',
  at: '2026-07-24T12:00:00.000Z',
};

describe('GuestEventsService', () => {
  let redis: ReturnType<typeof buildRedisMock>;
  let service: GuestEventsService;

  beforeEach(() => {
    redis = buildRedisMock();
    service = new GuestEventsService(redis.redisService);
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('subscribes on a DEDICATED connection, not the shared command client', () => {
    // ioredis refuses ordinary commands on a connection in subscriber mode —
    // reusing the shared client would break every get/set elsewhere in the app.
    expect(redis.client.duplicate).toHaveBeenCalledTimes(1);
    expect(redis.subscriber.subscribe).toHaveBeenCalledWith(
      GuestEventsService.CHANNEL,
    );
  });

  it('publishes through Redis so instances other than this one also deliver', async () => {
    await service.publish(CHANGE);

    expect(redis.client.publish).toHaveBeenCalledWith(
      GuestEventsService.CHANNEL,
      JSON.stringify(CHANGE),
    );
  });

  it('delivers a published change to a subscriber of that event', async () => {
    const received = firstValueFrom(service.streamFor('event-1').pipe(take(1)));

    redis.emit(JSON.stringify(CHANGE));

    await expect(received).resolves.toEqual(CHANGE);
  });

  it('does not leak one event’s guests to another event’s stream', async () => {
    const otherEvent = firstValueFrom(
      service.streamFor('event-2').pipe(take(1), toArray()),
    );
    const ownEvent = firstValueFrom(service.streamFor('event-1').pipe(take(1)));

    redis.emit(JSON.stringify(CHANGE)); // belongs to event-1
    redis.emit(
      JSON.stringify({ ...CHANGE, eventId: 'event-2', guestId: 'guest-9' }),
    );

    await expect(ownEvent).resolves.toEqual(CHANGE);
    await expect(otherEvent).resolves.toEqual([
      expect.objectContaining({ eventId: 'event-2', guestId: 'guest-9' }),
    ]);
  });

  it('survives malformed payloads instead of killing the stream for everyone', async () => {
    const received = firstValueFrom(service.streamFor('event-1').pipe(take(1)));

    redis.emit('this is not json');
    redis.emit(JSON.stringify(CHANGE));

    await expect(received).resolves.toEqual(CHANGE);
  });

  it('ignores traffic on channels it did not ask for', async () => {
    const received = firstValueFrom(service.streamFor('event-1').pipe(take(1)));

    redis.emit(JSON.stringify({ ...CHANGE, guestId: 'wrong-channel' }), 'other');
    redis.emit(JSON.stringify(CHANGE));

    await expect(received).resolves.toEqual(CHANGE);
  });

  it('closes its connection on shutdown', async () => {
    await service.onModuleDestroy();
    expect(redis.subscriber.quit).toHaveBeenCalled();
  });
});
