import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { secrets } from "../config/secrets";

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

    RedisService.instance.on("connect", () => {
      this.logger.log("Redis singleton connection established");
    });

    RedisService.instance.on("error", (err: Error) => {
      this.logger.error(`Redis connection HERE error: ${err.message}`, err.stack);
    });
  }

  get client(): Redis {
    return RedisService.instance!;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, "EX", ttlSeconds);
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

  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  /**
   * Compare-and-delete: deletes `key` only if its current value equals
   * `value`. Used for safe lock release so a holder never deletes a lock that
   * a later owner acquired after this one's TTL expired. Runs atomically as a
   * single Lua script server-side.
   */
  async delIfEquals(key: string, value: string): Promise<void> {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.client.eval(script, 1, key, value);
  }

  async onModuleDestroy(): Promise<void> {
    if (RedisService.instance) {
      await RedisService.instance.quit();
      RedisService.instance = null;
      this.logger.log("Redis connection closed");
    }
  }
}
