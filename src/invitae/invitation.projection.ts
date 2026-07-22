import { Event } from '../database/schema';
import { InvitationDto, InvitationSectionDto } from '../admin/content/dto/invitation.dto';

/**
 * Read-time projection of the DB event row over the stored invitation content.
 *
 * The `events` table owns identity, name, date and type; Redis owns presentation.
 * Where the two overlap, these pure functions re-derive the overlapping fields on
 * every read, so stored content can never drift away from the row.
 *
 * TIMEZONE CONTRACT: `events.date` is a `timestamp` WITHOUT timezone, so
 * node-postgres parses it using the Node process timezone. The stored wall clock
 * therefore lives in the LOCAL components of the Date. Every formatter below reads
 * it with local getters (`getFullYear`, `getMonth`, ...). Never use `toISOString()`
 * or `Intl` with a `timeZone` option here: both re-project through UTC and can
 * silently shift the rendered calendar day.
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
  return capitalize(MONTHS[d.getMonth()]);
}

function weekdayName(d: Date): string {
  return capitalize(WEEKDAYS[d.getDay()]);
}

/** `'Domingo, 24 de Octubre 2027'` — hero headline date. */
export function formatLongDate(d: Date): string {
  return `${weekdayName(d)}, ${d.getDate()} de ${monthName(d)} ${d.getFullYear()}`;
}

/** `'Domingo 24 de Octubre, 2027'` — ceremony/reception venue date. */
export function formatVenueDate(d: Date): string {
  return `${weekdayName(d)} ${d.getDate()} de ${monthName(d)}, ${d.getFullYear()}`;
}

/** `'Octubre · 2027'` — hero side label. */
export function formatSideLabel(d: Date): string {
  return `${monthName(d)} · ${d.getFullYear()}`;
}

/**
 * `'2027-10-24T00:00:00'` — countdown target, built from local getters so the
 * client counts down to the same wall clock that was stored.
 */
export function formatLocalIso(d: Date): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  return `${date}T${time}`;
}

/** `'2027'` — footer copyright year. */
export function formatYear(d: Date): string {
  return String(d.getFullYear());
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
