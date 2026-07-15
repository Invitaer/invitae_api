import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { whatsappLinks } from '../database/schema';

const OTP_TTL_SECONDS = 300;
const OTP_MIN = 100000;
const OTP_MAX = 1000000; // exclusive upper bound for randomInt

@Injectable()
export class WhatsappLinkService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  async startLink(userId: string): Promise<{ code: string }> {
    const code = String(randomInt(OTP_MIN, OTP_MAX));
    await this.redisService.set(this.otpKey(code), userId, OTP_TTL_SECONDS);
    return { code };
  }

  async verifyAndLink(code: string, phoneNumber: string): Promise<boolean> {
    const userId = await this.redisService.get(this.otpKey(code));
    if (!userId) {
      return false;
    }

    // Upsert on the unique phone_number: re-linking an already-linked phone
    // (e.g. transferring it to another user) must be idempotent and NEVER
    // throw on the unique constraint.
    await this.databaseService.db
      .insert(whatsappLinks)
      .values({
        userId,
        phoneNumber,
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: whatsappLinks.phoneNumber,
        set: { userId, verifiedAt: new Date() },
      });

    await this.redisService.del(this.otpKey(code));
    return true;
  }

  async resolvePhone(phoneNumber: string): Promise<string | null> {
    const [link] = await this.databaseService.db
      .select()
      .from(whatsappLinks)
      .where(eq(whatsappLinks.phoneNumber, phoneNumber));

    return link ? link.userId : null;
  }

  private otpKey(code: string): string {
    return `wa:otp:${code}`;
  }
}
