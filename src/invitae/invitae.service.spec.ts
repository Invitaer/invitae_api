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
import { DatabaseService } from '../database/database.service';
import { InvitationDto } from '../admin/content/dto/invitation.dto';

// --- Mock RedisService ---

const mockRedisService = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

// --- Fixtures ---

const EVENT_ID = 'event-uuid-1';
const SLUG = 'boda-2025';
const GUEST_ID = 'guest-uuid-1';

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
 * Mock DB whose `select().from().where()` chain resolves to `rows`.
 * Used by getGuestInvitation to look up the guest scoped to the event.
 */
function mockSelect(rows: unknown[]) {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(rows),
    }),
  });
}

// --- buildMockDb for DatabaseService ---

function buildMockDb(rows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(rows);
  const mutationWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });

  return {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn(),
  };
}

describe('InvitaeService — slug → eventId resolution', () => {
  let service: InvitaeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: DatabaseService, useValue: { db: buildMockDb() } },
      ],
    }).compile();

    service = module.get<InvitaeService>(InvitaeService);

    jest.clearAllMocks();
  });

  describe('getInvitation', () => {
    it('reads inv_idx:${slug} to resolve eventId, then reads event:${eventId}:invitation', async () => {
      mockRedisService.get
        .mockResolvedValueOnce(EVENT_ID)                        // inv_idx:boda-2025 → eventId
        .mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION)); // event:event-uuid-1:invitation

      const result = await service.getInvitation(SLUG);

      expect(mockRedisService.get).toHaveBeenNthCalledWith(1, `inv_idx:${SLUG}`);
      expect(mockRedisService.get).toHaveBeenNthCalledWith(2, `event:${EVENT_ID}:invitation`);
      expect(result).toEqual(MOCK_INVITATION);
    });

    it('throws NotFoundException when slug is not found in inv_idx', async () => {
      mockRedisService.get.mockResolvedValueOnce(null); // inv_idx:nonexistent → null

      await expect(service.getInvitation('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when eventId is found but invitation content is missing', async () => {
      mockRedisService.get
        .mockResolvedValueOnce(EVENT_ID) // inv_idx exists
        .mockResolvedValueOnce(null);    // event:invitation is missing

      await expect(service.getInvitation(SLUG)).rejects.toThrow(NotFoundException);
    });

    it('does NOT reference user.${userId}:invitation key pattern', async () => {
      mockRedisService.get
        .mockResolvedValueOnce(EVENT_ID)
        .mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

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

  beforeEach(async () => {
    dbMock = buildMockDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: DatabaseService, useValue: { db: dbMock } },
      ],
    }).compile();

    service = module.get<InvitaeService>(InvitaeService);
    jest.clearAllMocks();
  });

  function mockUpdateReturning(rows: unknown[]) {
    const returning = jest.fn().mockResolvedValue(rows);
    const mutationWhere = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where: mutationWhere });
    dbMock.update = jest.fn().mockReturnValue({ set });
    return { set, mutationWhere };
  }

  it('attending: true → sets rsvpStatus = ACCEPTED, scoped by slug', async () => {
    mockRedisService.get.mockResolvedValueOnce(EVENT_ID); // inv_idx:${slug} → eventId
    const { set } = mockUpdateReturning([
      { ...MOCK_GUEST_BASE, rsvpStatus: 'ACCEPTED' },
    ]);

    const result = await service.confirmAttendance({
      slug: SLUG,
      guestId: GUEST_ID,
      attending: true,
    });

    expect(mockRedisService.get).toHaveBeenCalledWith(`inv_idx:${SLUG}`);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ rsvpStatus: 'ACCEPTED' }),
    );
    expect(result.rsvpStatus).toBe('ACCEPTED');
  });

  it('attending: false → sets rsvpStatus = DECLINED', async () => {
    mockRedisService.get.mockResolvedValueOnce(EVENT_ID);
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
    mockRedisService.get.mockResolvedValueOnce(EVENT_ID);
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
    mockRedisService.get.mockResolvedValueOnce(null); // inv_idx miss

    await expect(
      service.confirmAttendance({ slug: 'nope', guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the guest does not belong to the slug event', async () => {
    mockRedisService.get.mockResolvedValueOnce(EVENT_ID);
    mockUpdateReturning([]); // update scoped by (id AND eventId) matched nothing

    await expect(
      service.confirmAttendance({ slug: SLUG, guestId: GUEST_ID, attending: true }),
    ).rejects.toThrow(NotFoundException);
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
        { provide: DatabaseService, useValue: { db: dbMock } },
      ],
    }).compile();
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the invitation plus the guest (public fields only) when the guest belongs to the event', async () => {
    const module = await build({ select: mockSelect([MOCK_GUEST_BASE]) });
    service = module.get(InvitaeService);
    mockRedisService.get
      .mockResolvedValueOnce(EVENT_ID) // inv_idx:${slug}
      .mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION)); // event:${eventId}:invitation

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

  it('throws NotFoundException when the slug has no invitation content', async () => {
    const module = await build({ select: mockSelect([MOCK_GUEST_BASE]) });
    service = module.get(InvitaeService);
    mockRedisService.get.mockResolvedValueOnce(null); // inv_idx miss

    await expect(service.getGuestInvitation(SLUG, GUEST_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the guest does not belong to the event', async () => {
    const module = await build({ select: mockSelect([]) }); // no matching guest
    service = module.get(InvitaeService);
    mockRedisService.get
      .mockResolvedValueOnce(EVENT_ID)
      .mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

    await expect(service.getGuestInvitation(SLUG, GUEST_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});
