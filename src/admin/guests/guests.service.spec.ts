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
  tickets: 1,
  tableNumber: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_GUEST_E2 = {
  id: 'guest-uuid-2',
  eventId: 'event-uuid-2',
  name: 'Bob',
  phone: '987654321',
  tickets: 1,
  tableNumber: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildMockDb(guestRows: unknown[] = [], phoneRows: unknown[] = []) {
  // Support multiple select/insert calls in sequence using mockReturnValueOnce
  const selectResults = [guestRows, phoneRows];
  const insertResults = [guestRows, phoneRows];

  const makeSelectChain = (rows: unknown[]) => {
    const whereResolved = jest.fn().mockResolvedValue(rows);
    const from = jest.fn().mockReturnValue({ where: whereResolved });
    return { from };
  };

  const makeInsertChain = (rows: unknown[]) => {
    const returning = jest.fn().mockResolvedValue(rows);
    const values = jest.fn().mockReturnValue({ returning });
    return { values };
  };

  const selectChains = selectResults.map((r) => makeSelectChain(r));
  const insertChains = insertResults.map((r) => makeInsertChain(r));

  const select = jest
    .fn()
    .mockReturnValueOnce(selectChains[0])
    .mockReturnValueOnce(selectChains[1])
    .mockReturnValue(selectChains[0]); // fallback

  const insert = jest
    .fn()
    .mockReturnValueOnce(insertChains[0])
    .mockReturnValueOnce(insertChains[1])
    .mockReturnValue(insertChains[0]); // fallback

  const mutationReturning = jest.fn().mockResolvedValue(guestRows);
  const mutationWhere = jest
    .fn()
    .mockReturnValue({ returning: mutationReturning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });

  const deleteReturning = jest.fn().mockResolvedValue(guestRows);
  const deleteWhere = jest.fn().mockReturnValue({ returning: deleteReturning });

  const db: Record<string, unknown> = {
    select,
    insert,
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
  };

  // Native Drizzle transaction API: db.transaction(async (tx) => {...})
  // The mock invokes the callback with the SAME db object as tx, so the
  // existing chaining keeps working inside the transaction.
  db.transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(db));

  return db as {
    select: typeof select;
    insert: typeof insert;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
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

      expect(result).toEqual(expect.objectContaining(MOCK_GUEST_E1));
      expect(result.eventId).toBe('event-uuid-1');
    });
  });

  describe('findAll', () => {
    it('returns only guests belonging to the given eventId', async () => {
      dbServiceMock.db = buildMockDb([MOCK_GUEST_E1]);

      const result = await service.findAll('event-uuid-1');

      expect(result[0]).toEqual(expect.objectContaining(MOCK_GUEST_E1));
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

      expect(result).toEqual(expect.objectContaining(MOCK_GUEST_E1));
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

      expect(result).toEqual(expect.objectContaining(updated));
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

  describe('create with additionalPhones', () => {
    it('inserts additional phones into guest_phones table', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb(
        [guestRow],
        [{ id: 'phone-1', guestId: 'guest-uuid-1', phone: '999' }],
      );

      const result = await service.create('event-uuid-1', {
        name: 'Alice',
        phone: '123456789',
        additionalPhones: ['999'],
      });

      expect(result.additionalPhones).toEqual(['999']);
    });

    it('returns empty additionalPhones when none provided', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb([guestRow], []);

      const result = await service.create('event-uuid-1', {
        name: 'Alice',
        phone: '123456789',
      });

      expect(result.additionalPhones).toEqual([]);
    });
  });

  describe('update replacing additionalPhones', () => {
    it('replaces phones when additionalPhones is provided', async () => {
      const guestRow = { ...MOCK_GUEST_E1, name: 'Alice Updated' };
      dbServiceMock.db = buildMockDb(
        [guestRow],
        [{ id: 'phone-2', guestId: 'guest-uuid-1', phone: '888' }],
      );

      const result = await service.update('event-uuid-1', 'guest-uuid-1', {
        name: 'Alice Updated',
        additionalPhones: ['888'],
      });

      expect(result.additionalPhones).toEqual(['888']);
    });
  });

  describe('transactional integrity', () => {
    it('wraps create in a transaction', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb([guestRow], []);

      await service.create('event-uuid-1', {
        name: 'Alice',
        phone: '123456789',
        additionalPhones: ['999'],
      });

      expect(dbServiceMock.db.transaction).toHaveBeenCalledTimes(1);
    });

    it('wraps update in a transaction', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb([guestRow], []);

      await service.update('event-uuid-1', 'guest-uuid-1', {
        additionalPhones: ['888'],
      });

      expect(dbServiceMock.db.transaction).toHaveBeenCalledTimes(1);
    });

    it('propagates the error (rolls back) when guest_phones insert fails during create', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb([guestRow], []);
      // First insert (guests) succeeds, second insert (guest_phones) rejects
      const failingReturning = jest
        .fn()
        .mockResolvedValueOnce([guestRow]) // guests insert OK
        .mockRejectedValueOnce(new Error('phones insert failed')); // guest_phones fails
      dbServiceMock.db.insert = jest
        .fn()
        .mockReturnValue({ values: jest.fn().mockReturnValue({ returning: failingReturning }) });

      await expect(
        service.create('event-uuid-1', {
          name: 'Alice',
          phone: '123456789',
          additionalPhones: ['999'],
        }),
      ).rejects.toThrow('phones insert failed');
    });
  });

  describe('findAll with additionalPhones', () => {
    it('attaches additionalPhones to each guest', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb(
        [guestRow],
        [
          {
            id: 'phone-1',
            guestId: 'guest-uuid-1',
            phone: '777',
            createdAt: new Date(),
          },
        ],
      );

      const result = await service.findAll('event-uuid-1');

      expect(result[0].additionalPhones).toEqual(['777']);
    });
  });

  describe('findOne with additionalPhones', () => {
    it('attaches additionalPhones to the guest', async () => {
      const guestRow = { ...MOCK_GUEST_E1 };
      dbServiceMock.db = buildMockDb(
        [guestRow],
        [
          {
            id: 'phone-1',
            guestId: 'guest-uuid-1',
            phone: '555',
            createdAt: new Date(),
          },
        ],
      );

      const result = await service.findOne('event-uuid-1', 'guest-uuid-1');

      expect(result.additionalPhones).toEqual(['555']);
    });
  });
});
