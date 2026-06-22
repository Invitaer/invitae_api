// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserEventsService } from './user-events.service';
import { DatabaseService } from '../../database/database.service';

const mockEvent = {
  id: 'event-uuid-1',
  userId: 'creator-uuid',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10'),
  createdAt: new Date(),
  eventType: 'general',
  location: null as string | null,
};

describe('UserEventsService', () => {
  let service: UserEventsService;
  let dbServiceMock: { db: any };

  const buildMockDb = () => {
    const selectWhere = jest.fn().mockResolvedValue([mockEvent]);
    const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });

    const mutReturning = jest.fn().mockResolvedValue([mockEvent]);
    const mutWhere = jest.fn().mockReturnValue({ returning: mutReturning });
    const set = jest.fn().mockReturnValue({ where: mutWhere });

    return {
      select: jest.fn().mockReturnValue({ from }),
      update: jest.fn().mockReturnValue({ set }),
      insert: jest.fn(),
      delete: jest.fn(),
      _internals: { from, innerJoin, selectWhere, set, mutWhere, mutReturning },
    };
  };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<UserEventsService>(UserEventsService);
  });

  describe('findByUser', () => {
    it('should return events assigned to the given userId via innerJoin', async () => {
      const result = await service.findByUser('user-uuid-1');

      expect(result).toEqual([mockEvent]);
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when user has no assignments', async () => {
      const selectWhere = jest.fn().mockResolvedValue([]);
      const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
      const from = jest.fn().mockReturnValue({ innerJoin });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        select: jest.fn().mockReturnValue({ from }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventsService,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const svc = module.get<UserEventsService>(UserEventsService);

      const result = await svc.findByUser('user-uuid-no-events');
      expect(result).toEqual([]);
    });
  });

  describe('update', () => {
    it('should throw ForbiddenException when user is not a member of the event', async () => {
      // Membership check: select().from().where() resolves to []
      const membershipWhere = jest.fn().mockResolvedValue([]);
      const membershipFrom = jest.fn().mockReturnValue({ where: membershipWhere });

      dbServiceMock.db = {
        ...buildMockDb(),
        select: jest.fn().mockReturnValue({ from: membershipFrom }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventsService,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const svc = module.get<UserEventsService>(UserEventsService);

      await expect(
        svc.update('event-uuid-1', 'non-member-id', { name: 'Hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should update and return the event when user is a member', async () => {
      const membership = [{ id: 'eu-1', eventId: 'event-uuid-1', userId: 'user-uuid-1' }];

      // Membership check resolves to a membership row
      const membershipWhere = jest.fn().mockResolvedValue(membership);
      const membershipFrom = jest.fn().mockReturnValue({ where: membershipWhere });

      const updateReturning = jest.fn().mockResolvedValue([mockEvent]);
      const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

      dbServiceMock.db = {
        ...buildMockDb(),
        select: jest.fn().mockReturnValue({ from: membershipFrom }),
        update: jest.fn().mockReturnValue({ set: updateSet }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventsService,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const svc = module.get<UserEventsService>(UserEventsService);

      const result = await svc.update('event-uuid-1', 'user-uuid-1', { name: 'Updated' });

      expect(result).toEqual(mockEvent);
      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('should throw NotFoundException when member but event not found after update', async () => {
      const membership = [{ id: 'eu-1', eventId: 'event-uuid-1', userId: 'user-uuid-1' }];

      // Membership check resolves to a membership row
      const membershipWhere = jest.fn().mockResolvedValue(membership);
      const membershipFrom = jest.fn().mockReturnValue({ where: membershipWhere });

      const updateReturning = jest.fn().mockResolvedValue([]); // event not found
      const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

      dbServiceMock.db = {
        ...buildMockDb(),
        select: jest.fn().mockReturnValue({ from: membershipFrom }),
        update: jest.fn().mockReturnValue({ set: updateSet }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventsService,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const svc = module.get<UserEventsService>(UserEventsService);

      await expect(
        svc.update('event-uuid-1', 'user-uuid-1', { name: 'Updated' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

// -----------------------------------------------------------------------
// T1.11 — findOne + getStats specs
// -----------------------------------------------------------------------

describe('UserEventsService — findOne', () => {
  function buildFindOneMockDb(rows: unknown[]) {
    const selectWhere = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });
    return { select: jest.fn().mockReturnValue({ from }) };
  }

  it('returns the event when user is a member', async () => {
    const db = buildFindOneMockDb([mockEvent]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: DatabaseService, useValue: { db } },
      ],
    }).compile();
    const svc = module.get<UserEventsService>(UserEventsService);

    const result = await svc.findOne('event-uuid-1', 'user-uuid-1');
    expect(result).toEqual(mockEvent);
  });

  it('throws NotFoundException when event is not found / user is not a member', async () => {
    const db = buildFindOneMockDb([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: DatabaseService, useValue: { db } },
      ],
    }).compile();
    const svc = module.get<UserEventsService>(UserEventsService);

    await expect(svc.findOne('event-uuid-1', 'user-uuid-99')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('UserEventsService — getStats', () => {
  // Drizzle sql<number> aggregates return strings from the pg driver
  const statsRow = { total: '6', accepted: '3', declined: '2', pending: '1' };

  function buildStatsMockDb(rows: unknown[]) {
    const selectWhere = jest.fn().mockResolvedValue(rows);
    const from = jest.fn().mockReturnValue({ where: selectWhere });
    return { select: jest.fn().mockReturnValue({ from }) };
  }

  it('returns computed stats with correct totals when guests exist', async () => {
    const db = buildStatsMockDb([statsRow]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: DatabaseService, useValue: { db } },
      ],
    }).compile();
    const svc = module.get<UserEventsService>(UserEventsService);

    const result = await svc.getStats('event-uuid-1');

    expect(result).toEqual({
      total: 6,
      confirmed: 5,   // accepted + declined
      notConfirmed: 1, // pending
      accepted: 3,
      notAccepted: 2,  // declined
    });
  });

  it('returns all zeros for an empty event', async () => {
    const emptyRow = { total: '0', accepted: '0', declined: '0', pending: '0' };
    const db = buildStatsMockDb([emptyRow]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: DatabaseService, useValue: { db } },
      ],
    }).compile();
    const svc = module.get<UserEventsService>(UserEventsService);

    const result = await svc.getStats('event-uuid-1');

    expect(result).toEqual({
      total: 0,
      confirmed: 0,
      notConfirmed: 0,
      accepted: 0,
      notAccepted: 0,
    });
  });
});
