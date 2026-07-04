/**
 * T1.1 — Schema spec: validates rsvpStatus column presence and RsvpStatus enum
 *
 * These tests verify the TypeScript schema definition (not a live DB migration).
 * They confirm that:
 *   - rsvpStatus column is present in the schema
 *   - attendanceConfirmed column is NOT present
 *   - RsvpStatus enum exports the expected UPPERCASE values
 *   - tickets and tableNumber columns are present
 */

import { guests, RsvpStatus } from './guests.schema';
import { guestPhones } from './guest-phones.schema';

describe('guests schema — rsvp_status column', () => {
  it('guests table has rsvpStatus column definition', () => {
    const columns = Object.keys(guests);
    expect(columns).toContain('rsvpStatus');
  });

  it('guests table does NOT have attendanceConfirmed column', () => {
    const columns = Object.keys(guests);
    expect(columns).not.toContain('attendanceConfirmed');
  });

  it('RsvpStatus enum has PENDING value', () => {
    expect(RsvpStatus.PENDING).toBe('PENDING');
  });

  it('RsvpStatus enum has ACCEPTED value', () => {
    expect(RsvpStatus.ACCEPTED).toBe('ACCEPTED');
  });

  it('RsvpStatus enum has DECLINED value', () => {
    expect(RsvpStatus.DECLINED).toBe('DECLINED');
  });

  it('guests table has tickets column definition', () => {
    const columns = Object.keys(guests);
    expect(columns).toContain('tickets');
  });

  it('guests table has tableNumber column definition', () => {
    const columns = Object.keys(guests);
    expect(columns).toContain('tableNumber');
  });
});

describe('guest_phones schema', () => {
  it('guestPhones table has guestId column', () => {
    expect(Object.keys(guestPhones)).toContain('guestId');
  });

  it('guestPhones table has phone column', () => {
    expect(Object.keys(guestPhones)).toContain('phone');
  });
});
