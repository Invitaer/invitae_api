/**
 * Schema spec: validates the `users` email-verification column.
 *
 * These tests verify the TypeScript schema definition (not a live DB
 * migration). `emailVerifiedAt` MUST stay nullable: a null value is what
 * marks an account as unconfirmed, and `AuthService.login` refuses those.
 */

import { users } from './users.schema';

describe('users schema', () => {
  it('users table has emailVerifiedAt column definition', () => {
    const columns = Object.keys(users);
    expect(columns).toContain('emailVerifiedAt');
  });

  it('emailVerifiedAt is nullable — null is what marks an unconfirmed account', () => {
    expect(users.emailVerifiedAt.notNull).toBe(false);
  });

  it('emailVerifiedAt has no default — a new account starts unconfirmed', () => {
    expect(users.emailVerifiedAt.hasDefault).toBe(false);
  });
});
