// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';
import { EventOwnerGuard } from '../events/guards/event-owner.guard';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

// --- Fixtures ---

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'owner@test.com',
  name: 'Owner',
  role: UserRole.USER,
};

const MOCK_EVENT = {
  id: 'event-uuid-1',
  userId: 'user-uuid-1',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10'),
  createdAt: new Date(),
};

const MOCK_GUEST = {
  id: 'guest-uuid-1',
  eventId: 'event-uuid-1',
  name: 'Alice',
  phone: '123456789',
  tableId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// --- Mock guards ---

class MockJwtGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = MOCK_USER;
    return true;
  }
}

class MockEventOwnerGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.event = MOCK_EVENT;
    return true;
  }
}

class MockEventOwnerGuardForbidden {
  canActivate() {
    throw new ForbiddenException('You do not own this event');
  }
}

class MockEventOwnerGuardNotFound {
  canActivate() {
    throw new NotFoundException('Event nonexistent-id not found');
  }
}

// --- Mock GuestsService ---

const mockGuestsService = {
  findAll: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

// --- Helper to build app with a specific EventOwnerGuard mock ---

async function buildApp(
  eventOwnerGuardClass: new () => object,
): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [GuestsController],
    providers: [
      { provide: GuestsService, useValue: mockGuestsService },
    ],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useClass(MockJwtGuard)
    .overrideGuard(EventOwnerGuard)
    .useClass(eventOwnerGuardClass)
    .compile();

  const app = module.createNestApplication();
  await app.init();
  return app;
}

describe('GuestsController — nested route integration', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('owner requests', () => {
    beforeEach(async () => {
      app = await buildApp(MockEventOwnerGuard);
    });

    describe('GET /admin/events/:eventId/guests', () => {
      it('returns 200 with guests for the event', async () => {
        mockGuestsService.findAll.mockResolvedValueOnce([MOCK_GUEST]);

        const response = await request(app.getHttpServer())
          .get('/admin/events/event-uuid-1/guests')
          .expect(200);

        expect(response.body).toHaveLength(1);
        expect(mockGuestsService.findAll).toHaveBeenCalledWith(MOCK_EVENT.id);
      });
    });

    describe('GET /admin/events/:eventId/guests/:id', () => {
      it('returns 200 with a single guest', async () => {
        mockGuestsService.findOne.mockResolvedValueOnce(MOCK_GUEST);

        const response = await request(app.getHttpServer())
          .get('/admin/events/event-uuid-1/guests/guest-uuid-1')
          .expect(200);

        expect(response.body).toMatchObject({ id: 'guest-uuid-1' });
        expect(mockGuestsService.findOne).toHaveBeenCalledWith(
          MOCK_EVENT.id,
          'guest-uuid-1',
        );
      });

      it('returns 404 when guest does not exist', async () => {
        mockGuestsService.findOne.mockRejectedValueOnce(
          new NotFoundException('Guest not found'),
        );

        await request(app.getHttpServer())
          .get('/admin/events/event-uuid-1/guests/nonexistent')
          .expect(404);
      });
    });

    describe('POST /admin/events/:eventId/guests', () => {
      it('returns 201 with created guest', async () => {
        mockGuestsService.create.mockResolvedValueOnce(MOCK_GUEST);

        const response = await request(app.getHttpServer())
          .post('/admin/events/event-uuid-1/guests')
          .send({ name: 'Alice', phone: '123456789' })
          .expect(201);

        expect(response.body).toMatchObject({ id: 'guest-uuid-1' });
        expect(mockGuestsService.create).toHaveBeenCalledWith(
          MOCK_EVENT.id,
          expect.objectContaining({ name: 'Alice' }),
        );
      });
    });

    describe('PUT /admin/events/:eventId/guests/:id', () => {
      it('returns 200 with updated guest', async () => {
        const updated = { ...MOCK_GUEST, name: 'Alice Updated' };
        mockGuestsService.update.mockResolvedValueOnce(updated);

        const response = await request(app.getHttpServer())
          .put('/admin/events/event-uuid-1/guests/guest-uuid-1')
          .send({ name: 'Alice Updated' })
          .expect(200);

        expect(response.body).toMatchObject({ name: 'Alice Updated' });
      });
    });

    describe('DELETE /admin/events/:eventId/guests/:id', () => {
      it('returns 204 when guest is removed', async () => {
        mockGuestsService.remove.mockResolvedValueOnce(undefined);

        await request(app.getHttpServer())
          .delete('/admin/events/event-uuid-1/guests/guest-uuid-1')
          .expect(204);

        expect(mockGuestsService.remove).toHaveBeenCalledWith(
          MOCK_EVENT.id,
          'guest-uuid-1',
        );
      });
    });
  });

  describe('non-owner request — EventOwnerGuard blocks with 403', () => {
    beforeEach(async () => {
      app = await buildApp(MockEventOwnerGuardForbidden);
    });

    it('returns 403 when accessing another user event guests', async () => {
      await request(app.getHttpServer())
        .get('/admin/events/event-uuid-1/guests')
        .expect(403);
    });
  });

  describe('missing event — EventOwnerGuard throws 404', () => {
    beforeEach(async () => {
      app = await buildApp(MockEventOwnerGuardNotFound);
    });

    it('returns 404 when eventId does not exist', async () => {
      await request(app.getHttpServer())
        .get('/admin/events/nonexistent-id/guests')
        .expect(404);
    });
  });
});
