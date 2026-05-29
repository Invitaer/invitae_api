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

const MOCK_INVITATION: InvitationDto = {
  metadata: { slug: SLUG, eventType: 'wedding', language: 'es' },
  theme: { bgBase: '#fff', bgCard: '#f0f0f0', accent: '#000', text: '#111' },
  assets: { heroImage: null, music: null },
  settings: { whatsappNumber: '123', mapsUrl: 'https://maps.example.com', musicAutoplay: false },
  sections: [],
};

describe('InvitaeService — slug → eventId resolution', () => {
  let service: InvitaeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitaeService,
        { provide: RedisService, useValue: mockRedisService },
        DatabaseService,
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
