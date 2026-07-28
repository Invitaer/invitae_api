import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { RedisService } from '../redis/redis.service';

/** Emitted whenever a guest's RSVP changes, from any source. */
export interface GuestRsvpChangedEvent {
  eventId: string;
  guestId: string;
  rsvpStatus: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  /** ISO timestamp of the change, so a client can discard out-of-order frames. */
  at: string;
}

/**
 * Fan-out for guest RSVP changes.
 *
 * Redis pub/sub rather than a plain in-process `Subject`: a guest confirms
 * against whichever API instance their request lands on, while the organizer's
 * SSE stream is held open by a possibly DIFFERENT instance. An in-process
 * subject would deliver only when both happen to be the same box, which looks
 * like flaky realtime rather than a missing broadcast.
 *
 * One shared channel carries every event's changes and each stream filters
 * for its own. At this scale (one active event per organizer) that costs far
 * less than subscribing and unsubscribing per connection, which would also
 * race when several organizers of the same event connect and disconnect.
 */
@Injectable()
export class GuestEventsService implements OnModuleInit, OnModuleDestroy {
  static readonly CHANNEL = 'invitae:guest-rsvp';

  private readonly logger = new Logger(GuestEventsService.name);
  private readonly changes = new Subject<GuestRsvpChangedEvent>();
  private subscriber: Redis | null = null;

  constructor(private readonly redisService: RedisService) {}

  onModuleInit(): void {
    // MUST be its own connection: ioredis rejects ordinary commands on a
    // connection in subscriber mode, so reusing the shared client would break
    // every get/set in the app the moment this subscribes.
    this.subscriber = this.redisService.client.duplicate();

    void this.subscriber.subscribe(GuestEventsService.CHANNEL);

    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== GuestEventsService.CHANNEL) return;
      const parsed = this.parse(raw);
      if (parsed) this.changes.next(parsed);
    });
  }

  async publish(change: GuestRsvpChangedEvent): Promise<void> {
    await this.redisService.client.publish(
      GuestEventsService.CHANNEL,
      JSON.stringify(change),
    );
  }

  /** Changes for one event only — never another organizer's guests. */
  streamFor(eventId: string): Observable<GuestRsvpChangedEvent> {
    return this.changes
      .asObservable()
      .pipe(filter((change) => change.eventId === eventId));
  }

  async onModuleDestroy(): Promise<void> {
    this.changes.complete();
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  /**
   * A malformed frame must not reach `Subject.error` — that would terminate
   * the subject permanently and silently kill realtime for every connected
   * organizer until the process restarts.
   */
  private parse(raw: string): GuestRsvpChangedEvent | null {
    try {
      return JSON.parse(raw) as GuestRsvpChangedEvent;
    } catch {
      this.logger.warn(`Discarded malformed guest RSVP frame: ${raw}`);
      return null;
    }
  }
}
