import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { secrets } from '../config/secrets';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users.schema';
import { MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';

/**
 * How long a confirmation link stays usable. Generous on purpose — the user
 * may open the email hours later on another device, and the only cost of a
 * long window is a Redis key. `POST /auth/resend-verification` covers whoever
 * misses it anyway.
 */
export const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Minimum gap between two resend requests for the same address. Without it the
 * endpoint is an open relay: it is unauthenticated by necessity (a user who
 * cannot log in has to reach it), so anyone could use it to mail-bomb a third
 * party through our SMTP reputation.
 */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * 32 bytes of CSPRNG entropy, hex-encoded. This token is a bearer credential —
 * whoever holds it can confirm the account — so it must be unguessable, which
 * rules out `Math.random`, timestamps and sequential ids.
 */
const TOKEN_BYTES = 32;

/** Fallback when API_PUBLIC_URL is unset (local development). */
const DEFAULT_API_URL = 'http://localhost:3000';

export type VerificationSendResult = { ok: true } | { ok: false; error: string };

/**
 * Owns the "prove you own this address" flow end to end: minting the token,
 * delivering it, and redeeming it.
 *
 * Kept out of `AuthService` deliberately. Authentication answers "are you who
 * you say you are, right now"; this answers "does this mailbox belong to you",
 * which is a different question with a different lifetime and different
 * collaborators (Redis + Mail rather than JWT + Crypto). Folding it in would
 * push `AuthService` to five dependencies and two reasons to change.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly mailService: MailService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Mints a single-use token, stores it against the user id and emails the
   * link. Returns an outcome instead of throwing, mirroring `MailSender`: the
   * caller (a signup) decides whether a delivery failure should fail the whole
   * request or just be logged.
   *
   * On failure the token is deleted — leaving it alive would keep a valid
   * confirmation link in Redis that nobody ever received.
   */
  async sendFor(user: {
    id: string;
    email: string;
    name?: string;
  }): Promise<VerificationSendResult> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const key = this.tokenKey(token);

    await this.redisService.set(key, user.id, VERIFICATION_TTL_SECONDS);

    try {
      const sent = await this.mailService.sendEmailVerification(user.email, {
        name: user.name,
        verificationUrl: this.buildVerificationUrl(token),
      });

      if (!sent.ok) {
        await this.discardToken(key);
        this.logger.error(
          `Failed to email verification to ${user.email}: ${sent.error}`,
        );
        return { ok: false, error: sent.error };
      }

      this.logger.log(`Verification email sent to ${user.email}`);
      return { ok: true };
    } catch (err) {
      // `MailService` already promises not to throw, but this service is called
      // from signup paths where an escaping error would 500 a request whose
      // user row was ALREADY created — leaving an account nobody can confirm.
      const message = err instanceof Error ? err.message : String(err);
      await this.discardToken(key);
      this.logger.error(`Failed to email verification to ${user.email}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Redeems a token: stamps `emailVerifiedAt` and consumes the token so the
   * link cannot be replayed. Returns `false` for an unknown, expired or
   * already-used token — the caller must NOT distinguish those cases to the
   * visitor, since doing so would confirm which tokens once existed.
   *
   * The token is deleted only after a successful update. Deleting first would
   * burn the user's only link if the write then failed.
   */
  async verify(token: string): Promise<boolean> {
    const key = this.tokenKey(token);
    const userId = await this.redisService.get(key);

    if (!userId) {
      return false;
    }

    const [updated] = await this.databaseService.db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (!updated) {
      // Token was valid but the account is gone (deleted between signup and
      // click). Drop the token so it stops occupying a slot.
      await this.discardToken(key);
      return false;
    }

    await this.discardToken(key);
    return true;
  }

  /**
   * Re-sends the confirmation link for an address, if and only if it belongs
   * to a registered account that is still unconfirmed.
   *
   * Returns nothing and never throws, on purpose. The endpoint in front of it
   * is unauthenticated, so ANY observable difference — a status code, an error
   * body, even a timing gap — would turn it into an oracle for "is this
   * address registered here". The caller answers the same 202 in every case.
   */
  async resendTo(email: string): Promise<void> {
    try {
      const [user] = await this.databaseService.db
        .select()
        .from(users)
        .where(eq(users.email, email));

      if (!user || user.emailVerifiedAt) {
        // Unknown address, or already confirmed — nothing to send. Confirmed
        // accounts are skipped so this cannot be used to spam someone whose
        // signup already completed.
        return;
      }

      await this.sendFor({ id: user.id, email: user.email, name: user.name });
    } catch (err) {
      this.logger.error(
        `Failed to resend verification`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Rate-limit gate for resends. Returns `true` when the caller may send, and
   * `false` while the cooldown for that address is still active. Implemented
   * with `setNX` so the check and the claim are one atomic operation — two
   * concurrent requests can never both win.
   */
  async claimResendSlot(email: string): Promise<boolean> {
    return this.redisService.setNX(
      `auth:verify:cooldown:${email.toLowerCase()}`,
      '1',
      RESEND_COOLDOWN_SECONDS,
    );
  }

  private tokenKey(token: string): string {
    return `auth:verify:${token}`;
  }

  /**
   * The link points at the API, NOT the dashboard: the click arrives from a
   * mail client with no session, so it has to hit the one process that can
   * redeem the token. `GET /auth/verify-email` redirects to the dashboard
   * afterwards, which keeps the whole flow working without any frontend code.
   */
  private buildVerificationUrl(token: string): string {
    const base = secrets.API_PUBLIC_URL || DEFAULT_API_URL;
    return `${base.replace(/\/$/, '')}/auth/verify-email?token=${token}`;
  }

  /**
   * Best-effort token cleanup. A Redis failure here must never turn into the
   * caller's error: the token expires on its own within
   * `VERIFICATION_TTL_SECONDS` regardless.
   */
  private async discardToken(key: string): Promise<void> {
    try {
      await this.redisService.del(key);
    } catch (err) {
      this.logger.error(
        `Failed to discard verification token`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
