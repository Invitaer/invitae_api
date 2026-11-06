// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));
jest.mock('../database/database.service');

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InvitaeService } from './invitae.service';
import { RedisService } from '../redis/redis.service';
import { GuestEventsService } from '../realtime/guest-events.service';
import { DatabaseService } from '../database/database.service';
import { Event } from '../database/schema';
import { InvitationDto } from '../admin/content/dto/invitation.dto';

// --- Mock RedisService ---

const mockRedisService = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockGuestEvents = {
  publish: jest.fn().mockResolvedValue(undefined),
};

// --- Fixtures ---

const EVENT_ID = 'event-uuid-1';
const SLUG = 'boda-2025';
const GUEST_ID = 'guest-uuid-1';

const MOCK_EVENT: Event = {
  id: EVENT_ID,
  userId: 'user-uuid-1',
  name: 'Susan Y Nacho',
  slug: SLUG,
  date: new Date('2027-10-24T00:00:00Z'),
  eventType: 'wedding',
  location: null,
  createdAt: new Date(2026, 0, 1),
};

const MOCK_INVITATION: InvitationDto = {
  metadata: { slug: SLUG, eventType: 'wedding', language: 'es' },
  theme: { bgBase: '#fff', bgCard: '#f0f0f0', accent: '#000', text: '#111' },
  assets: { heroImage: null, music: null },
  settings: { whatsappNumber: '123', mapsUrl: 'https://maps.example.com', musicAutoplay: false },
  sections: [],
};

const MOCK_GUEST_BASE = {
  id: GUEST_ID,
  eventId: EVENT_ID,
  name: 'Alice',
  phone: '123456789',
  email: 'alice@example.com',
  tableId: null,
  tickets: 2,
  tableNumber: null,
  rsvpStatus: 'PENDING' as const,
  invitationSent: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Mock DB whose successive `select().from().where()` chains resolve to the given
 * row sets in order. The service now issues one select for the event (by slug)
 * and, for guest invitations, a second one for the guest.
 */
function mockSelectSequence(...rowSets: unknown[][]) {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    const rows = rowSets[call] ?? [];
    call += 1;
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    };
  });
}

// --- buildMockDb for DatabaseService ---

function buildMockDb(rows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(rows);
  const mutationWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });

  return {
    select: mockSelectSequence(),
    insert: jest.fn(),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn(),
  };
}

describe('InvitaeService — slug → event resolution (Postgres-backed)', () => {
  let service: InvitaeService;

  async function build(dbOverride: Partial<ReturnType<typeof buildMockDb>> = {}) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: GuestEventsService, useValue: mockGuestEvents },
        { provide: DatabaseService, useValue: { db: { ...buildMockDb(), ...dbOverride } } },
      ],
    }).compile();
    return module.get<InvitaeService>(InvitaeService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getInvitation', () => {
    it('resolves the slug against the events table, then reads event:${eventId}:invitation', async () => {
      service = await build({ select: mockSelectSequence([MOCK_EVENT]) });
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

      const result = await service.getInvitation(SLUG);

      expect(mockRedisService.get).toHaveBeenCalledTimes(1);
      expect(mockRedisService.get).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
      expect(result).toEqual(MOCK_INVITATION);
    });

    it('never reads the inv_idx: slug index from Redis', async () => {
      service = await build({ select: mockSelectSequence([MOCK_EVENT]) });
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

      await service.getInvitation(SLUG);

      const allGetCalls = mockRedisService.get.mock.calls as [string][];
      expect(allGetCalls.some(([key]) => key.startsWith('inv_idx:'))).toBe(false);
    });

    it('throws NotFoundException when no event row carries the slug', async () => {
      service = await build({ select: mockSelectSequence([]) });

      await expect(service.getInvitation('nonexistent')).rejects.toThrow(
        new NotFoundException("Invitation 'nonexistent' not found"),
      );
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the event exists but invitation content is missing', async () => {
      service = await build({ select: mockSelectSequence([MOCK_EVENT]) });
      mockRedisService.get.mockResolvedValueOnce(null);

      await expect(service.getInvitation(SLUG)).rejects.toThrow(
        new NotFoundException(`Invitation '${SLUG}' not found`),
      );
    });

    it('does not throw when the stored payload has a non-array `sections`', async () => {
      service = await build({ select: mockSelectSequence([MOCK_EVENT]) });
      mockRedisService.get.mockResolvedValueOnce(
        JSON.stringify({ ...MOCK_INVITATION, sections: {} }),
      );

      const result = await service.getInvitation(SLUG);

      expect(result.sections).toEqual([]);
      expect(result.metadata.slug).toBe(SLUG);
    });

    it('does NOT reference user.${userId}:invitation key pattern', async () => {
      service = await build({ select: mockSelectSequence([MOCK_EVENT]) });
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

      await service.getInvitation(SLUG);

      const allGetCalls = mockRedisService.get.mock.calls as [string][];
      const hasOldKeyPattern = allGetCalls.some(([key]) => key.startsWith('user.'));
      expect(hasOldKeyPattern).toBe(false);
    });
  });
});

describe('InvitaeService — confirmAttendance (event-scoped, no PII)', () => {
  let service: InvitaeService;
  let dbMock: ReturnType<typeof buildMockDb>;

  async function build(eventRows: unknown[]) {
    dbMock = { ...buildMockDb(), select: mockSelectSequence(eventRows) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: GuestEventsService, useValue: mockGuestEvents },
        { provide: DatabaseService, useValue: { db: dbMock } },
      ],
    }).compile();

    service = module.get<InvitaeService>(InvitaeService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockUpdateReturning(rows: unknown[]) {
    const returning = jest.fn().mockResolvedValue(rows);
    const mutationWhere = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where: mutationWhere });
    dbMock.update = jest.fn().mockReturnValue({ set });
    return { set, mutationWhere };
  }

  /** An event whose invitation was published: the Redis content read succeeds. */
  function mockPublishedInvitation() {
    mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));
  }

  it('broadcasts the change so an organizer watching the dashboard sees it immediately', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(mockGuestEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        guestId: GUEST_ID,
        rsvpStatus: 'ACCEPTED',
      }),
    );
  });

  it('broadcasts a decline too — "No asistirá" is just as much a status change', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'DECLINED' }]);

    await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: false,
    });

    expect(mockGuestEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({ rsvpStatus: 'DECLINED' }),
    );
  });

  it('does not broadcast when the guest does not belong to the event', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([]); // scoped update matched nothing

    await expect(
      service.confirmAttendance({ slug: SLUG, guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);

    expect(mockGuestEvents.publish).not.toHaveBeenCalled();
  });

  it('still confirms the guest when the broadcast fails', async () => {
    // The write is committed by this point. Redis being down must not turn a
    // successful RSVP into an error for the guest — they would retry and see a
    // failure for something that actually worked.
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);
    mockGuestEvents.publish.mockRejectedValueOnce(new Error('redis down'));

    const result = await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(result.rsvpStatus).toBe('ACCEPTED');
  });

  it('attending: true → sets rsvpStatus = ACCEPTED, scoped by slug', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    const { set } = mockUpdateReturning([
      { ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' },
    ]);

    const result = await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ rsvpStatus: 'ACCEPTED' }),
    );
    expect(result.rsvpStatus).toBe('ACCEPTED');
  });

  it('resolves the slug through Postgres, never through the Redis slug index', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    const allGetCalls = mockRedisService.get.mock.calls as [string][];
    expect(allGetCalls.some(([key]) => key.startsWith('inv_idx:'))).toBe(false);
  });

  it('attending: false → sets rsvpStatus = DECLINED', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    const { set } = mockUpdateReturning([
      { ...MOCK_GUEST_BASE, rsvpStatus: 'DECLINED' },
    ]);

    const result = await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: false,
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ rsvpStatus: 'DECLINED' }),
    );
    expect(result.rsvpStatus).toBe('DECLINED');
  });

  it('response contains only public fields — never leaks phone/email PII', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    const result = await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(result).toEqual({
      id: GUEST_ID,
      name: 'Alice',
      tickets: 2,
      rsvpStatus: 'ACCEPTED',
    });
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('email');
  });

  it('throws NotFoundException when the slug is not found', async () => {
    await build([]); // no event row carries the slug

    await expect(
      service.confirmAttendance({ slug: 'nope', guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the guest does not belong to the slug event', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([]); // update scoped by (id AND eventId) matched nothing

    await expect(
      service.confirmAttendance({ slug: SLUG, guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);
  });

  /**
   * RSVP is a PUBLIC, unauthenticated write. It must stay gated on the invitation
   * actually being published — an event row alone (created the moment the admin
   * saves the event) must not open the write path.
   */
  it('throws NotFoundException when the event exists but its invitation was never published', async () => {
    await build([MOCK_EVENT]);
    mockRedisService.get.mockResolvedValueOnce(null); // never published
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    await expect(
      service.confirmAttendance({ slug: SLUG, guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(new NotFoundException(`Invitation '${SLUG}' not found`));
  });

  it('performs NO database update when the invitation content is missing', async () => {
    await build([MOCK_EVENT]);
    mockRedisService.get.mockResolvedValueOnce(null);
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    await expect(
      service.confirmAttendance({ slug: SLUG, guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);

    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('reads the invitation content under the event-scoped key', async () => {
    await build([MOCK_EVENT]);
    mockPublishedInvitation();
    mockUpdateReturning([{ ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' }]);

    await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(mockRedisService.get).toHaveBeenCalledWith(
      `event:${EVENT_ID}:invitation`,
    );
  });
});

describe('InvitaeService — getGuestInvitation', () => {
  let service: InvitaeService;
  let dbMock: ReturnType<typeof buildMockDb>;

  function build(dbOverride: Partial<ReturnType<typeof buildMockDb>> = {}) {
    dbMock = { ...buildMockDb(), ...dbOverride };
    return Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: GuestEventsService, useValue: mockGuestEvents },
        { provide: DatabaseService, useValue: { db: dbMock } },
      ],
    }).compile();
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the invitation plus the guest (public fields only) when the guest belongs to the event', async () => {
    const module = await build({
      select: mockSelectSequence([MOCK_EVENT], [MOCK_GUEST_BASE]),
    });
    service = module.get(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

    const result = await service.getGuestInvitation(SLUG, GUEST_ID);

    expect(result.metadata).toEqual(MOCK_INVITATION.metadata);
    expect(result.sections).toEqual(MOCK_INVITATION.sections);
    expect(result.guest).toEqual({
      id: GUEST_ID,
      name: 'Alice',
      tickets: 2,
      rsvpStatus: 'PENDING',
    });
    expect(result.guest).not.toHaveProperty('phone');
    expect(result.guest).not.toHaveProperty('email');
  });

  it('returns the PROJECTED invitation alongside the guest', async () => {
    const module = await build({
      select: mockSelectSequence([MOCK_EVENT], [MOCK_GUEST_BASE]),
    });
    service = module.get(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(
      JSON.stringify({
        ...MOCK_INVITATION,
        metadata: { ...MOCK_INVITATION.metadata, slug: 'stale-slug' },
        sections: [
          { type: 'hero', enabled: true, order: 1, data: { celebrantNames: 'Stale' } },
        ],
      }),
    );

    const result = await service.getGuestInvitation(SLUG, GUEST_ID);

    expect(result.metadata.slug).toBe(SLUG);
    expect(result.sections[0].data.celebrantNames).toBe('Susan & Nacho');
    expect(result.guest.id).toBe(GUEST_ID);
  });

  it('throws NotFoundException when the slug has no invitation content', async () => {
    const module = await build({
      select: mockSelectSequence([MOCK_EVENT], [MOCK_GUEST_BASE]),
    });
    service = module.get(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(null); // no stored content

    await expect(service.getGuestInvitation(SLUG, GUEST_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the guest does not belong to the event', async () => {
    const module = await build({
      select: mockSelectSequence([MOCK_EVENT], []), // no matching guest
    });
    service = module.get(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

    await expect(service.getGuestInvitation(SLUG, GUEST_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * Regression test for the original complaint: the stored Redis payload had drifted
 * away from the event row (renamed couple, rescheduled date, renamed slug) and the
 * public endpoint kept serving the stale copy. Every derived field must now come
 * from the event row, whatever the stored payload says.
 */
describe('InvitaeService — stale stored content is overridden by the event row', () => {
  const REAL_EVENT: Event = {
    id: EVENT_ID,
    userId: 'user-uuid-1',
    name: 'Susan Y Nacho',
    slug: 'susan-y-nacho-2027',
    date: new Date('2027-10-24T00:00:00Z'),
    eventType: 'wedding',
    location: null,
    createdAt: new Date(2026, 0, 1),
  };

  const STALE_CONTENT: InvitationDto = {
    metadata: { slug: 'old-slug-2020', eventType: 'birthday', language: 'es' },
    theme: { bgBase: '#fff', bgCard: '#f0f0f0', accent: '#000', text: '#111' },
    assets: { heroImage: '/hero.jpg', music: '/song.mp3' },
    settings: {
      whatsappNumber: '123',
      mapsUrl: 'https://maps.example.com',
      musicAutoplay: true,
    },
    sections: [
      {
        type: 'hero',
        enabled: true,
        order: 1,
        data: {
          celebrantNames: 'Old Y Names',
          eventType: 'Boda',
          eventDate: 'Lunes, 1 de Enero 2020',
          sideLabel: 'Enero · 2020',
        },
      },
      {
        type: 'countdown',
        enabled: true,
        order: 2,
        data: { targetDate: '2020-01-01T00:00:00', finishedMessage: '¡Llegó!' },
      },
      {
        type: 'ceremony',
        enabled: true,
        order: 3,
        data: {
          place: 'Parroquia San Juan',
          address: 'Av. Siempre Viva 123',
          time: '18:00',
          date: 'Lunes 1 de Enero, 2020',
        },
      },
      {
        type: 'reception',
        enabled: true,
        order: 4,
        data: {
          venue: 'Salón Los Álamos',
          address: 'Ruta 8 km 40',
          time: '21:00',
          date: 'Lunes 1 de Enero, 2020',
        },
      },
      {
        type: 'footer',
        enabled: true,
        order: 5,
        data: { hashtag: '#SusanYNacho', coupleNames: 'Old Y Names', year: '2020' },
      },
    ],
  };

  let service: InvitaeService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: GuestEventsService, useValue: mockGuestEvents },
        {
          provide: DatabaseService,
          useValue: {
            db: { ...buildMockDb(), select: mockSelectSequence([REAL_EVENT]) },
          },
        },
      ],
    }).compile();

    service = module.get<InvitaeService>(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(JSON.stringify(STALE_CONTENT));
  });

  it('serves metadata from the event row, not from the stale payload', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');

    expect(result.metadata.slug).toBe('susan-y-nacho-2027');
    expect(result.metadata.eventType).toBe('wedding');
    expect(result.metadata.language).toBe('es');
  });

  it('serves hero names, date and side label from the event row', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');
    const hero = result.sections.find((s) => s.type === 'hero');

    expect(hero?.data.celebrantNames).toBe('Susan & Nacho');
    expect(hero?.data.eventDate).toBe('Domingo, 24 de Octubre 2027');
    expect(hero?.data.sideLabel).toBe('Octubre · 2027');
    expect(hero?.data.eventType).toBe('Boda'); // display label survives
  });

  it('serves the countdown target from the event row', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');
    const countdown = result.sections.find((s) => s.type === 'countdown');

    expect(countdown?.data.targetDate).toBe('2027-10-24T00:00:00');
  });

  it('serves ceremony and reception dates from the event row, keeping venue details', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');
    const ceremony = result.sections.find((s) => s.type === 'ceremony');
    const reception = result.sections.find((s) => s.type === 'reception');

    expect(ceremony?.data.date).toBe('Domingo 24 de Octubre, 2027');
    expect(ceremony?.data.place).toBe('Parroquia San Juan');
    expect(ceremony?.data.time).toBe('18:00');

    expect(reception?.data.date).toBe('Domingo 24 de Octubre, 2027');
    expect(reception?.data.venue).toBe('Salón Los Álamos');
    expect(reception?.data.time).toBe('21:00');
  });

  it('serves footer names and year from the event row', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');
    const footer = result.sections.find((s) => s.type === 'footer');

    expect(footer?.data.coupleNames).toBe('Susan & Nacho');
    expect(footer?.data.year).toBe('2027');
    expect(footer?.data.hashtag).toBe('#SusanYNacho');
  });

  it('leaves stored presentation content (theme, assets, settings) untouched', async () => {
    const result = await service.getInvitation('susan-y-nacho-2027');

    expect(result.theme).toEqual(STALE_CONTENT.theme);
    expect(result.assets).toEqual(STALE_CONTENT.assets);
    expect(result.settings).toEqual(STALE_CONTENT.settings);
  });
});
