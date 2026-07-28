// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));
jest.mock('../../database/database.service');

import { firstValueFrom, Subject } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { UserEventsController, SSE_HEARTBEAT_MS } from './user-events.controller';
import { UserEventsService } from './user-events.service';
import {
  GuestEventsService,
  GuestRsvpChangedEvent,
} from '../../realtime/guest-events.service';

const CHANGE: GuestRsvpChangedEvent = {
  eventId: 'event-1',
  guestId: 'guest-1',
  rsvpStatus: 'ACCEPTED',
  at: '2026-07-24T12:00:00.000Z',
};

describe('UserEventsController — guest RSVP stream', () => {
  let changes: Subject<GuestRsvpChangedEvent>;
  let controller: UserEventsController;
  let guestEvents: { streamFor: jest.Mock };

  beforeEach(() => {
    changes = new Subject<GuestRsvpChangedEvent>();
    guestEvents = { streamFor: jest.fn(() => changes.asObservable()) };
    controller = new UserEventsController(
      {} as UserEventsService,
      guestEvents as unknown as GuestEventsService,
    );
  });

  it('streams only the requested event’s changes', () => {
    controller.streamGuests('event-1');
    expect(guestEvents.streamFor).toHaveBeenCalledWith('event-1');
  });

  it('emits an RSVP change as a named SSE frame the client can listen for', async () => {
    const frame = firstValueFrom(controller.streamGuests('event-1').pipe(take(1)));

    changes.next(CHANGE);

    await expect(frame).resolves.toEqual({ type: 'guest-rsvp', data: CHANGE });
  });

  it('sends a heartbeat so idle connections are not culled by proxies', async () => {
    jest.useFakeTimers();
    try {
      const frames = firstValueFrom(
        controller.streamGuests('event-1').pipe(take(2), toArray()),
      );

      jest.advanceTimersByTime(SSE_HEARTBEAT_MS * 2);

      await expect(frames).resolves.toEqual([
        expect.objectContaining({ type: 'heartbeat' }),
        expect.objectContaining({ type: 'heartbeat' }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the heartbeat under the 30s idle timeout proxies commonly default to', () => {
    expect(SSE_HEARTBEAT_MS).toBeLessThan(30_000);
  });
});
