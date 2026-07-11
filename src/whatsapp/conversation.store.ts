import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PendingAction } from './flow.machine';

export interface ConversationContext {
  userId: string;
  currentEventId?: string;
  pendingAction?: PendingAction;
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
    await this.redisService.set(this.key(phoneNumber), JSON.stringify(ctx), CONTEXT_TTL_SECONDS);
  }

  async clear(phoneNumber: string): Promise<void> {
    await this.redisService.del(this.key(phoneNumber));
  }

  private key(phoneNumber: string): string {
    return `wa:ctx:${phoneNumber}`;
  }
}
