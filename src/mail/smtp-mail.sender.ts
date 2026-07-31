import * as nodemailer from 'nodemailer';
import { MailResult, MailSender } from './mail-sender.port';
import { RenderedEmail } from './mail.templates';

/**
 * Everything the SMTP adapter needs, passed in rather than read from
 * `secrets` — the adapter stays free of global config so it can be
 * constructed with any host (Resend, SES, a local MailHog) in a test.
 */
export interface SmtpMailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Envelope "From" applied to every message this adapter sends. */
  from: string;
}

/**
 * SMTP adapter for the {@link MailSender} port, built on nodemailer. This is
 * the ONLY file in the codebase that knows a mail transport exists.
 *
 * Works unchanged against any SMTP provider; for Resend that means
 * `smtp.resend.com` with user `resend` and the API key as password.
 *
 * The transport is built ONCE in the constructor; `secure` is derived from the
 * port (465 = implicit TLS, anything else = STARTTLS/plain).
 */
export class SmtpMailSender implements MailSender {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(config: SmtpMailConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });

    this.from = config.from;
  }

  /**
   * Delivers one rendered email. Never throws: a transport error becomes
   * `{ ok: false, error }` so `MailService` decides how to react. Logging is
   * deliberately left to `MailService`, which knows which kind of email this
   * was; duplicating it here would double every line.
   */
  async send(to: string, email: RenderedEmail): Promise<MailResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      return { ok: true, messageId: info?.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
