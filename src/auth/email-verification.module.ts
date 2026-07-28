import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { EmailVerificationService } from './email-verification.service';

/**
 * Exposes `EmailVerificationService` on its own, separate from `AuthModule`.
 *
 * Two unrelated modules mint confirmation links: `AuthModule` (self-signup)
 * and `AdminUsersModule` (an admin creating an account for someone). Exporting
 * the service from `AuthModule` would force `AdminUsersModule` to import the
 * whole authentication stack — passport strategies, the JWT module, the OAuth
 * service — just to send one email, and would put an admin feature downstream
 * of every future `AuthModule` dependency.
 *
 * Only `MailModule` is imported: `DatabaseModule` and `RedisModule` are
 * `@Global`, so this module stays deliberately thin and cannot participate in
 * a dependency cycle.
 */
@Module({
  imports: [MailModule],
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class EmailVerificationModule {}
