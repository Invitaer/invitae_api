import { UserRole } from '../database/schema';

/**
 * Roles allowed into the admin dashboard.
 *
 * A set rather than `role === ADMIN`, because the enum has three values and
 * `SUPER_ADMIN` is not a kind of `ADMIN` as far as `===` is concerned — a
 * strict equality check would lock the highest-privileged account out of the
 * panel it exists to run.
 */
const ADMIN_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.has(role);
}
