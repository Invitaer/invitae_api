// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { AdminUsersService } from './admin-users.service';
import { DatabaseService } from '../../database/database.service';

const mockUsers = [
  { id: 'uid-1', email: 'alice@test.com', name: 'Alice' },
  { id: 'uid-2', email: 'bob@test.com', name: 'Bob' },
];

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let dbServiceMock: { db: any };

  beforeEach(async () => {
    const selectWhere = jest.fn().mockResolvedValue(mockUsers);
    const from = jest.fn().mockReturnValue(mockUsers);

    dbServiceMock = {
      db: {
        select: jest.fn().mockReturnValue({ from }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<AdminUsersService>(AdminUsersService);
  });

  describe('findAll', () => {
    it('should return an array of users with id, name, and email', async () => {
      const result = await service.findAll();

      expect(result).toEqual(mockUsers);
    });

    it('should return an empty array when no users exist', async () => {
      const emptyFrom = jest.fn().mockReturnValue([]);
      dbServiceMock.db = {
        select: jest.fn().mockReturnValue({ from: emptyFrom }),
      };

      // Recreate service with new mock
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AdminUsersService,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const svc = module.get<AdminUsersService>(AdminUsersService);

      const result = await svc.findAll();
      expect(result).toEqual([]);
    });
  });
});
