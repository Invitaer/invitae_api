import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import { whatsappLinks } from '../database/schema';

const OTP_TTL_SECONDS = 300;
const OTP_TTL_MINUTES = OTP_TTL_SECONDS / 60;
const OTP_MIN = 100000;
const OTP_MAX = 1000000; // exclusive upper bound for randomInt

@Injectable()
export class WhatsappLinkService {
  private readonly logger = new Logger(WhatsappLinkService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Starts a phone-link: generates a one-time code bound to `userId` in Redis
   * and EMAILS it to the user, who then sends it to the bot from the phone they
   * want to link. The code is a possession factor — it is delivered by email
   * only, never returned in the HTTP response. If the email cannot be sent the
   * Redis key is removed (so no code is left valid that the user never saw) and
   * a 503 is raised.
   */
  async startLink(userId: string, email: string): Promise<{ delivered: true; email: string }> {
    const code = String(randomInt(OTP_MIN, OTP_MAX));
    await this.redisService.set(this.otpKey(code), userId, OTP_TTL_SECONDS);

    const sent = await this.mailService.sendWhatsappOtp(email, {
      code,
      ttlMinutes: OTP_TTL_MINUTES,
    });

    if (!sent.ok) {
      // Do not leave a code the user never received sitting valid in Redis.
      await this.redisService.del(this.otpKey(code));
      this.logger.error(`Failed to email WhatsApp OTP to ${email}: ${sent.error}`);
      throw new ServiceUnavailableException('No pudimos enviar el código por correo.');
    }

    this.logger.log(`WhatsApp OTP emailed to ${email} for user ${userId}`);
    return { delivered: true, email };
  }

  async verifyAndLink(code: string, phoneNumber: string): Promise<boolean> {
    const userId = await this.redisService.get(this.otpKey(code));
    if (!userId) {
      return false;
    }

    // Upsert on the unique phone_number to close the TOCTOU race between
    // `resolvePhone` (in the caller) and this insert: two near-simultaneous
    // redemptions for a still-unlinked phone would otherwise have the second
    // insert throw on the unique constraint. This is race safety, NOT a
    // user-facing "transfer this phone to another account" feature.
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
