// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

// --- Fixtures ---

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'admin@test.com',
  name: 'Admin',
  role: UserRole.ADMIN,
};

const MOCK_ADMIN_USER = {
  id: 'uid-1',
  email: 'alice@test.com',
  name: 'Alice',
  role: UserRole.USER,
  createdAt: new Date().toISOString(),
};

const MOCK_ADMIN_USER_2 = {
  id: 'uid-2',
  email: 'bob@test.com',
  name: 'Bob',
  role: UserRole.ADMIN,
  createdAt: new Date().toISOString(),
};

// --- Mock Guards ---

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

// --- Mock AdminUsersService ---

const mockAdminUsersService = {
  findAllPaginated: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

// --- Helper to build app ---

async function buildApp(guardClass: new () => object): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [AdminUsersController],
    providers: [
      { provide: AdminUsersService, useValue: mockAdminUsersService },
    ],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useClass(guardClass)
    .compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
  return app;
}

describe('AdminUsersController', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // GET /admin/users
  // -----------------------------------------------------------------------

  describe('GET /admin/users', () => {
    beforeEach(async () => {
      app = await buildApp(MockJwtGuard);
    });

    it('returns 200 with { data, total } shape', async () => {
      mockAdminUsersService.findAllPaginated.mockResolvedValueOnce({
        data: [MOCK_ADMIN_USER, MOCK_ADMIN_USER_2],
        total: 2,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total', 2);
      expect(response.body.data).toHaveLength(2);
    });

    it('no password field in any data item', async () => {
      mockAdminUsersService.findAllPaginated.mockResolvedValueOnce({
        data: [MOCK_ADMIN_USER],
        total: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      response.body.data.forEach((u: any) => {
        expect(u).not.toHaveProperty('password');
      });
    });

    it('returns 400 on page=abc (invalid param)', async () => {
      await request(app.getHttpServer())
        .get('/admin/users?page=abc')
        .expect(400);
    });

    it('returns 403 when guard rejects', async () => {
      await app.close();
      app = await buildApp(RejectJwtGuard);

      await request(app.getHttpServer())
        .get('/admin/users')
        .expect(403);
    });

    it('calls findAllPaginated with default page=1 and limit=10', async () => {
      mockAdminUsersService.findAllPaginated.mockResolvedValueOnce({ data: [], total: 0 });

      await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      expect(mockAdminUsersService.findAllPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 10 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // POST /admin/users
  // -----------------------------------------------------------------------

  describe('POST /admin/users', () => {
    beforeEach(async () => {
      app = await buildApp(MockJwtGuard);
    });

    it('returns 201 with created user (no password)', async () => {
      mockAdminUsersService.create.mockResolvedValueOnce(MOCK_ADMIN_USER);

      const response = await request(app.getHttpServer())
        .post('/admin/users')
        .send({ name: 'Alice', email: 'alice@test.com', password: 'secret123' })
        .expect(201);

      expect(response.body).toMatchObject({ id: 'uid-1', name: 'Alice' });
      expect(response.body).not.toHaveProperty('password');
    });

    it('returns 400 on missing password', async () => {
      await request(app.getHttpServer())
        .post('/admin/users')
        .send({ name: 'Alice', email: 'alice@test.com' })
        .expect(400);
    });

    it('returns 400 on invalid role value', async () => {
      await request(app.getHttpServer())
        .post('/admin/users')
        .send({ name: 'Alice', email: 'alice@test.com', password: 'secret', role: 'superadmin' })
        .expect(400);
    });

    it('returns 409 on duplicate email', async () => {
      mockAdminUsersService.create.mockRejectedValueOnce(
        new ConflictException('A user with this email already exists'),
      );

      await request(app.getHttpServer())
        .post('/admin/users')
        .send({ name: 'Alice', email: 'dup@test.com', password: 'secret123' })
        .expect(409);
    });

    it('returns 403 without auth', async () => {
      await app.close();
      app = await buildApp(RejectJwtGuard);

      await request(app.getHttpServer())
        .post('/admin/users')
        .send({ name: 'Alice', email: 'alice@test.com', password: 'secret123' })
        .expect(403);
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /admin/users/:id
  // -----------------------------------------------------------------------

  describe('PATCH /admin/users/:id', () => {
    beforeEach(async () => {
      app = await buildApp(MockJwtGuard);
    });

    it('returns 200 with updated user (no password)', async () => {
      const updated = { ...MOCK_ADMIN_USER, name: 'Alice Updated' };
      mockAdminUsersService.update.mockResolvedValueOnce(updated);

      const response = await request(app.getHttpServer())
        .patch('/admin/users/uid-1')
        .send({ name: 'Alice Updated' })
        .expect(200);

      expect(response.body).toMatchObject({ name: 'Alice Updated' });
      expect(response.body).not.toHaveProperty('password');
    });

    it('returns 404 on unknown id', async () => {
      mockAdminUsersService.update.mockRejectedValueOnce(
        new NotFoundException('User not found'),
      );

      await request(app.getHttpServer())
        .patch('/admin/users/nonexistent-id')
        .send({ name: 'X' })
        .expect(404);
    });

    it('returns 403 without auth', async () => {
      await app.close();
      app = await buildApp(RejectJwtGuard);

      await request(app.getHttpServer())
        .patch('/admin/users/uid-1')
        .send({ name: 'X' })
        .expect(403);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /admin/users/:id
  // -----------------------------------------------------------------------

  describe('DELETE /admin/users/:id', () => {
    beforeEach(async () => {
      app = await buildApp(MockJwtGuard);
    });

    it('returns 204 on successful deletion', async () => {
      mockAdminUsersService.remove.mockResolvedValueOnce(undefined);

      await request(app.getHttpServer())
        .delete('/admin/users/uid-1')
        .expect(204);

      expect(mockAdminUsersService.remove).toHaveBeenCalledWith('uid-1');
    });

    it('returns 404 on unknown id', async () => {
      mockAdminUsersService.remove.mockRejectedValueOnce(
        new NotFoundException('User not found'),
      );

      await request(app.getHttpServer())
        .delete('/admin/users/nonexistent-id')
        .expect(404);
    });

    it('returns 403 without auth', async () => {
      await app.close();
      app = await buildApp(RejectJwtGuard);

      await request(app.getHttpServer())
        .delete('/admin/users/uid-1')
        .expect(403);
    });
  });
});
