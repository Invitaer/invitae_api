/**
 * Pure parser for the guest RSVP button namespace: `guest_rsvp_yes:{guestId}`
 * / `guest_rsvp_no:{guestId}`. Deliberately separate from `command.parser.ts`
 * — keeping the organizer surface byte-identical is the cheapest possible
 * regression guarantee (see `sdd/guest-whatsapp-notify/design` decision D4).
 *
 * The prefixes are disjoint from the organizer `confirmar:{id}` /
 * `rechazar:{id}` namespace (`command.parser.ts`), so there is no ambiguity
 * between the two button namespaces.
 */

const GUEST_RSVP_PATTERN =
  /^guest_rsvp_(yes|no):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export interface GuestRsvpMatch {
  guestId: string;
  status: 'ACCEPTED' | 'DECLINED';
}

/**
 * Returns the matched `{ guestId, status }` pair when `id` is a
 * well-formed guest RSVP button id, or `undefined` for anything else —
 * including a malformed (non-UUID-shaped) guestId, which the regex rejects
 * before it can ever reach the database.
 */
export function parseGuestRsvp(id: string): GuestRsvpMatch | undefined {
  const match = id?.match(GUEST_RSVP_PATTERN);
  if (!match) {
    return undefined;
  }

  const [, action, guestId] = match;
  return { guestId, status: action === 'yes' ? 'ACCEPTED' : 'DECLINED' };
}
