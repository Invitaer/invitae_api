import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class ContentService {
  private readonly PREFIX = 'content:';

  constructor(private readonly redisService: RedisService) {}

  async getAllKeys(): Promise<string[]> {
    const keys = await this.redisService.client.keys(`${this.PREFIX}*`);
    return keys.map((k) => k.replace(this.PREFIX, ''));
  }

  async getContent(key: string): Promise<{ key: string; value: string | null }> {
    const value = await this.redisService.get(`${this.PREFIX}${key}`);
    return { key, value };
  }

  async setContent(key: string, value: string): Promise<{ key: string; value: string }> {
    await this.redisService.set(`${this.PREFIX}${key}`, value);
    return { key, value };
  }

  async deleteContent(key: string): Promise<void> {
    await this.redisService.del(`${this.PREFIX}${key}`);
  }
}
