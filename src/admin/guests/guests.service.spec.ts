// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GuestsService } from './guests.service';
import { DatabaseService } from '../../database/database.service';

const MOCK_GUEST_E1 = {
  id: 'guest-uuid-1',
  eventId: 'event-uuid-1',
  name: 'Alice',
  phone: '123456789',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_GUEST_E2 = {
  id: 'guest-uuid-2',
  eventId: 'event-uuid-2',
  name: 'Bob',
  phone: '987654321',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildMockDb(rows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(rows);
  const mutationWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });
  const values = jest.fn().mockReturnValue({ returning });
  const deleteWhere = jest.fn().mockReturnValue({ returning });
  const selectWhere = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where: selectWhere });

  return {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values }),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    _internals: { returning, mutationWhere, set, values, deleteWhere, selectWhere, from },
  };
}

describe('GuestsService (eventId scoping)', () => {
  let service: GuestsService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestsService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<GuestsService>(GuestsService);
  });

  describe('create', () => {
    it('creates a guest with eventId injected into values', async () => {
      dbServiceMock.db = buildMockDb([MOCK_GUEST_E1]);

      const result = await service.create('event-uuid-1', {
        name: 'Alice',
        phone: '123456789',
      });

      expect(result).toEqual(MOCK_GUEST_E1);
      expect(result.eventId).toBe('event-uuid-1');
    });
  });

  describe('findAll', () => {
    it('returns only guests belonging to the given eventId', async () => {
      dbServiceMock.db = buildMockDb([MOCK_GUEST_E1]);

      const result = await service.findAll('event-uuid-1');

      expect(result).toEqual([MOCK_GUEST_E1]);
      expect(result[0].eventId).toBe('event-uuid-1');
    });

    it('returns empty array when event has no guests', async () => {
      dbServiceMock.db = buildMockDb([]);

      const result = await service.findAll('event-uuid-2');

      expect(result).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('returns guest when found within the event scope', async () => {
      dbServiceMock.db = buildMockDb([MOCK_GUEST_E1]);

      const result = await service.findOne('event-uuid-1', 'guest-uuid-1');

      expect(result).toEqual(MOCK_GUEST_E1);
    });

    it('throws NotFoundException when guest does not exist in that event', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.findOne('event-uuid-1', 'nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates guest scoped to eventId and returns updated guest', async () => {
      const updated = { ...MOCK_GUEST_E1, name: 'Alice Updated' };
      dbServiceMock.db = buildMockDb([updated]);

      const result = await service.update('event-uuid-1', 'guest-uuid-1', {
        name: 'Alice Updated',
      });

      expect(result).toEqual(updated);
    });

    it('throws NotFoundException when guest does not exist in that event for update', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.update('event-uuid-1', 'nonexistent-id', { name: 'Hacked' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('removes guest scoped to eventId without error', async () => {
      dbServiceMock.db = buildMockDb([MOCK_GUEST_E1]);

      await expect(
        service.remove('event-uuid-1', 'guest-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('throws NotFoundException when guest does not exist in that event for remove', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.remove('event-uuid-1', 'nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
