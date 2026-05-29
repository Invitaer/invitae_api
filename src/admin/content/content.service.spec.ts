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
import { InvitationDto } from './dto/invitation.dto';

// --- Mock RedisService ---

const mockRedisClient = {
  keys: jest.fn(),
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
      mockRedisService.get.mockResolvedValueOnce(null); // no existing invitation
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(EVENT_ID, MOCK_INVITATION);

      expect(mockRedisService.set).toHaveBeenCalledWith(
        `event:${EVENT_ID}:invitation`,
        JSON.stringify(MOCK_INVITATION),
      );
    });

    it('writes inv_idx:${slug} = eventId (not userId)', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(EVENT_ID, MOCK_INVITATION);

      expect(mockRedisService.set).toHaveBeenCalledWith(
        `inv_idx:${SLUG}`,
        EVENT_ID,
      );
    });

    it('removes old slug index when slug changes', async () => {
      const oldInvitation = { ...MOCK_INVITATION, metadata: { ...MOCK_INVITATION.metadata, slug: 'old-slug' } };
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(oldInvitation));
      mockRedisService.del.mockResolvedValueOnce(undefined);
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(EVENT_ID, MOCK_INVITATION);

      expect(mockRedisService.del).toHaveBeenCalledWith('inv_idx:old-slug');
    });

    it('does NOT write old userId-keyed pattern (user.${userId}:invitation)', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);
      mockRedisService.set.mockResolvedValue(undefined);

      await service.setInvitation(EVENT_ID, MOCK_INVITATION);

      const allSetCalls = mockRedisService.set.mock.calls as [string, string][];
      const hasOldKeyPattern = allSetCalls.some(([key]) => key.startsWith('user.'));
      expect(hasOldKeyPattern).toBe(false);
    });

    it('returns the dto', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);
      mockRedisService.set.mockResolvedValue(undefined);

      const result = await service.setInvitation(EVENT_ID, MOCK_INVITATION);

      expect(result).toEqual(MOCK_INVITATION);
    });
  });

  // ── getInvitation ─────────────────────────────────────────────────────────────

  describe('getInvitation', () => {
    it('reads from event:${eventId}:invitation', async () => {
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));

      const result = await service.getInvitation(EVENT_ID);

      expect(mockRedisService.get).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
      expect(result).toEqual(MOCK_INVITATION);
    });

    it('throws NotFoundException when invitation does not exist', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);

      await expect(service.getInvitation(EVENT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteInvitation ──────────────────────────────────────────────────────────

  describe('deleteInvitation', () => {
    it('removes inv_idx:${slug} and event:${eventId}:invitation', async () => {
      mockRedisService.get.mockResolvedValueOnce(JSON.stringify(MOCK_INVITATION));
      mockRedisService.del.mockResolvedValue(undefined);

      await service.deleteInvitation(EVENT_ID);

      expect(mockRedisService.del).toHaveBeenCalledWith(`inv_idx:${SLUG}`);
      expect(mockRedisService.del).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
    });

    it('only deletes the invitation key when no existing invitation', async () => {
      mockRedisService.get.mockResolvedValueOnce(null);
      mockRedisService.del.mockResolvedValue(undefined);

      await service.deleteInvitation(EVENT_ID);

      expect(mockRedisService.del).toHaveBeenCalledTimes(1);
      expect(mockRedisService.del).toHaveBeenCalledWith(`event:${EVENT_ID}:invitation`);
    });
  });
});
