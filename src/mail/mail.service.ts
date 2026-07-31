import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAIL_SENDER, MailResult, MailSender } from './mail-sender.port';
import {
  renderEmailVerification,
  renderWhatsappOtp,
  RenderedEmail,
} from './mail.templates';

export { MailResult } from './mail-sender.port';

/** Default OTP validity window, in minutes, when a caller omits it. */
const DEFAULT_OTP_TTL_MINUTES = 10;

/**
 * Transactional email policy: owns WHAT gets sent and under which rules
 * (copy, default TTLs, outcome logging). Delivery is delegated to whichever
 * adapter is bound to the `MAIL_SENDER` port, so this class has no idea
 * whether the mail leaves over SMTP, an HTTP API, or a test double.
 *
 * Purpose-specific methods (`sendEmailVerification`, `sendWhatsappOtp`) own
 * their copy via the pure builders in `mail.templates.ts`.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(@Inject(MAIL_SENDER) private readonly sender: MailSender) {}

  /**
   * Confirms a user owns their email address by sending a single verification
   * link. Consumed by the auth flow after signup.
   */
  async sendEmailVerification(
    to: string,
    params: { name?: string; verificationUrl: string },
  ): Promise<MailResult> {
    return this.send(to, renderEmailVerification(params), 'email-verification');
  }

  /**
   * Sends the one-time code a user needs to confirm the phone number they are
   * linking to the WhatsApp bot. The code itself is generated/stored by the
   * calling flow — this method only delivers it.
   */
  async sendWhatsappOtp(
    to: string,
    params: { code: string; ttlMinutes?: number },
  ): Promise<MailResult> {
    const email = renderWhatsappOtp({
      code: params.code,
      ttlMinutes: params.ttlMinutes ?? DEFAULT_OTP_TTL_MINUTES,
    });
    return this.send(to, email, 'whatsapp-otp');
  }

  /**
   * Single delivery chokepoint: hands one rendered email to the port and logs
   * the outcome under its `kind`. Never throws — the port contract already
   * forbids it, and the try/catch here keeps that promise even if a future
   * adapter breaks it.
   */
  private async send(to: string, email: RenderedEmail, kind: string): Promise<MailResult> {
    try {
      const result = await this.sender.send(to, email);

      if (result.ok) {
        this.logger.log(`Sent ${kind} email to ${to} (messageId=${result.messageId ?? 'n/a'})`);
      } else {
        this.logger.error(`Failed to send ${kind} email to ${to}: ${result.error}`);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send ${kind} email to ${to}: ${message}`);
      return { ok: false, error: message };
    }
  }
}
