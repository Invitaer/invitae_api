import { Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { users } from '../database/schema/users.schema';
import { oauthAccounts } from '../database/schema/oauth-accounts.schema';
import { AuthUser, OAuthProfile } from './interfaces/auth-user.interface';

@Injectable()
export class OAuthService {
  constructor(private readonly dbService: DatabaseService) {}

  async findOrCreateUser(
    provider: 'google' | 'facebook',
    providerId: string,
    profile: OAuthProfile,
  ): Promise<AuthUser> {
    // 1. Look up existing oauth_accounts row by (provider, providerId)
    const [existingAccount] = await this.dbService.db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerId, providerId),
        ),
      );

    if (existingAccount) {
      // 2. Account found — fetch and return the linked user
      const [existingUser] = await this.dbService.db
        .select()
        .from(users)
        .where(eq(users.id, existingAccount.userId));

      return {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
      };
    }

    // 3. No oauth_accounts row — create user (no password) + oauth_accounts row
    const [newUser] = await this.dbService.db
      .insert(users)
      .values({
        email: profile.email,
        name: profile.name,
        password: null,
      })
      .onConflictDoNothing()
      .returning();

    // If user already exists by email (e.g. previously registered locally),
    // fetch the existing user record
    const userRecord = newUser ?? await this.dbService.db
      .select()
      .from(users)
      .where(eq(users.email, profile.email))
      .then(([u]) => u);

    await this.dbService.db.insert(oauthAccounts).values({
      userId: userRecord.id,
      provider,
      providerId,
      accessToken: profile.accessToken ?? null,
      refreshToken: profile.refreshToken ?? null,
    });

    return {
      id: userRecord.id,
      email: userRecord.email,
      name: userRecord.name,
    };
  }
}
