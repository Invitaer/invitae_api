// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'admin@test.com',
  name: 'Admin',
};

const MOCK_USERS = [
  { id: 'uid-1', email: 'alice@test.com', name: 'Alice' },
  { id: 'uid-2', email: 'bob@test.com', name: 'Bob' },
];

class MockJwtGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = MOCK_USER;
    return true;
  }
}

class RejectJwtGuard {
  canActivate() {
    return false;
  }
}

const mockAdminUsersService = {
  findAll: jest.fn(),
};

describe('AdminUsersController', () => {
  describe('authenticated requests', () => {
    let app: INestApplication;

    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AdminUsersController],
        providers: [
          { provide: AdminUsersService, useValue: mockAdminUsersService },
        ],
      })
        .overrideGuard(AuthGuard('jwt'))
        .useClass(MockJwtGuard)
        .compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('GET /admin/users returns 200 with user array', async () => {
      mockAdminUsersService.findAll.mockResolvedValueOnce(MOCK_USERS);

      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({ id: 'uid-1', email: 'alice@test.com', name: 'Alice' });
      expect(mockAdminUsersService.findAll).toHaveBeenCalledTimes(1);
    });

    it('GET /admin/users returns 200 with empty array when no users', async () => {
      mockAdminUsersService.findAll.mockResolvedValueOnce([]);

      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('unauthenticated requests', () => {
    let app: INestApplication;

    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AdminUsersController],
        providers: [
          { provide: AdminUsersService, useValue: mockAdminUsersService },
        ],
      })
        .overrideGuard(AuthGuard('jwt'))
        .useClass(RejectJwtGuard)
        .compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('GET /admin/users returns 403 when guard rejects', async () => {
      await request(app.getHttpServer())
        .get('/admin/users')
        .expect(403);
    });
  });
});
