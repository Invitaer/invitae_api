import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    accessToken: varchar('access_token', { length: 512 }),
    refreshToken: varchar('refresh_token', { length: 512 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    providerProviderIdIdx: uniqueIndex('oauth_accounts_provider_provider_id_idx').on(
      table.provider,
      table.providerId,
    ),
  }),
);

export type OAuthAccount = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccount = typeof oauthAccounts.$inferInsert;
