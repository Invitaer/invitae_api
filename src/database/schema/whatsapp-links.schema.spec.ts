/**
 * Task 1.1 — Schema spec: validates whatsapp_links column presence.
 *
 * These tests verify the TypeScript schema definition (not a live DB migration).
 * They confirm that:
 *   - id, userId, phoneNumber, verifiedAt, createdAt columns are present
 *   - phoneNumber has a unique constraint (declarative check via config)
 */

import { whatsappLinks } from './whatsapp-links.schema';

describe('whatsappLinks schema', () => {
  it('whatsappLinks table has id column definition', () => {
    const columns = Object.keys(whatsappLinks);
    expect(columns).toContain('id');
  });

  it('whatsappLinks table has userId column definition', () => {
    const columns = Object.keys(whatsappLinks);
    expect(columns).toContain('userId');
  });

  it('whatsappLinks table has phoneNumber column definition', () => {
    const columns = Object.keys(whatsappLinks);
    expect(columns).toContain('phoneNumber');
  });

  it('whatsappLinks table has verifiedAt column definition', () => {
    const columns = Object.keys(whatsappLinks);
    expect(columns).toContain('verifiedAt');
  });

  it('whatsappLinks table has createdAt column definition', () => {
    const columns = Object.keys(whatsappLinks);
    expect(columns).toContain('createdAt');
  });

  it('phoneNumber column is configured as unique', () => {
    expect(whatsappLinks.phoneNumber.isUnique).toBe(true);
  });
});
