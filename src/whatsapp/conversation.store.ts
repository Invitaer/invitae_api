import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { BotIntent } from './bot-intent';
import { PendingAction } from './flow.machine';

export interface ConversationContext {
  userId: string;
  currentEventId?: string;
  pendingAction?: PendingAction;
  /**
   * Epoch ms of the last write to this context. Stamped by `set` (never by
   * callers) so it can never drift out of sync with the sliding TTL below.
   * The service uses it to decide when to re-confirm the active event.
   */
  lastInteractionAt?: number;
  /**
   * Intent parked while the user answers the "still working on this event?"
   * re-confirmation gate, replayed once they confirm.
   */
  pendingIntent?: BotIntent;
}

const CONTEXT_TTL_SECONDS = 1800; // 30 minutes, sliding — refreshed on every `set`

@Injectable()
export class ConversationStore {
  constructor(private readonly redisService: RedisService) {}

  async get(phoneNumber: string): Promise<ConversationContext | null> {
    const raw = await this.redisService.get(this.key(phoneNumber));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ConversationContext;
  }

  async set(phoneNumber: string, ctx: ConversationContext): Promise<void> {
    // The timestamp is stamped HERE, on every single write, rather than by
    // callers — that is what keeps it in lockstep with the sliding TTL the
    // same call refreshes.
    const stamped: ConversationContext = { ...ctx, lastInteractionAt: Date.now() };
    await this.redisService.set(
      this.key(phoneNumber),
      JSON.stringify(stamped),
      CONTEXT_TTL_SECONDS,
    );
  }

  async clear(phoneNumber: string): Promise<void> {
    await this.redisService.del(this.key(phoneNumber));
  }

  private key(phoneNumber: string): string {
    return `wa:ctx:${phoneNumber}`;
  }
}
