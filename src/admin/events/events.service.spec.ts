// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { DatabaseService } from '../../database/database.service';

const mockEvent = {
  id: 'event-uuid-1',
  userId: 'user-uuid-1',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10'),
  createdAt: new Date(),
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

describe('EventsService', () => {
  let service: EventsService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  describe('create', () => {
    it('should return the created event', async () => {
      dbServiceMock.db = buildMockDb([mockEvent]);

      const result = await service.create('user-uuid-1', {
        name: 'My Wedding',
        slug: 'my-wedding-2025',
        date: '2025-10-10',
      });

      expect(result).toEqual(mockEvent);
    });

    it('should throw ConflictException when slug already exists (pg error code 23505)', async () => {
      const pgUniqueError = { code: '23505', message: 'unique violation' };
      const returning = jest.fn().mockRejectedValue(pgUniqueError);
      dbServiceMock.db = {
        ...buildMockDb(),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({ returning }),
        }),
      } as any;

      await expect(
        service.create('user-uuid-1', {
          name: 'My Wedding',
          slug: 'my-wedding-2025',
          date: '2025-10-10',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when error message contains "unique"', async () => {
      const genericUniqueError = new Error(
        'duplicate key value violates unique constraint',
      );
      const returning = jest.fn().mockRejectedValue(genericUniqueError);
      dbServiceMock.db = {
        ...buildMockDb(),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({ returning }),
        }),
      } as any;

      await expect(
        service.create('user-uuid-1', {
          name: 'My Wedding',
          slug: 'my-wedding-2025',
          date: '2025-10-10',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return only events belonging to the given userId', async () => {
      dbServiceMock.db = buildMockDb([mockEvent]);

      const result = await service.findAll('user-uuid-1');

      expect(result).toEqual([mockEvent]);
    });

    it('should return empty array when user has no events', async () => {
      dbServiceMock.db = buildMockDb([]);

      const result = await service.findAll('user-uuid-2');

      expect(result).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('should return the event when found', async () => {
      dbServiceMock.db = buildMockDb([mockEvent]);

      const result = await service.findOne('event-uuid-1');

      expect(result).toEqual(mockEvent);
    });

    it('should throw NotFoundException when event does not exist', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(service.findOne('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should return the updated event when owner calls update', async () => {
      const updatedEvent = { ...mockEvent, name: 'Updated Name' };
      dbServiceMock.db = buildMockDb([updatedEvent]);

      const result = await service.update('event-uuid-1', 'user-uuid-1', {
        name: 'Updated Name',
      });

      expect(result).toEqual(updatedEvent);
    });

    it('should throw NotFoundException when a non-owner tries to update', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.update('event-uuid-1', 'different-user-id', {
          name: 'Hacked Name',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should resolve without error when owner removes event', async () => {
      dbServiceMock.db = buildMockDb([mockEvent]);

      await expect(
        service.remove('event-uuid-1', 'user-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('should throw NotFoundException when a non-owner tries to remove', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.remove('event-uuid-1', 'different-user-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
