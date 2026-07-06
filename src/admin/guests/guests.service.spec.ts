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

  describe('findAllPaginated', () => {
    // Chain: 1st select -> data (from.where.limit.offset), 2nd select -> count
    // (from.where), 3rd select -> phone hydration for the returned slice only
    // (from.where).
    function buildPaginatedMockDb(
      dataRows: unknown[],
      countValue: number,
      phoneRows: unknown[] = [],
    ) {
      const offset = jest.fn().mockResolvedValue(dataRows);
      const limit = jest.fn().mockReturnValue({ offset });
      const dataWhere = jest.fn().mockReturnValue({ limit });
      const dataFrom = jest.fn().mockReturnValue({ where: dataWhere });

      const countWhere = jest.fn().mockResolvedValue([{ count: countValue }]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      const phoneWhere = jest.fn().mockResolvedValue(phoneRows);
      const phoneFrom = jest.fn().mockReturnValue({ where: phoneWhere });

      let call = 0;
      const select = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return { from: dataFrom };
        if (call === 2) return { from: countFrom };
        return { from: phoneFrom };
      });

      return {
        select,
        _internals: {
          offset,
          limit,
          dataWhere,
          dataFrom,
          countWhere,
          countFrom,
          phoneWhere,
          phoneFrom,
        },
      };
    }

    it('returns { data, total } with default page=1/limit=10', async () => {
      dbServiceMock.db = buildPaginatedMockDb(
        [MOCK_GUEST_E1],
        1,
      ) as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findAllPaginated('event-uuid-1', {
        page: 1,
        limit: 10,
      });

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual(
        expect.objectContaining({ id: 'guest-uuid-1', additionalPhones: [] }),
      );
    });

    it('computes offset from page/limit (page=3, limit=5 -> offset=10)', async () => {
      const mockDb = buildPaginatedMockDb([MOCK_GUEST_E1], 1);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      await service.findAllPaginated('event-uuid-1', { page: 3, limit: 5 });

      expect(mockDb._internals.limit).toHaveBeenCalledWith(5);
      expect(mockDb._internals.offset).toHaveBeenCalledWith(10);
    });

    it('returns data=[] and total=0 when no guests match, without querying phones', async () => {
      const mockDb = buildPaginatedMockDb([], 0);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findAllPaginated('event-uuid-1', {
        page: 1,
        limit: 10,
      });

      expect(result).toEqual({ data: [], total: 0 });
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });

    it('returns data=[] but the REAL total when the page is past the end (offset overflow)', async () => {
      // page far beyond the data, but 45 guests genuinely match the filter
      const mockDb = buildPaginatedMockDb([], 45);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findAllPaginated('event-uuid-1', {
        page: 99,
        limit: 10,
      });

      expect(result).toEqual({ data: [], total: 45 });
      // count query is independent of the (empty) data slice
      expect(mockDb._internals.offset).toHaveBeenCalledWith(980);
      expect(mockDb.select).toHaveBeenCalledTimes(2); // no phone hydration
    });

    it('hydrates additionalPhones only for the returned page slice', async () => {
      const mockDb = buildPaginatedMockDb(
        [MOCK_GUEST_E1],
        1,
        [{ id: 'phone-1', guestId: 'guest-uuid-1', phone: '999' }],
      );
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findAllPaginated('event-uuid-1', {
        page: 1,
        limit: 10,
      });

      expect(result.data[0].additionalPhones).toEqual(['999']);
    });

    it('applies the SAME filter to both the data query and the count query (search consistency)', async () => {
      const mockDb = buildPaginatedMockDb([MOCK_GUEST_E1], 1);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      await service.findAllPaginated('event-uuid-1', {
        page: 1,
        limit: 10,
        search: 'alice',
      });

      const filterUsedForData = mockDb._internals.dataFrom.mock.calls[0]
        ? mockDb._internals.dataWhere.mock.calls[0][0]
        : undefined;
      const filterUsedForCount = mockDb._internals.countWhere.mock.calls[0][0];

      expect(filterUsedForData).toEqual(filterUsedForCount);
    });
  });

  describe('findMatchingIds', () => {
    function buildIdsMockDb(idRows: { id: string }[]) {
      const where = jest.fn().mockResolvedValue(idRows);
      const from = jest.fn().mockReturnValue({ where });
      return {
        select: jest.fn().mockReturnValue({ from }),
        _internals: { where, from },
      };
    }

    it('returns unpaginated ids matching the filter', async () => {
      const mockDb = buildIdsMockDb([
        { id: 'guest-uuid-1' },
        { id: 'guest-uuid-2' },
      ]);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findMatchingIds('event-uuid-1', 'alice');

      expect(result).toEqual(['guest-uuid-1', 'guest-uuid-2']);
    });

    it('returns all ids of the event when no search is provided', async () => {
      const mockDb = buildIdsMockDb([{ id: 'guest-uuid-1' }]);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findMatchingIds('event-uuid-1');

      expect(result).toEqual(['guest-uuid-1']);
    });

    it('returns an empty array when no guest matches the filter', async () => {
      const mockDb = buildIdsMockDb([]);
      dbServiceMock.db = mockDb as unknown as ReturnType<typeof buildMockDb>;

      const result = await service.findMatchingIds('event-uuid-1', 'zzz');

      expect(result).toEqual([]);
    });
  });
});
