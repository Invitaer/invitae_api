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
        role: existingUser.role,
      };
    }

    // 3. No oauth_accounts row — create user (no password) + oauth_accounts row
    const [newUser] = await this.dbService.db
      .insert(users)
      .values({
        email: profile.email,
        name: profile.name,
        password: null,
        // Google/Facebook already proved the user controls this mailbox, so
        // there is nothing left for us to confirm. Without this stamp an OAuth
        // account would be born unconfirmed and could never be fixed: the
        // confirmation email is only ever sent from the password signup paths.
        emailVerifiedAt: new Date(),
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

    // The address was already registered with a password and never confirmed.
    // The provider vouches for it now, so release the account instead of
    // leaving it locked out of password login forever.
    if (!userRecord.emailVerifiedAt) {
      await this.dbService.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, userRecord.id));
    }

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
      role: userRecord.role,
    };
  }
}
