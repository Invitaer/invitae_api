import { RenderedEmail } from "./mail.templates";

/**
 * Outcome of a mail send. Mirrors the "return an outcome, never throw"
 * contract used by `NotificationsService`/`WhatsappClient` so a caller (an
 * auth flow, an OTP flow) can branch on delivery without a try/catch — a mail
 * failure must never crash the request that triggered it.
 */
export type MailResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string };

/**
 * Outbound port for transactional email delivery. `MailService` owns WHAT is
 * sent (copy, TTLs, logging); an adapter behind this port owns HOW it leaves
 * the process. Swapping provider means providing a different adapter for
 * `MAIL_SENDER` — no consumer of `MailService` changes.
 *
 * Implementations MUST NOT throw: every failure is mapped to
 * `{ ok: false, error }` so the contract stays uniform across providers.
 */
export interface MailSender {
  send(to: string, email: RenderedEmail): Promise<MailResult>;
}

/** DI token for the {@link MailSender} port. */
export const MAIL_SENDER = 'MAIL_SENDER';
