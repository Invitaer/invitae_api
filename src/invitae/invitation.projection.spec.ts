import { Event } from '../database/schema';
import { InvitationDto } from '../admin/content/dto/invitation.dto';
import {
  formatCelebrantNames,
  formatLocalIso,
  formatLongDate,
  formatSideLabel,
  formatVenueDate,
  formatYear,
  projectInvitation,
} from './invitation.projection';

// 2027-10-24 is a Sunday. Built with local getters on purpose: `events.date` is a
// timestamp WITHOUT timezone, so node-postgres hands us a Date whose LOCAL
// components are the stored wall clock.
const SUNDAY_24_OCT_2027 = new Date(2027, 9, 24);

/**
 * Runs `fn` with the process timezone forced to `tz`. Node re-reads process.env.TZ
 * for every new Date operation, which lets us prove the formatters never depend on
 * the UTC offset of the host.
 */
function withTimezone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = previous;
  }
}

describe('invitation.projection — date formatters', () => {
  describe('formatLongDate', () => {
    it('renders "Domingo, 24 de Octubre 2027"', () => {
      expect(formatLongDate(SUNDAY_24_OCT_2027)).toBe(
        'Domingo, 24 de Octubre 2027',
      );
    });
  });

  describe('formatVenueDate', () => {
    it('renders "Domingo 24 de Octubre, 2027"', () => {
      expect(formatVenueDate(SUNDAY_24_OCT_2027)).toBe(
        'Domingo 24 de Octubre, 2027',
      );
    });
  });

  describe('formatSideLabel', () => {
    it('renders "Octubre · 2027"', () => {
      expect(formatSideLabel(SUNDAY_24_OCT_2027)).toBe('Octubre · 2027');
    });
  });

  describe('formatLocalIso', () => {
    it('renders a zero-padded local ISO string without a timezone suffix', () => {
      expect(formatLocalIso(SUNDAY_24_OCT_2027)).toBe('2027-10-24T00:00:00');
    });

    it('zero-pads single-digit month, day, hour and minute', () => {
      expect(formatLocalIso(new Date(2027, 0, 5, 9, 7))).toBe(
        '2027-01-05T09:07:00',
      );
    });

    it('never carries a "Z" or an offset suffix', () => {
      expect(formatLocalIso(SUNDAY_24_OCT_2027)).not.toMatch(/Z|[+-]\d{2}:\d{2}$/);
    });
  });

  describe('formatYear', () => {
    it('renders the local calendar year', () => {
      expect(formatYear(SUNDAY_24_OCT_2027)).toBe('2027');
    });
  });

  describe('the calendar day never shifts with the host timezone', () => {
    // Local midnight in a POSITIVE-offset zone rolls BACK a day under toISOString().
    it.each(['UTC', 'Pacific/Kiritimati', 'Europe/Madrid'])(
      'keeps local midnight on the same calendar day in %s',
      (tz) => {
        withTimezone(tz, () => {
          const midnight = new Date(2027, 0, 1);
          expect(formatLocalIso(midnight)).toBe('2027-01-01T00:00:00');
          expect(formatLongDate(midnight)).toBe('Viernes, 1 de Enero 2027');
          expect(formatYear(midnight)).toBe('2027');
        });
      },
    );

    // A late local hour in a NEGATIVE-offset zone rolls FORWARD a day under toISOString().
    it.each(['UTC', 'America/Argentina/Buenos_Aires', 'Pacific/Midway'])(
      'keeps a late evening hour on the same calendar day in %s',
      (tz) => {
        withTimezone(tz, () => {
          const lateNight = new Date(2027, 9, 24, 23, 30);
          expect(formatLocalIso(lateNight)).toBe('2027-10-24T23:30:00');
          expect(formatLongDate(lateNight)).toBe('Domingo, 24 de Octubre 2027');
          expect(formatVenueDate(lateNight)).toBe('Domingo 24 de Octubre, 2027');
        });
      },
    );
  });
});

describe('invitation.projection — formatCelebrantNames', () => {
  it('normalizes an uppercase standalone connector: "Susan Y Nacho" → "Susan & Nacho"', () => {
    expect(formatCelebrantNames('Susan Y Nacho')).toBe('Susan & Nacho');
  });

  it('normalizes a lowercase standalone connector: "Susan y Nacho" → "Susan & Nacho"', () => {
    expect(formatCelebrantNames('Susan y Nacho')).toBe('Susan & Nacho');
  });

  it('never touches a y/Y inside a word', () => {
    expect(formatCelebrantNames('Yolanda Y Yahir')).toBe('Yolanda & Yahir');
  });

  it('leaves an already-normalized name unchanged', () => {
    expect(formatCelebrantNames('Susan & Nacho')).toBe('Susan & Nacho');
  });

  it('leaves a name with no connector unchanged', () => {
    expect(formatCelebrantNames('Valentina')).toBe('Valentina');
  });
});

// --- projectInvitation fixtures -------------------------------------------

const EVENT: Event = {
  id: 'event-uuid-1',
  userId: 'user-uuid-1',
  name: 'Susan Y Nacho',
  slug: 'susan-y-nacho-2027',
  date: SUNDAY_24_OCT_2027,
  eventType: 'wedding',
  location: null,
  createdAt: new Date(2026, 0, 1),
};

function buildContent(
  sections: InvitationDto['sections'] = [],
): InvitationDto {
  return {
    metadata: { slug: 'stale-slug', eventType: 'stale-type', language: 'es' },
    theme: { bgBase: '#fff', bgCard: '#eee', accent: '#000', text: '#111' },
    assets: { heroImage: null, music: null },
    settings: {
      whatsappNumber: '123',
      mapsUrl: 'https://maps.example.com',
      musicAutoplay: false,
    },
    sections,
  };
}

function section(
  type: string,
  data: Record<string, any>,
): InvitationDto['sections'][number] {
  return { type, enabled: true, order: 1, data };
}

function findSection(invitation: InvitationDto, type: string) {
  return invitation.sections.find((s) => s.type === type);
}

describe('invitation.projection — projectInvitation', () => {
  it('overwrites metadata.slug and metadata.eventType from the event row', () => {
    const result = projectInvitation(buildContent(), EVENT);

    expect(result.metadata.slug).toBe('susan-y-nacho-2027');
    expect(result.metadata.eventType).toBe('wedding');
    expect(result.metadata.language).toBe('es');
  });

  it('derives hero celebrantNames, eventDate and sideLabel', () => {
    const content = buildContent([
      section('hero', {
        celebrantNames: 'Stale Names',
        eventType: 'Boda',
        eventDate: 'Lunes, 1 de Enero 2020',
        sideLabel: 'Enero · 2020',
        backgroundImage: '/hero.jpg',
      }),
    ]);

    const hero = findSection(projectInvitation(content, EVENT), 'hero');

    expect(hero?.data).toEqual({
      celebrantNames: 'Susan & Nacho',
      eventType: 'Boda',
      eventDate: 'Domingo, 24 de Octubre 2027',
      sideLabel: 'Octubre · 2027',
      backgroundImage: '/hero.jpg',
    });
  });

  it('does NOT derive hero.data.eventType (display label, not the DB key)', () => {
    const content = buildContent([section('hero', { eventType: 'Boda' })]);

    const hero = findSection(projectInvitation(content, EVENT), 'hero');

    expect(hero?.data.eventType).toBe('Boda');
  });

  it('derives countdown targetDate as a local ISO string', () => {
    const content = buildContent([
      section('countdown', {
        targetDate: '2020-01-01T00:00:00',
        finishedMessage: '¡Llegó el día!',
      }),
    ]);

    const countdown = findSection(
      projectInvitation(content, EVENT),
      'countdown',
    );

    expect(countdown?.data.targetDate).toBe('2027-10-24T00:00:00');
    expect(countdown?.data.finishedMessage).toBe('¡Llegó el día!');
  });

  it('derives ceremony.date but never touches time, place or address', () => {
    const content = buildContent([
      section('ceremony', {
        place: 'Parroquia San Juan',
        address: 'Av. Siempre Viva 123',
        time: '18:00',
        date: 'Lunes 1 de Enero, 2020',
      }),
    ]);

    const ceremony = findSection(projectInvitation(content, EVENT), 'ceremony');

    expect(ceremony?.data).toEqual({
      place: 'Parroquia San Juan',
      address: 'Av. Siempre Viva 123',
      time: '18:00',
      date: 'Domingo 24 de Octubre, 2027',
    });
  });

  it('derives reception.date but never touches time, venue or address', () => {
    const content = buildContent([
      section('reception', {
        venue: 'Salón Los Álamos',
        address: 'Ruta 8 km 40',
        time: '21:00',
        date: 'Lunes 1 de Enero, 2020',
      }),
    ]);

    const reception = findSection(
      projectInvitation(content, EVENT),
      'reception',
    );

    expect(reception?.data).toEqual({
      venue: 'Salón Los Álamos',
      address: 'Ruta 8 km 40',
      time: '21:00',
      date: 'Domingo 24 de Octubre, 2027',
    });
  });

  it('derives footer coupleNames and year', () => {
    const content = buildContent([
      section('footer', {
        hashtag: '#SusanYNacho',
        coupleNames: 'Stale Names',
        year: '2020',
      }),
    ]);

    const footer = findSection(projectInvitation(content, EVENT), 'footer');

    expect(footer?.data).toEqual({
      hashtag: '#SusanYNacho',
      coupleNames: 'Susan & Nacho',
      year: '2027',
    });
  });

  it('is a no-op for a payload missing a derived section type', () => {
    const content = buildContent([section('hero', { celebrantNames: 'x' })]);

    const result = projectInvitation(content, EVENT);

    expect(findSection(result, 'footer')).toBeUndefined();
    expect(result.sections).toHaveLength(1);
  });

  it('does not throw when a derived section carries an unexpected data shape', () => {
    const content = buildContent([
      section('hero', null as unknown as Record<string, any>),
      section('footer', 'not-an-object' as unknown as Record<string, any>),
      section('countdown', [] as unknown as Record<string, any>),
    ]);

    expect(() => projectInvitation(content, EVENT)).not.toThrow();
  });

  it('passes non-derived sections through unchanged', () => {
    const gallery = section('gallery', {
      title: 'Galería',
      layout: 'grid',
      images: [{ src: '/1.jpg' }],
    });
    const content = buildContent([gallery]);

    const result = projectInvitation(content, EVENT);

    expect(findSection(result, 'gallery')).toEqual(gallery);
  });

  it('leaves theme, assets and settings byte-identical', () => {
    const content = buildContent();

    const result = projectInvitation(content, EVENT);

    expect(result.theme).toEqual(content.theme);
    expect(result.assets).toEqual(content.assets);
    expect(result.settings).toEqual(content.settings);
  });

  it('returns a new object and never mutates the stored content', () => {
    const content = buildContent([
      section('hero', {
        celebrantNames: 'Stale Names',
        eventDate: 'Lunes, 1 de Enero 2020',
        sideLabel: 'Enero · 2020',
      }),
      section('footer', { coupleNames: 'Stale Names', year: '2020' }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(content)) as InvitationDto;

    const result = projectInvitation(content, EVENT);

    expect(result).not.toBe(content);
    expect(content).toEqual(snapshot);
  });
});

/**
 * The stored Redis payload is not schema-validated at read time. A `sections`
 * container of an unexpected shape (schema drift from an older write path, or a
 * manual Redis edit) must degrade to an empty list — never throw, because that
 * would 500 the PUBLIC, unauthenticated invitation endpoints.
 */
describe('invitation.projection — malformed `sections` container', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['an object', {}],
    ['a string', 'nope'],
    ['a number', 42],
  ];

  it.each(MALFORMED)('projects to sections: [] when sections is %s', (_label, value) => {
    const content = { ...buildContent(), sections: value } as InvitationDto;

    const result = projectInvitation(content, EVENT);

    expect(result.sections).toEqual([]);
  });

  it.each(MALFORMED)('still projects metadata when sections is %s', (_label, value) => {
    const content = { ...buildContent(), sections: value } as InvitationDto;

    const result = projectInvitation(content, EVENT);

    expect(result.metadata.slug).toBe('susan-y-nacho-2027');
    expect(result.metadata.eventType).toBe('wedding');
  });
});
