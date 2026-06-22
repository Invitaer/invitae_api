import { pgEnum, pgTable, timestamp, uuid, varchar, boolean } from 'drizzle-orm/pg-core';
import { tables } from './tables.schema';
import { events } from './events.schema';

export enum RsvpStatus {
  PENDING  = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

export const rsvpStatusEnum = pgEnum('rsvp_status', ['PENDING', 'ACCEPTED', 'DECLINED']);

export const guests = pgTable('guests', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  email: varchar('email', { length: 255 }),
  tableId: uuid('table_id').references(() => tables.id),
  rsvpStatus: rsvpStatusEnum('rsvp_status').notNull().default('PENDING'),
  invitationSent: boolean('invitation_sent').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Guest = typeof guests.$inferSelect;
export type NewGuest = typeof guests.$inferInsert;
