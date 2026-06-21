import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { GoogleUserStrategy } from './strategies/google-user.strategy';
import { FacebookStrategy } from './strategies/facebook.strategy';
import { FacebookUserStrategy } from './strategies/facebook-user.strategy';
import { OAuthService } from './oauth.service';
import { DatabaseModule } from '../database/database.module';
import { CryptoModule } from '../crypto/crypto.module';
import { secrets } from '../config/secrets';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: secrets.JWT_SECRET,
      signOptions: { expiresIn: '7d' },
    }),
    DatabaseModule,
    CryptoModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, GoogleStrategy, GoogleUserStrategy, FacebookStrategy, FacebookUserStrategy, OAuthService],
  exports: [AuthService],
})
export class AuthModule {}
