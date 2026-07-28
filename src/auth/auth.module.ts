import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAdminStrategy, JwtUserStrategy } from './jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { GoogleUserStrategy } from './strategies/google-user.strategy';
import { FacebookStrategy } from './strategies/facebook.strategy';
import { FacebookUserStrategy } from './strategies/facebook-user.strategy';
import { OAuthService } from './oauth.service';
import { DatabaseModule } from '../database/database.module';
import { CryptoModule } from '../crypto/crypto.module';
import { EmailVerificationModule } from './email-verification.module';
import { secrets } from '../config/secrets';

@Module({
  imports: [
    // No default strategy on purpose: every guarded route must name the
    // audience it belongs to, so there is nothing sensible to default to.
    PassportModule,
    JwtModule.register({
      secret: secrets.JWT_SECRET,
      signOptions: { expiresIn: '7d' },
    }),
    DatabaseModule,
    CryptoModule,
    EmailVerificationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAdminStrategy,
    JwtUserStrategy,
    GoogleStrategy,
    GoogleUserStrategy,
    FacebookStrategy,
    FacebookUserStrategy,
    OAuthService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
