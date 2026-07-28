// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
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
  date: new Date('2025-10-10').toISOString(),
  createdAt: new Date().toISOString(),
  users: [
    { id: 'user-uuid-alice', name: 'Alice', email: 'alice@test.com' },
  ],
};

// --- Mock guard that injects user into request ---

class MockJwtGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = MOCK_USER;
    return true;
  }
}

// --- Mock EventsService ---

const mockEventsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

describe('EventsController — integration', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: mockEventsService },
      ],
    })
      .overrideGuard(AuthGuard('jwt-admin'))
      .useClass(MockJwtGuard)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /admin/events', () => {
    it('returns 201 with created event', async () => {
      mockEventsService.create.mockResolvedValueOnce(MOCK_EVENT);

      const response = await request(app.getHttpServer())
        .post('/admin/events')
        .send({ name: 'My Wedding', slug: 'my-wedding-2025', date: '2025-10-10' })
        .expect(201);

      expect(response.body).toMatchObject({ id: MOCK_EVENT.id });
      expect(mockEventsService.create).toHaveBeenCalledWith(
        MOCK_USER.id,
        expect.objectContaining({ name: 'My Wedding', slug: 'my-wedding-2025' }),
      );
    });

    it('returns 409 when slug already exists', async () => {
      mockEventsService.create.mockRejectedValueOnce(
        new ConflictException('Slug already exists'),
      );

      await request(app.getHttpServer())
        .post('/admin/events')
        .send({ name: 'My Wedding', slug: 'my-wedding-2025', date: '2025-10-10' })
        .expect(409);
    });
  });

  describe('GET /admin/events', () => {
    it('returns 200 with events scoped to owner', async () => {
      mockEventsService.findAll.mockResolvedValueOnce([MOCK_EVENT]);

      const response = await request(app.getHttpServer())
        .get('/admin/events')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ userId: MOCK_USER.id });
      expect(response.body[0].users).toEqual(MOCK_EVENT.users);
      expect(mockEventsService.findAll).toHaveBeenCalledWith(
        MOCK_USER.id,
        MOCK_USER.role,
      );
    });
  });

  describe('GET /admin/events/:id', () => {
    it('returns 200 with the event when owner requests it', async () => {
      mockEventsService.findOne.mockResolvedValueOnce(MOCK_EVENT);

      const response = await request(app.getHttpServer())
        .get('/admin/events/event-uuid-1')
        .expect(200);

      expect(response.body).toMatchObject({ id: 'event-uuid-1' });
      expect(response.body.users).toEqual(MOCK_EVENT.users);
      expect(mockEventsService.findOne).toHaveBeenCalledWith(
        'event-uuid-1',
        MOCK_USER.id,
        MOCK_USER.role,
      );
    });

    it('returns 404 when event does not exist', async () => {
      mockEventsService.findOne.mockRejectedValueOnce(
        new NotFoundException('Event not found'),
      );

      await request(app.getHttpServer())
        .get('/admin/events/nonexistent-id')
        .expect(404);
    });

    it('returns 404 when authenticated user does not own the event', async () => {
      mockEventsService.findOne.mockRejectedValueOnce(
        new NotFoundException('Event not found'),
      );

      await request(app.getHttpServer())
        .get('/admin/events/event-uuid-1')
        .expect(404);
    });
  });

  describe('PATCH /admin/events/:id', () => {
    it('returns 200 with updated event', async () => {
      const updatedEvent = { ...MOCK_EVENT, name: 'Updated' };
      mockEventsService.update.mockResolvedValueOnce(updatedEvent);

      const response = await request(app.getHttpServer())
        .patch('/admin/events/event-uuid-1')
        .send({ name: 'Updated' })
        .expect(200);

      expect(response.body).toMatchObject({ name: 'Updated' });
      expect(mockEventsService.update).toHaveBeenCalledWith(
        'event-uuid-1',
        MOCK_USER.id,
        expect.objectContaining({ name: 'Updated' }),
      );
    });

    it('returns 404 when non-owner tries to update (service throws NotFoundException)', async () => {
      mockEventsService.update.mockRejectedValueOnce(
        new NotFoundException('Event not found'),
      );

      await request(app.getHttpServer())
        .patch('/admin/events/event-uuid-1')
        .send({ name: 'Hacked' })
        .expect(404);
    });
  });

  describe('DELETE /admin/events/:id', () => {
    it('returns 204 when owner removes event', async () => {
      mockEventsService.remove.mockResolvedValueOnce(undefined);

      await request(app.getHttpServer())
        .delete('/admin/events/event-uuid-1')
        .expect(204);

      expect(mockEventsService.remove).toHaveBeenCalledWith(
        'event-uuid-1',
        MOCK_USER.id,
      );
    });

    it('returns 404 when non-owner tries to delete (service throws NotFoundException)', async () => {
      mockEventsService.remove.mockRejectedValueOnce(
        new NotFoundException('Event not found'),
      );

      await request(app.getHttpServer())
        .delete('/admin/events/event-uuid-1')
        .expect(404);
    });
  });
});
