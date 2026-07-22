/**
 * Approved MARKETING template used to reach guests OUTSIDE the 24h customer
 * service window (cold outbound). Free-form messages fail there with Graph
 * `131047`; only a pre-approved template gets through.
 *
 * The name and language MUST byte-match the template approved in Meta
 * Business Manager — a mismatch is rejected at send time, so this lives in
 * version control (reviewable, no silent per-environment drift) rather than
 * in env/secrets. It is not a secret.
 *
 * Approved body (3 positional parameters, two quick-reply buttons):
 *   "Hola {{1}}, {{2}} te ha invitado a su evento. {{3}}"
 *   buttons: "Asistiré" / "No podré asistir"
 *   {{1}} = guest name, {{2}} = inviter name, {{3}} = DEFAULT_INVITE_MESSAGE
 */
export const GUEST_INVITE_TEMPLATE_NAME = 'guest_invite_rsvp';

export const GUEST_INVITE_TEMPLATE_LANG = 'es';

/**
 * {{3}} is a fixed server-side constant in this slice — never user input.
 * A per-event custom message is Phase 3 of the parent change (dashboard UI).
 */
export const DEFAULT_INVITE_MESSAGE = 'Esperamos que puedas acompañarnos';

/** Graph 132005 — the substituted body must stay under 1024 characters. */
export const MAX_TEMPLATE_PARAM_LENGTH = 1024;

/** Graph 132012 — parameters may not contain newlines, tabs, or 4+ spaces. */
const FORBIDDEN_PARAM_SHAPE = /[\n\r\t]| {4,}/;

/**
 * Pre-send guard for a template body parameter. Returning `false` lets the
 * caller fail fast with `TEMPLATE_PARAM_INVALID` instead of burning a Graph
 * round-trip on a rejection whose remedy is "fix the copy", not "retry".
 */
export function validateTemplateParam(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (value.length >= MAX_TEMPLATE_PARAM_LENGTH) return false;
  return !FORBIDDEN_PARAM_SHAPE.test(value);
}
