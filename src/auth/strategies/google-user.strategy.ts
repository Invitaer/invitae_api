import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { OAuthService } from '../oauth.service';
import { AuthUser } from '../interfaces/auth-user.interface';

@Injectable()
export class GoogleUserStrategy extends PassportStrategy(Strategy, 'google-user') {
  constructor(private readonly oauthService: OAuthService) {
    super({
      clientID: process.env.GOOGLE_CLIENT_ID || 'GOOGLE_CLIENT_ID_PLACEHOLDER',
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET || 'GOOGLE_CLIENT_SECRET_PLACEHOLDER',
      callbackURL:
        process.env.GOOGLE_USER_CALLBACK_URL ||
        'http://localhost:3000/auth/google/user/callback',
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
  ): Promise<AuthUser> {
    return this.oauthService.findOrCreateUser('google', profile.id, {
      email: profile.emails[0].value,
      name: profile.displayName,
    });
  }
}
