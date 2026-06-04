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
import { UserEventsController } from './user-events.controller';
import { UserEventsService } from './user-events.service';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'user@test.com',
  name: 'User',
};

const MOCK_EVENT = {
  id: 'event-uuid-1',
  userId: 'creator-uuid',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10').toISOString(),
  createdAt: new Date().toISOString(),
  eventType: 'general',
  location: null,
};

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

const mockUserEventsService = {
  findByUser: jest.fn(),
  update: jest.fn(),
};

describe('UserEventsController — authenticated', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserEventsController],
      providers: [
        { provide: UserEventsService, useValue: mockUserEventsService },
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

  describe('GET /user/events', () => {
    it('returns 200 with events array for the authenticated user', async () => {
      mockUserEventsService.findByUser.mockResolvedValueOnce([MOCK_EVENT]);

      const response = await request(app.getHttpServer())
        .get('/user/events')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ id: MOCK_EVENT.id });
      expect(mockUserEventsService.findByUser).toHaveBeenCalledWith(MOCK_USER.id);
    });

    it('returns 200 with empty array when user has no assigned events', async () => {
      mockUserEventsService.findByUser.mockResolvedValueOnce([]);

      const response = await request(app.getHttpServer())
        .get('/user/events')
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('PATCH /user/events/:id', () => {
    it('returns 200 with updated event when user is a member', async () => {
      const updatedEvent = { ...MOCK_EVENT, name: 'Updated' };
      mockUserEventsService.update.mockResolvedValueOnce(updatedEvent);

      const response = await request(app.getHttpServer())
        .patch('/user/events/event-uuid-1')
        .send({ name: 'Updated' })
        .expect(200);

      expect(response.body).toMatchObject({ name: 'Updated' });
      expect(mockUserEventsService.update).toHaveBeenCalledWith(
        'event-uuid-1',
        MOCK_USER.id,
        expect.objectContaining({ name: 'Updated' }),
      );
    });

    it('returns 403 when user is not a member of the event', async () => {
      mockUserEventsService.update.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this event'),
      );

      await request(app.getHttpServer())
        .patch('/user/events/event-uuid-1')
        .send({ name: 'Hacked' })
        .expect(403);
    });

    it('returns 404 when event does not exist', async () => {
      mockUserEventsService.update.mockRejectedValueOnce(
        new NotFoundException('Event not found'),
      );

      await request(app.getHttpServer())
        .patch('/user/events/nonexistent-id')
        .send({ name: 'Updated' })
        .expect(404);
    });
  });
});

describe('UserEventsController — unauthenticated', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserEventsController],
      providers: [
        { provide: UserEventsService, useValue: mockUserEventsService },
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

  it('GET /user/events returns 403 when guard rejects', async () => {
    await request(app.getHttpServer())
      .get('/user/events')
      .expect(403);
  });

  it('PATCH /user/events/:id returns 403 when guard rejects', async () => {
    await request(app.getHttpServer())
      .patch('/user/events/event-uuid-1')
      .send({ name: 'Updated' })
      .expect(403);
  });
});
