import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

export const whatsappLinks = pgTable('whatsapp_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  phoneNumber: varchar('phone_number', { length: 20 }).notNull().unique(),
  verifiedAt: timestamp('verified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type WhatsappLink = typeof whatsappLinks.$inferSelect;
export type NewWhatsappLink = typeof whatsappLinks.$inferInsert;
