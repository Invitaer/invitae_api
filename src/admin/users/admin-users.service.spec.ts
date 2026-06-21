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
import { AdminUsersService } from './admin-users.service';
import { DatabaseService } from '../../database/database.service';
import { CryptoService } from '../../crypto/crypto.service';
import { UserRole } from '../../database/schema';

// --- Fixtures ---

const MOCK_USER = {
  id: 'uid-1',
  email: 'alice@test.com',
  name: 'Alice',
  role: UserRole.USER,
  createdAt: new Date(),
};

const MOCK_USER_2 = {
  id: 'uid-2',
  email: 'bob@test.com',
  name: 'Bob',
  role: UserRole.ADMIN,
  createdAt: new Date(),
};

// --- buildMockDb factory ---
// Supports dual select calls: 1st → data chain, 2nd → count chain

function buildMockDb(rows: unknown[] = [], countValue = 0) {
  // Data query chain: .select().from().where().limit().offset()
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const selectWhere = jest.fn().mockReturnValue({ limit });

  // Count query chain: .select().from().where() → resolves directly
  const selectCountWhere = jest.fn().mockResolvedValue([{ count: countValue }]);
  const from = jest.fn().mockReturnValue({ where: selectWhere });
  const fromCount = jest.fn().mockReturnValue({ where: selectCountWhere });

  // select() is called twice: 1st for data, 2nd for count
  let selectCallCount = 0;
  const select = jest.fn().mockImplementation(() => {
    selectCallCount++;
    return selectCallCount === 1 ? { from } : { from: fromCount };
  });

  // Mutation chains
  const returning = jest.fn().mockResolvedValue(rows);
  const mutationWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: mutationWhere });
  const values = jest.fn().mockReturnValue({ returning });
  const deleteWhere = jest.fn().mockReturnValue({ returning });

  return {
    select,
    insert: jest.fn().mockReturnValue({ values }),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    _internals: {
      offset,
      limit,
      selectWhere,
      selectCountWhere,
      returning,
      mutationWhere,
      set,
      values,
      deleteWhere,
    },
  };
}

// --- Mock CryptoService ---

const mockCryptoService = {
  hash: jest.fn().mockResolvedValue('hashed-password'),
};

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  beforeEach(async () => {
    jest.clearAllMocks();
    dbServiceMock = { db: buildMockDb([MOCK_USER, MOCK_USER_2], 2) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: DatabaseService, useValue: dbServiceMock },
        { provide: CryptoService, useValue: mockCryptoService },
      ],
    }).compile();

    service = module.get<AdminUsersService>(AdminUsersService);
  });

  // -----------------------------------------------------------------------
  // findAllPaginated
  // -----------------------------------------------------------------------

  describe('findAllPaginated', () => {
    it('returns { data, total } with SAFE_USER_FIELDS (no password)', async () => {
      const result = await service.findAllPaginated({ page: 1, limit: 10 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 2);
      expect(result.data).toHaveLength(2);
      // password must NEVER appear
      result.data.forEach((u: any) => {
        expect(u).not.toHaveProperty('password');
      });
    });

    it('passes correct limit and offset to db (page=2, limit=5 → offset=5)', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 1);

      await service.findAllPaginated({ page: 2, limit: 5 });

      expect(dbServiceMock.db._internals.limit).toHaveBeenCalledWith(5);
      expect(dbServiceMock.db._internals.offset).toHaveBeenCalledWith(5);
    });

    it('returns total=0 and data=[] when no rows match', async () => {
      dbServiceMock.db = buildMockDb([], 0);

      const result = await service.findAllPaginated({ page: 1, limit: 10 });

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('applies where filter when search is provided', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 1);

      await service.findAllPaginated({ page: 1, limit: 10, search: 'alice' });

      // where should be called on both data and count chains
      expect(dbServiceMock.db._internals.selectWhere).toHaveBeenCalled();
      expect(dbServiceMock.db._internals.selectCountWhere).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // findOne
  // -----------------------------------------------------------------------

  describe('findOne', () => {
    it('returns user without password when found', async () => {
      // Override with a single-select mock (no count query)
      const selectWhere = jest.fn().mockResolvedValue([MOCK_USER]);
      const from = jest.fn().mockReturnValue({ where: selectWhere });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        select: jest.fn().mockReturnValue({ from }),
      } as any;

      const result = await service.findOne('uid-1');

      expect(result).toMatchObject({ id: 'uid-1', name: 'Alice' });
      expect(result).not.toHaveProperty('password');
    });

    it('throws NotFoundException when user not found', async () => {
      const selectWhere = jest.fn().mockResolvedValue([]);
      const from = jest.fn().mockReturnValue({ where: selectWhere });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        select: jest.fn().mockReturnValue({ from }),
      } as any;

      await expect(service.findOne('nonexistent-id')).rejects.toThrow(NotFoundException);
    });
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('calls CryptoService.hash with the plain-text password', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      await service.create({ name: 'Alice', email: 'alice@test.com', password: 'plain-secret', role: UserRole.USER });

      expect(mockCryptoService.hash).toHaveBeenCalledWith('plain-secret');
    });

    it('returns created user without password field', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      const result = await service.create({
        name: 'Alice',
        email: 'alice@test.com',
        password: 'plain-secret',
        role: UserRole.USER,
      });

      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({ id: 'uid-1', name: 'Alice' });
    });

    it('throws ConflictException on unique email violation', async () => {
      const returning = jest.fn().mockRejectedValue({ code: '23505' });
      const values = jest.fn().mockReturnValue({ returning });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        insert: jest.fn().mockReturnValue({ values }),
      } as any;

      await expect(
        service.create({ name: 'Alice', email: 'dup@test.com', password: 'secret', role: UserRole.USER }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // -----------------------------------------------------------------------
  // update
  // -----------------------------------------------------------------------

  describe('update', () => {
    it('re-hashes password when dto.password is provided', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      await service.update('uid-1', { password: 'new-secret' });

      expect(mockCryptoService.hash).toHaveBeenCalledWith('new-secret');
    });

    it('does NOT call CryptoService.hash when password is absent', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      await service.update('uid-1', { name: 'New Name' });

      expect(mockCryptoService.hash).not.toHaveBeenCalled();
    });

    it('returns updated user without password field', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      const result = await service.update('uid-1', { name: 'New Name' });

      expect(result).not.toHaveProperty('password');
    });

    it('throws NotFoundException when user does not exist', async () => {
      const returning = jest.fn().mockResolvedValue([]);
      const mutationWhere = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where: mutationWhere });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        update: jest.fn().mockReturnValue({ set }),
      } as any;

      await expect(service.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove', () => {
    it('resolves void on successful deletion', async () => {
      dbServiceMock.db = buildMockDb([MOCK_USER], 0);

      await expect(service.remove('uid-1')).resolves.toBeUndefined();
    });

    it('throws NotFoundException when user does not exist', async () => {
      const returning = jest.fn().mockResolvedValue([]);
      const deleteWhere = jest.fn().mockReturnValue({ returning });
      dbServiceMock.db = {
        ...dbServiceMock.db,
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as any;

      await expect(service.remove('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
