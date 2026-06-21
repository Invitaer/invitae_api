import { pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export const userRoleEnum = pgEnum('user_role', [
  UserRole.ADMIN,
  UserRole.USER,
  UserRole.SUPER_ADMIN,
]);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password: varchar('password', { length: 255 }),
  name: varchar('name', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default(UserRole.USER),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
