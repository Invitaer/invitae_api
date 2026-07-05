// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { DatabaseService } from '../database/database.service';

const mockGuestA = {
  id: 'guest-uuid-1',
  eventId: 'event-uuid-1',
  name: 'Alice',
  phone: '111',
  email: null,
  tableId: null,
  tickets: 1,
  tableNumber: null,
  rsvpStatus: 'PENDING',
  invitationSent: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockGuestB = { ...mockGuestA, id: 'guest-uuid-2', name: 'Bob', phone: '222' };

/**
 * Mock DatabaseService whose `select().from().where()` chain resolves to `rows`.
 * `where` is the terminal and captures the passed condition for assertions.
 */
function buildMockDb(rows: unknown[] = []) {
  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  return {
    select: jest.fn().mockReturnValue({ from }),
    _internals: { where, from },
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('notifySelected', () => {
    it('returns a mock/pending result with the resolved recipients', async () => {
      dbServiceMock.db = buildMockDb([mockGuestA, mockGuestB]);

      const result = await service.notifySelected('event-uuid-1', [
        'guest-uuid-1',
        'guest-uuid-2',
      ]);

      expect(result).toEqual({
        status: 'mock',
        pending: true,
        notifiedCount: 2,
        recipients: [
          { id: 'guest-uuid-1', name: 'Alice', phone: '111' },
          { id: 'guest-uuid-2', name: 'Bob', phone: '222' },
        ],
      });
    });

    it('short-circuits without querying when guestIds is empty', async () => {
      const result = await service.notifySelected('event-uuid-1', []);

      expect(result).toEqual({
        status: 'mock',
        pending: true,
        notifiedCount: 0,
        recipients: [],
      });
      expect(dbServiceMock.db.select).not.toHaveBeenCalled();
    });
  });

  describe('notifyAll', () => {
    it('returns every guest of the event as a mock/pending result', async () => {
      dbServiceMock.db = buildMockDb([mockGuestA, mockGuestB]);

      const result = await service.notifyAll('event-uuid-1');

      expect(result.notifiedCount).toBe(2);
      expect(result.status).toBe('mock');
      expect(result.pending).toBe(true);
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyPending', () => {
    it('returns a mock/pending result scoped to pending guests', async () => {
      dbServiceMock.db = buildMockDb([mockGuestA]);

      const result = await service.notifyPending('event-uuid-1');

      expect(result).toMatchObject({
        status: 'mock',
        pending: true,
        notifiedCount: 1,
      });
      expect(dbServiceMock.db._internals.where).toHaveBeenCalledTimes(1);
    });
  });
});
