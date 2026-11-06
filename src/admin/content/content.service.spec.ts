// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContentService } from './content.service';
import { RedisService } from '../../redis/redis.service';
import { Event } from '../../database/schema';
import { InvitationDto } from './dto/invitation.dto';

// --- Mock RedisService ---

const mockRedisClient = {
  keys: jest.fn(),
  set: jest.fn(),
};

const mockRedisService = {
  client: mockRedisClient,
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

// --- Fixtures ---

const EVENT_ID = 'event-uuid-1';
const SLUG = 'boda-2025';

const MOCK_EVENT: Event = {
  id: EVENT_ID,
  userId: 'user-uuid-1',
  name: 'Susan Y Nacho',
  slug: SLUG,
  date: new Date(2027, 9, 24),
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

describe('ContentService (eventId-keyed Redis)', () => {
  let service: ContentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<ContentService>(ContentService);

    jest.clearAllMocks();
    mockRedisService.client = mockRedisClient;
  });

  // ── getAllKeys ───────────────────────────────────────────────────────────────

  describe('getAllKeys', () => {
    it('returns keys scoped to the eventId prefix', async () => {
      mockRedisClient.keys.mockResolvedValueOnce([
        `content:${EVENT_ID}:title`,
        `content:${EVENT_ID}:body`,
      ]);

      const result = await service.getAllKeys(EVENT_ID);

      expect(mockRedisClient.keys).toHaveBeenCalledWith(`content:${EVENT_ID}:*`);
      expect(result).toEqual(['title', 'body']);
    });
  });

  // ── getContent ───────────────────────────────────────────────────────────────

  describe('getContent', () => {
    it('reads from content:${eventId}:${key}', async () => {
      mockRedisService.get.mockResolvedValueOnce('Our Wedding');

      const result = await service.getContent(EVENT_ID, 'title');

      expect(mockRedisService.get).toHaveBeenCalledWith(`content:${EVENT_ID}:title`);
      expect(result).toEqual({ key: 'title', value: 'Our Wedding' });
    });

    it('returns null value when key does not exist', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);

      const result = await service.getContent(EVENT_ID, 'missing-key');

      expect(result).toEqual({ key: 'missing-key', value: null });
    });
  });

  // ── setContent ───────────────────────────────────────────────────────────────

  describe('setContent', () => {
    it('stores at content:${eventId}:${key}', async () => {
      mockRedisService.set.mockResolvedValueOnce(undefined);

      const result = await service.setContent(EVENT_ID, 'title', 'Our Wedding');

      expect(mockRedisService.set).toHaveBeenCalledWith(
        `content:${EVENT_ID}:title`,
        'Our Wedding',
      );
      expect(result).toEqual({ key: 'title', value: 'Our Wedding' });
    });
  });

  // ── deleteContent ─────────────────────────────────────────────────────────────

  describe('deleteContent', () => {
    it('deletes from content:${eventId}:${key}', async () => {
      mockRedisService.del.mockResolvedValueOnce(undefined);

      await service.deleteContent(EVENT_ID, 'title');

      expect(mockRedisService.del).toHaveBeenCalledWith(`content:${EVENT_ID}:title`);
    });
  });

  // ── setInvitation ─────────────────────────────────────────────────────────────

  describe('setInvitation', () => {
    it('stores invitation at event:${eventId}:invitation', async () => {
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      expect(mockRedisService.set).toHaveBeenCalledWith(
        `event:${EVENT_ID}:invitation`,
        JSON.stringify(MOCK_INVITATION),
      );
    });

    it('ignores a client-supplied slug and stores the event row slug instead', async () => {
      mockRedisService.set.mockResolvedValue(undefined);
      const hijack: InvitationDto = {
        ...MOCK_INVITATION,
        metadata: { ...MOCK_INVITATION.metadata, slug: 'someone-elses-slug' },
      };

      const result = await service.setInvitation(MOCK_EVENT, hijack);

      expect(result.metadata.slug).toBe(SLUG);
      const [, stored] = mockRedisService.set.mock.calls[0] as [string, string];
      expect((JSON.parse(stored) as InvitationDto).metadata.slug).toBe(SLUG);
    });

    it('forces metadata.eventType to the event row value', async () => {
      mockRedisService.set.mockResolvedValue(undefined);
      const drifted: InvitationDto = {
        ...MOCK_INVITATION,
        metadata: { ...MOCK_INVITATION.metadata, eventType: 'birthday' },
      };

      const result = await service.setInvitation(MOCK_EVENT, drifted);

      expect(result.metadata.eventType).toBe('wedding');
    });

    it('never writes an inv_idx: slug index', async () => {
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      const allSetCalls = mockRedisService.set.mock.calls as [string, string][];
      expect(allSetCalls.some(([key]) => key.startsWith('inv_idx:'))).toBe(false);
      expect(allSetCalls).toHaveLength(1);
    });

    it('does NOT write old userId-keyed pattern (user.${userId}:invitation)', async () => {
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      const allSetCalls = mockRedisService.set.mock.calls as [string, string][];
      const hasOldKeyPattern = allSetCalls.some(([key]) => key.startsWith('user.'));
      expect(hasOldKeyPattern).toBe(false);
    });

    it('returns the dto', async () => {
      mockRedisService.set.mockResolvedValue(undefined);

      const result = await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      expect(result).toEqual(MOCK_INVITATION);
    });
  });

  // ── getInvitation ─────────────────────────────────────────────────────────────

  describe('original invitation snapshot', () => {
    const ORIGINAL_KEY = `event:${EVENT_ID}:invitation:original`;

    it('keeps the first stored invitation as the original, without overwriting one', async () => {
      mockRedisService.get.mockResolvedValue(null);

      await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        ORIGINAL_KEY,
        JSON.stringify({ ...MOCK_INVITATION, metadata: { ...MOCK_INVITATION.metadata } }),
        'NX',
      );
    });

    it('snapshots the content stored before this edit when no original exists yet', async () => {
      const before = JSON.stringify({ ...MOCK_INVITATION, sections: [{ type: 'hero', enabled: true, order: 1, data: {} }] });
      mockRedisService.get.mockResolvedValue(before);

      await service.setInvitation(MOCK_EVENT, { ...MOCK_INVITATION });

      expect(mockRedisService.get).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
      expect(mockRedisClient.set).toHaveBeenCalledWith(ORIGINAL_KEY, before, 'NX');
    });

    it('serves the original projected with the event row, like the live invitation', async () => {
      mockRedisService.get.mockResolvedValue(
        JSON.stringify({ ...MOCK_INVITATION, metadata: { ...MOCK_INVITATION.metadata, slug: 'stale' } }),
      );

      const result = await service.getOriginalInvitation(MOCK_EVENT);

      expect(mockRedisService.get).toHaveBeenCalledWith(ORIGINAL_KEY);
      expect(result.metadata.slug).toBe(SLUG);
    });

    it('throws NotFoundException when the event has no original yet', async () => {
      mockRedisService.get.mockResolvedValue(null);

      await expect(service.getOriginalInvitation(MOCK_EVENT)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getInvitation', () => {
    it('reads from event:${eventId}:invitation', async () => {
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

      const result = await service.getInvitation(MOCK_EVENT);

      expect(mockRedisService.get).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
      expect(result).toEqual(MOCK_INVITATION);
    });

    it('projects the event row over stale stored content, matching what the public endpoint serves', async () => {
      mockRedisService.get.mockResolvedValueOnce(
        JSON.stringify({
          ...MOCK_INVITATION,
          metadata: { ...MOCK_INVITATION.metadata, slug: 'stale-slug' },
          sections: [
            {
              type: 'hero',
              enabled: true,
              order: 1,
              data: { celebrantNames: 'Stale', eventDate: 'Lunes, 1 de Enero 2020' },
            },
          ],
        }),
      );

      const result = await service.getInvitation(MOCK_EVENT);

      expect(result.metadata.slug).toBe(SLUG);
      expect(result.sections[0].data.celebrantNames).toBe('Susan & Nacho');
      expect(result.sections[0].data.eventDate).toBe('Domingo, 24 de Octubre 2027');
    });

    it('throws NotFoundException when invitation does not exist', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);

      await expect(service.getInvitation(MOCK_EVENT)).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteInvitation ──────────────────────────────────────────────────────────

  describe('deleteInvitation', () => {
    it('removes event:${eventId}:invitation and nothing else', async () => {
      mockRedisService.del.mockResolvedValue(undefined);

      await service.deleteInvitation(EVENT_ID);

      expect(mockRedisService.del).toHaveBeenCalledTimes(1);
      expect(mockRedisService.del).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
    });

    it('does not read or delete an inv_idx: slug index', async () => {
      mockRedisService.del.mockResolvedValue(undefined);

      await service.deleteInvitation(EVENT_ID);

      expect(mockRedisService.get).not.toHaveBeenCalled();
      const allDelCalls = mockRedisService.del.mock.calls as [string][];
      expect(allDelCalls.some(([key]) => key.startsWith('inv_idx:'))).toBe(false);
    });
  });
});
