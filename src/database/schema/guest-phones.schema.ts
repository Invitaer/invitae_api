import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { guests } from './guests.schema';

export const guestPhones = pgTable('guest_phones', {
  id: uuid('id').defaultRandom().primaryKey(),
  guestId: uuid('guest_id')
    .notNull()
    .references(() => guests.id, { onDelete: 'cascade' }),
  phone: varchar('phone', { length: 20 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type GuestPhone = typeof guestPhones.$inferSelect;
export type NewGuestPhone = typeof guestPhones.$inferInsert;
