import { Module } from '@nestjs/common';
import { EmailVerificationModule } from '../../auth/email-verification.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  // Only the verification slice of auth, never `AuthModule` itself — creating a
  // user must not drag passport, JWT and OAuth into this module.
  imports: [EmailVerificationModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
  exports: [AdminUsersService],
})
export class AdminUsersModule {}
