import { boolean, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { tables } from './tables.schema';

export const guests = pgTable('guests', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  email: varchar('email', { length: 255 }),
  tableId: uuid('table_id').references(() => tables.id),
  attendanceConfirmed: boolean('attendance_confirmed').default(false),
  invitationSent: boolean('invitation_sent').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Guest = typeof guests.$inferSelect;
export type NewGuest = typeof guests.$inferInsert;
