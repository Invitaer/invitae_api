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
import { UserRole } from '../../database/schema';

const mockEvent = {
  id: 'event-uuid-1',
  userId: 'user-uuid-1',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10'),
  createdAt: new Date(),
  eventType: 'general',
  location: null as string | null,
};

const mockEventB = {
  id: 'event-uuid-2',
  userId: 'user-uuid-1',
  name: 'Corporate Gala',
  slug: 'corporate-gala-2025',
  date: new Date('2025-11-01'),
  createdAt: new Date(),
  eventType: 'general',
  location: null as string | null,
};

const mockAlice = {
  id: 'user-uuid-alice',
  name: 'Alice',
  email: 'alice@test.com',
};
const mockBob = { id: 'user-uuid-bob', name: 'Bob', email: 'bob@test.com' };
const mockCarol = {
  id: 'user-uuid-carol',
  name: 'Carol',
  email: 'carol@test.com',
};

/**
 * Builds a mock DatabaseService.
 *
 * For the read path (select), `rows` are the raw joined rows returned by
 * `from().leftJoin().leftJoin().where()`, shaped as `{ event, assignedUser }`
 * (`assignedUser` is `null` when there is no matching `eventUsers` row).
 * `leftJoin` self-chains so the mock supports any number of joins.
 */
function buildMockDb(rows: unknown[] = []) {
  const returning = jest.fn().mockResolvedValue(rows);
  const mutationWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });
  const values = jest.fn().mockReturnValue({ returning });
  const deleteWhere = jest.fn().mockReturnValue({ returning });

  const selectWhere = jest.fn().mockResolvedValue(rows);
  const selectChain: any = { where: selectWhere };
  selectChain.leftJoin = jest.fn().mockReturnValue(selectChain);
  const from = jest.fn().mockReturnValue(selectChain);

  return {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values }),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    _internals: { returning, mutationWhere, set, values, deleteWhere, selectWhere, from },
  };
}

/**
 * Build a mock DB that handles two insert calls: first for events, second for eventUsers.
 * eventRows — rows returned by the events INSERT
 * eventUserInsertValues — spy that captures what was inserted into event_users
 */
function buildMockDbForUserIds(eventRows: unknown[] = []) {
  const eventUsersReturning = jest.fn().mockResolvedValue([]);
  const eventUsersValues = jest.fn().mockReturnValue({ returning: eventUsersReturning });

  const eventsReturning = jest.fn().mockResolvedValue(eventRows);
  const eventsValues = jest.fn().mockReturnValue({ returning: eventsReturning });

  const deleteReturning = jest.fn().mockResolvedValue([]);
  const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });

  // insert is called twice: first for events, second for event_users
  const insertMock = jest.fn()
    .mockReturnValueOnce({ values: eventsValues })
    .mockReturnValueOnce({ values: eventUsersValues });

  const selectWhere = jest.fn().mockResolvedValue(eventRows);
  const from = jest.fn().mockReturnValue({ where: selectWhere });

  const mutationWhere = jest.fn().mockReturnValue({ returning: eventsReturning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });

  return {
    select: jest.fn().mockReturnValue({ from }),
    insert: insertMock,
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    _internals: {
      insertMock,
      eventsValues,
      eventsReturning,
      eventUsersValues,
      eventUsersReturning,
      deleteWhere,
      deleteReturning,
    },
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
        eventType: 'wedding',
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
          eventType: 'wedding',
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
          eventType: 'wedding',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return an event with an empty users array when it has no assigned users', async () => {
      dbServiceMock.db = buildMockDb([{ event: mockEvent, assignedUser: null }]);

      const result = await service.findAll('user-uuid-1');

      expect(result).toEqual([{ ...mockEvent, users: [] }]);
    });

    it('should return empty array when user has no events', async () => {
      dbServiceMock.db = buildMockDb([]);

      const result = await service.findAll('user-uuid-2');

      expect(result).toEqual([]);
    });

    it('should group multiple assigned users into a single event', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
        { event: mockEvent, assignedUser: mockBob },
      ]);

      const result = await service.findAll('user-uuid-1');

      expect(result).toEqual([{ ...mockEvent, users: [mockAlice, mockBob] }]);
    });

    it('should group joined rows into separate events by event id', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
        { event: mockEvent, assignedUser: mockBob },
        { event: mockEventB, assignedUser: mockCarol },
      ]);

      const result = await service.findAll('user-uuid-1');

      expect(result).toEqual([
        { ...mockEvent, users: [mockAlice, mockBob] },
        { ...mockEventB, users: [mockCarol] },
      ]);
    });
  });

  describe('findAll — role-based visibility', () => {
    it('should filter by ownership for a USER role (where clause applied)', async () => {
      const mockDb = buildMockDb([{ event: mockEvent, assignedUser: null }]);
      dbServiceMock.db = mockDb;

      await service.findAll('user-uuid-1', UserRole.USER);

      // ownership filter passed to .where() must be defined
      expect(mockDb._internals.selectWhere).toHaveBeenCalledTimes(1);
      expect(mockDb._internals.selectWhere.mock.calls[0][0]).toBeDefined();
    });

    it('should filter by ownership when no role is provided', async () => {
      const mockDb = buildMockDb([{ event: mockEvent, assignedUser: null }]);
      dbServiceMock.db = mockDb;

      await service.findAll('user-uuid-1');

      expect(mockDb._internals.selectWhere.mock.calls[0][0]).toBeDefined();
    });

    it('should NOT filter by ownership for SUPER_ADMIN (sees all events)', async () => {
      const mockDb = buildMockDb([
        { event: mockEvent, assignedUser: null },
        { event: mockEventB, assignedUser: null },
      ]);
      dbServiceMock.db = mockDb;

      const result = await service.findAll('any-user', UserRole.SUPER_ADMIN);

      // no ownership filter → where() called with undefined
      expect(mockDb._internals.selectWhere).toHaveBeenCalledTimes(1);
      expect(mockDb._internals.selectWhere.mock.calls[0][0]).toBeUndefined();
      expect(result).toHaveLength(2);
    });

    it('should NOT filter by ownership for ADMIN (sees all events)', async () => {
      const mockDb = buildMockDb([
        { event: mockEvent, assignedUser: null },
        { event: mockEventB, assignedUser: null },
      ]);
      dbServiceMock.db = mockDb;

      const result = await service.findAll('any-user', UserRole.ADMIN);

      expect(mockDb._internals.selectWhere.mock.calls[0][0]).toBeUndefined();
      expect(result).toHaveLength(2);
    });
  });

  describe('findOne', () => {
    it('should return the event with users when found', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
      ]);

      const result = await service.findOne('event-uuid-1');

      expect(result).toEqual({ ...mockEvent, users: [mockAlice] });
    });

    it('should return the event with an empty users array when it has no assigned users', async () => {
      dbServiceMock.db = buildMockDb([{ event: mockEvent, assignedUser: null }]);

      const result = await service.findOne('event-uuid-1');

      expect(result).toEqual({ ...mockEvent, users: [] });
    });

    it('should group multiple assigned users for a single event', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
        { event: mockEvent, assignedUser: mockBob },
      ]);

      const result = await service.findOne('event-uuid-1');

      expect(result).toEqual({ ...mockEvent, users: [mockAlice, mockBob] });
    });

    it('should throw NotFoundException when event does not exist', async () => {
      dbServiceMock.db = buildMockDb([]);

      await expect(service.findOne('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findOne — ownership filter', () => {
    it('should return the event when userId matches (ownership check passes)', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
      ]);

      const result = await service.findOne('event-uuid-1', 'user-uuid-1');

      expect(result).toEqual({ ...mockEvent, users: [mockAlice] });
    });

    it('should throw NotFoundException when userId does not match (ownership check fails)', async () => {
      // mock returns empty array — as if DB found no row with (id AND userId)
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.findOne('event-uuid-1', 'different-user-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return event without ownership filter when userId is not provided (backward compat)', async () => {
      dbServiceMock.db = buildMockDb([{ event: mockEvent, assignedUser: null }]);

      const result = await service.findOne('event-uuid-1');

      expect(result).toEqual({ ...mockEvent, users: [] });
      expect(result.id).toBe('event-uuid-1');
    });

    it('should return an event owned by another user when caller is SUPER_ADMIN', async () => {
      // mockEvent.userId is 'user-uuid-1'; caller id differs but role bypasses ownership
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
      ]);

      const result = await service.findOne(
        'event-uuid-1',
        'a-different-admin-id',
        UserRole.SUPER_ADMIN,
      );

      expect(result).toEqual({ ...mockEvent, users: [mockAlice] });
    });

    it('should return an event owned by another user when caller is ADMIN', async () => {
      dbServiceMock.db = buildMockDb([
        { event: mockEvent, assignedUser: mockAlice },
      ]);

      const result = await service.findOne(
        'event-uuid-1',
        'a-different-admin-id',
        UserRole.ADMIN,
      );

      expect(result).toEqual({ ...mockEvent, users: [mockAlice] });
    });

    it('should still enforce ownership for a USER role opening another user event', async () => {
      // DB returns empty because (id AND userId) does not match → NotFound
      dbServiceMock.db = buildMockDb([]);

      await expect(
        service.findOne('event-uuid-1', 'different-user-id', UserRole.USER),
      ).rejects.toThrow(NotFoundException);
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

  describe('create — userIds sync', () => {
    it('should bulk-insert event_users rows when userIds is provided and non-empty', async () => {
      const mockDb = buildMockDbForUserIds([mockEvent]);
      dbServiceMock.db = mockDb as any;

      await service.create('user-uuid-1', {
        name: 'My Wedding',
        slug: 'my-wedding-2025',
        date: '2025-10-10',
        eventType: 'wedding',
        userIds: ['uid-1', 'uid-2'],
      });

      // insert was called twice: once for events, once for event_users
      expect(mockDb._internals.insertMock).toHaveBeenCalledTimes(2);

      // second insert received the mapped event_users rows
      const eventUsersPayload = mockDb._internals.eventUsersValues.mock.calls[0][0] as Array<{ eventId: string; userId: string }>;
      expect(eventUsersPayload).toHaveLength(2);
      expect(eventUsersPayload[0]).toMatchObject({ eventId: mockEvent.id, userId: 'uid-1' });
      expect(eventUsersPayload[1]).toMatchObject({ eventId: mockEvent.id, userId: 'uid-2' });
    });

    it('should NOT insert event_users rows when userIds is absent', async () => {
      const mockDb = buildMockDbForUserIds([mockEvent]);
      dbServiceMock.db = mockDb as any;

      await service.create('user-uuid-1', {
        name: 'My Wedding',
        slug: 'my-wedding-2025',
        date: '2025-10-10',
        eventType: 'wedding',
      });

      // insert called only once (for events); no event_users insert
      expect(mockDb._internals.insertMock).toHaveBeenCalledTimes(1);
    });

    it('should NOT insert event_users rows when userIds is an empty array', async () => {
      const mockDb = buildMockDbForUserIds([mockEvent]);
      dbServiceMock.db = mockDb as any;

      await service.create('user-uuid-1', {
        name: 'My Wedding',
        slug: 'my-wedding-2025',
        date: '2025-10-10',
        eventType: 'wedding',
        userIds: [],
      });

      expect(mockDb._internals.insertMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('update — userIds replace-set', () => {
    it('should delete-then-insert event_users when userIds is provided', async () => {
      const updatedEvent = { ...mockEvent, name: 'Updated' };

      // For update scenario: db.update() returns event, db.delete() clears, db.insert() re-inserts
      const eventUsersReturning = jest.fn().mockResolvedValue([]);
      const eventUsersValues = jest.fn().mockReturnValue({ returning: eventUsersReturning });
      const insertMock = jest.fn().mockReturnValue({ values: eventUsersValues });

      const deleteReturning = jest.fn().mockResolvedValue([]);
      const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });

      const updateReturning = jest.fn().mockResolvedValue([updatedEvent]);
      const updateMutWhere = jest.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = jest.fn().mockReturnValue({ where: updateMutWhere });

      const mockDb = {
        insert: insertMock,
        update: jest.fn().mockReturnValue({ set: updateSet }),
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
        select: jest.fn(),
        _internals: { insertMock, eventUsersValues, deleteWhere },
      };
      dbServiceMock.db = mockDb as any;

      await service.update('event-uuid-1', 'user-uuid-1', {
        name: 'Updated',
        userIds: ['uid-new'],
      });

      // delete called for event_users
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      // insert called once for event_users re-insertion
      expect(insertMock).toHaveBeenCalledTimes(1);
      const insertPayload = eventUsersValues.mock.calls[0][0] as Array<{ eventId: string; userId: string }>;
      expect(insertPayload).toHaveLength(1);
      expect(insertPayload[0]).toMatchObject({ eventId: 'event-uuid-1', userId: 'uid-new' });
    });

    it('should delete all event_users but NOT re-insert when userIds is empty array', async () => {
      const updatedEvent = { ...mockEvent };

      const deleteReturning = jest.fn().mockResolvedValue([]);
      const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });

      const updateReturning = jest.fn().mockResolvedValue([updatedEvent]);
      const updateMutWhere = jest.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = jest.fn().mockReturnValue({ where: updateMutWhere });

      const insertMock = jest.fn();
      const mockDb = {
        insert: insertMock,
        update: jest.fn().mockReturnValue({ set: updateSet }),
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
        select: jest.fn(),
      };
      dbServiceMock.db = mockDb as any;

      await service.update('event-uuid-1', 'user-uuid-1', {
        name: 'Same',
        userIds: [],
      });

      // delete called once
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      // insert NOT called (no users to re-insert)
      expect(insertMock).toHaveBeenCalledTimes(0);
    });

    it('should NOT touch event_users when userIds is undefined', async () => {
      const mockDb = buildMockDb([mockEvent]);
      dbServiceMock.db = mockDb as any;

      await service.update('event-uuid-1', 'user-uuid-1', {
        name: 'No change to users',
      });

      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
