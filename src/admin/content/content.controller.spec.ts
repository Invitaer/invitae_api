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
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
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

// --- Mock ContentService ---

const mockContentService = {
  getAllKeys: jest.fn(),
  getContent: jest.fn(),
  setContent: jest.fn(),
  deleteContent: jest.fn(),
  setInvitation: jest.fn(),
  getInvitation: jest.fn(),
  deleteInvitation: jest.fn(),
};

// --- Helper to build app with a specific EventOwnerGuard mock ---

async function buildApp(
  eventOwnerGuardClass: new () => object,
): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ContentController],
    providers: [
      { provide: ContentService, useValue: mockContentService },
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

describe('ContentController — nested route integration', () => {
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

    describe('GET /admin/events/:eventId/content', () => {
      it('returns 200 with all content keys', async () => {
        mockContentService.getAllKeys.mockResolvedValueOnce(['title', 'body']);

        const response = await request(app.getHttpServer())
          .get('/admin/events/event-uuid-1/content')
          .expect(200);

        expect(response.body).toEqual(['title', 'body']);
      });
    });

    describe('GET /admin/events/:eventId/content/:key', () => {
      it('returns 200 with key-value pair', async () => {
        mockContentService.getContent.mockResolvedValueOnce({
          key: 'title',
          value: 'Our Wedding',
        });

        const response = await request(app.getHttpServer())
          .get('/admin/events/event-uuid-1/content/title')
          .expect(200);

        expect(response.body).toMatchObject({ key: 'title', value: 'Our Wedding' });
      });
    });

    describe('POST /admin/events/:eventId/content', () => {
      it('returns 201 when content is set', async () => {
        mockContentService.setContent.mockResolvedValueOnce({
          key: 'title',
          value: 'Our Wedding',
        });

        const response = await request(app.getHttpServer())
          .post('/admin/events/event-uuid-1/content')
          .send({ key: 'title', value: 'Our Wedding' })
          .expect(201);

        expect(response.body).toMatchObject({ key: 'title' });
      });
    });

    describe('DELETE /admin/events/:eventId/content/:key', () => {
      it('returns 204 when content is deleted', async () => {
        mockContentService.deleteContent.mockResolvedValueOnce(undefined);

        await request(app.getHttpServer())
          .delete('/admin/events/event-uuid-1/content/title')
          .expect(204);
      });
    });
  });

  describe('non-owner request — EventOwnerGuard blocks with 403', () => {
    beforeEach(async () => {
      app = await buildApp(MockEventOwnerGuardForbidden);
    });

    it('returns 403 when accessing another user event content', async () => {
      await request(app.getHttpServer())
        .get('/admin/events/event-uuid-1/content')
        .expect(403);
    });
  });

  describe('missing event — EventOwnerGuard throws 404', () => {
    beforeEach(async () => {
      app = await buildApp(MockEventOwnerGuardNotFound);
    });

    it('returns 404 when eventId does not exist', async () => {
      await request(app.getHttpServer())
        .get('/admin/events/nonexistent-id/content')
        .expect(404);
    });
  });
});
