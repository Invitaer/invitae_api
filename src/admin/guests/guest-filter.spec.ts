import { and, eq, ilike, or } from 'drizzle-orm';
import { guests } from '../../database/schema';
import { buildGuestFilter } from './guest-filter';

describe('buildGuestFilter', () => {
  it('returns only the eventId condition when no search is provided', () => {
    const filter = buildGuestFilter('event-uuid-1');
    const expected = and(eq(guests.eventId, 'event-uuid-1'), undefined);

    expect(filter).toEqual(expected);
  });

  it('returns only the eventId condition when search is an empty string', () => {
    const filter = buildGuestFilter('event-uuid-1', '');
    const expected = and(eq(guests.eventId, 'event-uuid-1'), undefined);

    expect(filter).toEqual(expected);
  });

  it('combines eventId with a case-insensitive OR over name/email/phone when search is provided', () => {
    const filter = buildGuestFilter('event-uuid-1', 'john');
    const expected = and(
      eq(guests.eventId, 'event-uuid-1'),
      or(
        ilike(guests.name, '%john%'),
        ilike(guests.email, '%john%'),
        ilike(guests.phone, '%john%'),
      ),
    );

    expect(filter).toEqual(expected);
  });

  it('produces a DIFFERENT filter for a different search term (proves real interpolation, not a hardcoded fake)', () => {
    const filterJohn = buildGuestFilter('event-uuid-1', 'john');
    const filterAlice = buildGuestFilter('event-uuid-1', 'alice');

    expect(filterJohn).not.toEqual(filterAlice);
  });

  it('treats a whitespace-only search as no search', () => {
    const filter = buildGuestFilter('event-uuid-1', '   ');
    const expected = and(eq(guests.eventId, 'event-uuid-1'), undefined);

    expect(filter).toEqual(expected);
  });

  it('trims surrounding whitespace before matching', () => {
    const padded = buildGuestFilter('event-uuid-1', '  john  ');
    const clean = buildGuestFilter('event-uuid-1', 'john');

    expect(padded).toEqual(clean);
  });

  it('escapes LIKE wildcards (% and _) so they match literally', () => {
    const filter = buildGuestFilter('event-uuid-1', '50%_off');
    const expected = and(
      eq(guests.eventId, 'event-uuid-1'),
      or(
        ilike(guests.name, '%50\\%\\_off%'),
        ilike(guests.email, '%50\\%\\_off%'),
        ilike(guests.phone, '%50\\%\\_off%'),
      ),
    );

    expect(filter).toEqual(expected);
  });
});
