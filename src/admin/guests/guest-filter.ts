import { and, eq, ilike, or, SQL } from 'drizzle-orm';
import { guests } from '../../database/schema';

/**
 * Escapes LIKE/ILIKE metacharacters (`\`, `%`, `_`) so user input is matched
 * literally instead of being interpreted as a wildcard pattern. The value is
 * still passed to Drizzle's parameterized `ilike` (injection-safe); this only
 * fixes match semantics for terms containing `%` or `_`.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Shared filter builder for guest queries. MUST be reused by every consumer
 * (paginated find, matching-ids, notify-all, notify-pending) so the applied
 * filter can never drift between the data query, the count query, and the
 * notification recipient resolution.
 *
 * Search matches `name`, `email`, and the primary `phone` only.
 * `guest_phones` (additionalPhones) is explicitly out of scope for v1.
 * A whitespace-only search is treated as no search.
 */
export function buildGuestFilter(eventId: string, search?: string): SQL | undefined {
  const trimmed = search?.trim();

  let searchFilter: SQL | undefined;
  if (trimmed) {
    const pattern = `%${escapeLike(trimmed)}%`;
    searchFilter = or(
      ilike(guests.name, pattern),
      ilike(guests.email, pattern),
      ilike(guests.phone, pattern),
    );
  }

  return and(eq(guests.eventId, eventId), searchFilter);
}
