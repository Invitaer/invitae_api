import { index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { events } from './events.schema';
import { users } from './users.schema';

export const eventUsers = pgTable(
  'event_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uqEventUser: unique('uq_event_users_event_user').on(t.eventId, t.userId),
    idxUser: index('idx_event_users_user_id').on(t.userId),
    idxEvent: index('idx_event_users_event_id').on(t.eventId),
  }),
);

export type EventUser = typeof eventUsers.$inferSelect;
export type NewEventUser = typeof eventUsers.$inferInsert;
