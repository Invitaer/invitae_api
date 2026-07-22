import { normalizeWhatsappRecipient } from './phone.util';

describe('normalizeWhatsappRecipient', () => {
  describe('Mexico (country code 52)', () => {
    it('strips the extra "1" from a Mexican wa_id (521 + 10 digits)', () => {
      expect(normalizeWhatsappRecipient('5213319638873')).toBe('523319638873');
    });

    it('leaves an already-normalized Mexican number (52 + 10 digits) unchanged', () => {
      expect(normalizeWhatsappRecipient('523319638873')).toBe('523319638873');
    });
  });

  describe('Argentina (country code 54)', () => {
    it('strips the extra "9" from an Argentine wa_id (549 + 10 digits)', () => {
      expect(normalizeWhatsappRecipient('5491122334455')).toBe('541122334455');
    });

    it('leaves an already-normalized Argentine number (54 + 10 digits) unchanged', () => {
      expect(normalizeWhatsappRecipient('541122334455')).toBe('541122334455');
    });
  });

  it('is idempotent: normalizing twice equals normalizing once', () => {
    const waId = '5213319638873';
    const once = normalizeWhatsappRecipient(waId);
    expect(normalizeWhatsappRecipient(once)).toBe(once);
  });

  it('strips formatting characters (+, spaces, dashes) and returns digits only', () => {
    expect(normalizeWhatsappRecipient('+52 1 33 1963-8873')).toBe('523319638873');
  });

  it('leaves numbers from countries without the extra-digit quirk untouched', () => {
    // United States: 1 + 10 digits, no wa_id extra digit.
    expect(normalizeWhatsappRecipient('16315551181')).toBe('16315551181');
  });

  it('does not mistake a Brazilian number (55) for the AR/MX rule', () => {
    // Brazil mobiles legitimately carry a leading 9 that MUST be kept.
    expect(normalizeWhatsappRecipient('5511987654321')).toBe('5511987654321');
  });

  it('only strips when the length matches the 13-digit wa_id pattern', () => {
    // Starts with 521 but is not a 13-digit MX wa_id -> left untouched.
    expect(normalizeWhatsappRecipient('5219999')).toBe('5219999');
  });

  it('handles empty and nullish input safely', () => {
    expect(normalizeWhatsappRecipient('')).toBe('');
    expect(normalizeWhatsappRecipient(undefined as unknown as string)).toBe('');
  });
});
