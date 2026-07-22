/**
 * Normalizes a phone number into the digits-only format the WhatsApp Cloud API
 * accepts as a message RECIPIENT.
 *
 * Some countries are assigned a `wa_id` that carries an extra digit which is
 * NOT valid as a send target — replying to the inbound `from`/`wa_id` verbatim
 * makes Meta reject the send with HTTP 400 (#131030 "Recipient phone number not
 * in allowed list"):
 *   - Mexico (52):    wa_id is `52` + `1` + 10 national digits; send to `52` + 10.
 *   - Argentina (54): wa_id is `54` + `9` + 10 national digits; send to `54` + 10.
 *
 * Every other number is returned digits-only and otherwise untouched. The
 * function is idempotent: an already-normalized number passes through unchanged.
 *
 * To support another country with the same quirk, add a rule below keyed on its
 * 13-digit wa_id prefix.
 */
export function normalizeWhatsappRecipient(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('521')) {
    return `52${digits.slice(3)}`;
  }

  if (digits.length === 13 && digits.startsWith('549')) {
    return `54${digits.slice(3)}`;
  }

  return digits;
}
