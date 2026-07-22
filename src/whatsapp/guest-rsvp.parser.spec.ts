import { parseGuestRsvp } from './guest-rsvp.parser';

const VALID_GUEST_ID = '11111111-1111-4111-8111-111111111111';

describe('parseGuestRsvp', () => {
  it('matches a valid "guest_rsvp_yes:{uuid}" id as an ACCEPTED match', () => {
    expect(parseGuestRsvp(`guest_rsvp_yes:${VALID_GUEST_ID}`)).toEqual({
      guestId: VALID_GUEST_ID,
      status: 'ACCEPTED',
    });
  });

  it('matches a valid "guest_rsvp_no:{uuid}" id as a DECLINED match', () => {
    expect(parseGuestRsvp(`guest_rsvp_no:${VALID_GUEST_ID}`)).toEqual({
      guestId: VALID_GUEST_ID,
      status: 'DECLINED',
    });
  });

  it.each([
    ['a non-UUID guestId', `guest_rsvp_yes:not-a-uuid`],
    ['a SQL-ish payload', `guest_rsvp_yes:'; DROP TABLE guests;--`],
    ['an oversized id', `guest_rsvp_yes:${'a'.repeat(500)}`],
    ['the organizer confirmar namespace (no collision)', 'confirmar:guest-uuid-9'],
    ['the organizer rechazar namespace (no collision)', 'rechazar:guest-uuid-9'],
    ['unrelated plain text', 'hola'],
    ['an empty string', ''],
  ])('returns undefined for %s', (_label, id) => {
    expect(parseGuestRsvp(id)).toBeUndefined();
  });
});
