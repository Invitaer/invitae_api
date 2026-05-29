import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-facebook';
import { OAuthService } from '../oauth.service';
import { AuthUser } from '../interfaces/auth-user.interface';

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  constructor(private readonly oauthService: OAuthService) {
    super({
      clientID:
        process.env.FACEBOOK_APP_ID || 'FACEBOOK_APP_ID_PLACEHOLDER',
      clientSecret:
        process.env.FACEBOOK_APP_SECRET || 'FACEBOOK_APP_SECRET_PLACEHOLDER',
      callbackURL:
        process.env.FACEBOOK_CALLBACK_URL ||
        'https://localhost:3000/auth/facebook/callback',
      profileFields: ['id', 'emails', 'name', 'displayName'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
  ): Promise<AuthUser> {
    return this.oauthService.findOrCreateUser('facebook', profile.id, {
      email: profile.emails[0].value,
      name: profile.displayName,
    });
  }
}
