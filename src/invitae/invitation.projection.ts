import { Event } from '../database/schema';
import { InvitationDto, InvitationSectionDto } from '../admin/content/dto/invitation.dto';

/**
 * Read-time projection of the DB event row over the stored invitation content.
 *
 * The `events` table owns identity, name, date and type; Redis owns presentation.
 * Where the two overlap, these pure functions re-derive the overlapping fields on
 * every read, so stored content can never drift away from the row.
 *
 * TIMEZONE CONTRACT: `events.date` is a `timestamp` WITHOUT timezone, and drizzle
 * maps it as UTC both ways (writes `toISOString()`, reads `value + "+0000"`). The
 * stored wall clock therefore lives in the UTC components of the Date. Every
 * formatter below reads it with UTC getters (`getUTCFullYear`, `getUTCMonth`, ...).
 * Never use local getters or `Intl` without `timeZone: 'UTC'` here: both shift the
 * wall clock by the host offset (UTC-6 in America/Mexico_City renders a stored
 * midnight on the previous day).
 */

/** Explicit lookup tables — output must not depend on host ICU/locale data. */
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function monthName(d: Date): string {
  return capitalize(MONTHS[d.getUTCMonth()]);
}

function weekdayName(d: Date): string {
  return capitalize(WEEKDAYS[d.getUTCDay()]);
}

/** `'Domingo, 24 de Octubre 2027'` — hero headline date. */
export function formatLongDate(d: Date): string {
  return `${weekdayName(d)}, ${d.getUTCDate()} de ${monthName(d)} ${d.getUTCFullYear()}`;
}

/** `'Domingo 24 de Octubre, 2027'` — ceremony/reception venue date. */
export function formatVenueDate(d: Date): string {
  return `${weekdayName(d)} ${d.getUTCDate()} de ${monthName(d)}, ${d.getUTCFullYear()}`;
}

/** `'Octubre · 2027'` — hero side label. */
export function formatSideLabel(d: Date): string {
  return `${monthName(d)} · ${d.getUTCFullYear()}`;
}

/**
 * `'2027-10-24T00:00:00'` — countdown target. No offset suffix on purpose: the
 * guest's browser reads it as its own local time, so it counts down to the same
 * wall clock that was stored.
 */
export function formatLocalIso(d: Date): string {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  return `${date}T${time}`;
}

/** `'2027'` — footer copyright year. */
export function formatYear(d: Date): string {
  return String(d.getUTCFullYear());
}

/**
 * `events.name` is admin-facing (`'Susan Y Nacho'`); the invitation displays
 * `'Susan & Nacho'`. Only a STANDALONE connector word is normalized, so a `y`/`Y`
 * inside a name (`'Yolanda'`, `'Yahir'`) is never touched.
 */
export function formatCelebrantNames(eventName: string): string {
  return eventName.replace(/\s+[yY]\s+/g, ' & ');
}

/** Section types whose data carries fields derived from the event row. */
type DerivedSectionType =
  | 'hero'
  | 'countdown'
  | 'ceremony'
  | 'reception'
  | 'footer';

/**
 * Per-section-type derivation. Only the listed keys are overwritten; every other
 * key in `data` is preserved. Notably absent: `hero.eventType` (a display label
 * such as `'Boda'`, not the DB key `'wedding'`) and ceremony/reception
 * `time`/`place`/`venue`/`address`, for which the `events` row has no source.
 */
const DERIVATIONS: Record<
  DerivedSectionType,
  (event: Event) => Record<string, string>
> = {
  hero: (event) => ({
    celebrantNames: formatCelebrantNames(event.name),
    eventDate: formatLongDate(event.date),
    sideLabel: formatSideLabel(event.date),
  }),
  countdown: (event) => ({ targetDate: formatLocalIso(event.date) }),
  ceremony: (event) => ({ date: formatVenueDate(event.date) }),
  reception: (event) => ({ date: formatVenueDate(event.date) }),
  footer: (event) => ({
    coupleNames: formatCelebrantNames(event.name),
    year: formatYear(event.date),
  }),
};

function projectSection(
  section: InvitationSectionDto,
  event: Event,
): InvitationSectionDto {
  const derive = DERIVATIONS[section?.type as DerivedSectionType];
  if (!derive) return section;

  // Tolerate an unexpected `data` shape rather than throwing: a malformed stored
  // section must not take down the whole public invitation.
  const base =
    section.data && typeof section.data === 'object' && !Array.isArray(section.data)
      ? section.data
      : {};

  return { ...section, data: { ...base, ...derive(event) } };
}

/**
 * Returns a NEW invitation with the event-derived fields overwritten. The input is
 * never mutated — the caller's parsed Redis payload stays untouched.
 */
export function projectInvitation(
  content: InvitationDto,
  event: Event,
): InvitationDto {
  return {
    ...content,
    metadata: {
      ...content.metadata,
      slug: event.slug,
      eventType: event.eventType,
    },
    // Same defensive standard as `data` above: the stored payload is not
    // re-validated at read time, so a `sections` container of any shape other
    // than an array degrades to an empty list rather than throwing a TypeError
    // that would 500 the PUBLIC, unauthenticated invitation endpoints.
    sections: (Array.isArray(content.sections) ? content.sections : []).map(
      (section) => projectSection(section, event),
    ),
  };
}
