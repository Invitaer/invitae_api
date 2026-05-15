import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { secrets } from '../config/secrets';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  private static instance: Redis | null = null;

  constructor() {
    this.initializeConnection();
  }

  private initializeConnection(): void {
    if (RedisService.instance) return;

    RedisService.instance = new Redis({
      host: secrets.REDIS_HOST,
      port: parseInt(secrets.REDIS_PORT, 10),
      password: secrets.REDIS_PASSWORD || undefined,
      lazyConnect: false,
    });

    RedisService.instance.on('connect', () => {
      this.logger.log('Redis singleton connection established');
    });

    RedisService.instance.on('error', (err: Error) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  get client(): Redis {
    return RedisService.instance!;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    if (RedisService.instance) {
      await RedisService.instance.quit();
      RedisService.instance = null;
      this.logger.log('Redis connection closed');
    }
  }
}
