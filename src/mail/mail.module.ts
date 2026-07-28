import { Module } from '@nestjs/common';
import { secrets } from '../config/secrets';
import { MAIL_SENDER } from './mail-sender.port';
import { MailService } from './mail.service';
import { SmtpMailSender } from './smtp-mail.sender';

/**
 * Exposes the transactional-email sender. Import this module (and inject
 * `MailService`) wherever an email must be sent — currently the auth flow
 * (account confirmation) and the WhatsApp number verification (OTP) flow.
 *
 * This is the composition root for mail: the ONLY place that reads `MAIL_*`
 * secrets and decides which adapter satisfies the `MAIL_SENDER` port. To move
 * to a different provider over SMTP, change the environment; to move to a
 * non-SMTP provider, bind a different adapter here. Nothing else changes.
 */
@Module({
  providers: [
    {
      provide: MAIL_SENDER,
      useFactory: () =>
        new SmtpMailSender({
          host: secrets.MAIL_HOST,
          port: parseInt(secrets.MAIL_PORT, 10),
          user: secrets.MAIL_USER,
          pass: secrets.MAIL_PASS,
          // Fall back to the authenticated user when no explicit envelope
          // From is set.
          from: secrets.MAIL_FROM?.trim() || secrets.MAIL_USER,
        }),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
