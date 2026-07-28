/**
 * Manual e2e helper — sends a REAL WhatsApp-OTP email through the configured
 * SMTP (MAIL_* in .env.local), reusing the exact production code path
 * (`MailService.sendWhatsappOtp`). It does NOT touch Redis, the DB, or auth —
 * it isolates the "does the email actually arrive?" question.
 *
 * Run from the invitae_api directory:
 *   npx ts-node scripts/send-test-otp.ts you@example.com
 * If no address is given it falls back to MAIL_USER.
 */
import '../src/config/env-loader';
import { randomInt } from 'crypto';
import { MailService } from '../src/mail/mail.service';
import { SmtpMailSender } from '../src/mail/smtp-mail.sender';
import { secrets } from '../src/config/secrets';

async function main(): Promise<void> {
  const to = process.argv[2] || secrets.MAIL_USER;
  const code = String(randomInt(100000, 1000000));

  console.log(`Sending test WhatsApp OTP ${code} to ${to} via ${secrets.MAIL_HOST}:${secrets.MAIL_PORT} ...`);

  // Mirrors the wiring in MailModule so this script exercises the same
  // adapter the app uses, without booting a Nest context.
  const mail = new MailService(
    new SmtpMailSender({
      host: secrets.MAIL_HOST,
      port: parseInt(secrets.MAIL_PORT, 10),
      user: secrets.MAIL_USER,
      pass: secrets.MAIL_PASS,
      from: secrets.MAIL_FROM?.trim() || secrets.MAIL_USER,
    }),
  );
  const result = await mail.sendWhatsappOtp(to, { code, ttlMinutes: 5 });

  if (result.ok) {
    console.log(`OK — delivered (messageId=${result.messageId ?? 'n/a'}). Check the inbox for code ${code}.`);
    process.exit(0);
  } else {
    console.error(`FAILED — ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
