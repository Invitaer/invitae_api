// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { UserGuestsController } from './user-guests.controller';
import { GuestsService } from '../../admin/guests/guests.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { UserEventMemberGuard } from './guards/user-event-member.guard';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

// --- Fixtures ---

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'user@test.com',
  name: 'User',
  role: UserRole.USER,
};

const MOCK_GUEST = {
  id: 'guest-uuid-1',
  eventId: 'event-uuid-1',
  name: 'Alice',
  phone: '123456789',
  email: null,
  tableId: null,
  rsvpStatus: 'PENDING',
  invitationSent: false,
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

class RejectJwtGuard {
  canActivate() {
    return false;
  }
}

// --- Mock GuestsService ---

const mockGuestsService = {
  findAll: jest.fn(),
  findAllPaginated: jest.fn(),
  findMatchingIds: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

// --- Mock NotificationsService ---

// Opaque stand-in: the controller only forwards whatever the service returns,
// so this fixture asserts pass-through, not the notification contract itself.
const MOCK_NOTIFY_RESULT = {
  delivery: 'live',
  notifiedCount: 1,
  sentCount: 1,
  failedCount: 0,
  skippedCount: 0,
  recipients: [{ id: 'guest-uuid-1', name: 'Alice', phone: '123456789', status: 'sent' }],
};

const mockNotificationsService = {
  notifySelected: jest.fn(),
  notifyAll: jest.fn(),
  notifyPending: jest.fn(),
};

// --- Helper to build app ---

async function buildApp(
  jwtGuardClass: new () => object,
  memberGuardValue: { canActivate: () => boolean },
): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [UserGuestsController],
    providers: [
      { provide: GuestsService, useValue: mockGuestsService },
      { provide: NotificationsService, useValue: mockNotificationsService },
    ],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useClass(jwtGuardClass)
    .overrideGuard(UserEventMemberGuard)
    .useValue(memberGuardValue)
    .compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  await app.init();
  return app;
}

describe('UserGuestsController — member access', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp(MockJwtGuard, { canActivate: () => true });
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /user/events/:id/guests', () => {
    it('returns 200 with { data, total } (each guest has rsvpStatus)', async () => {
      mockGuestsService.findAllPaginated.mockResolvedValueOnce({
        data: [MOCK_GUEST],
        total: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests')
        .expect(200);

      expect(response.body).toEqual({ data: [MOCK_GUEST], total: 1 });
      expect(response.body.data[0]).toMatchObject({ rsvpStatus: 'PENDING' });
      expect(mockGuestsService.findAllPaginated).toHaveBeenCalledWith(
        'event-uuid-1',
        expect.objectContaining({ page: 1, limit: 10 }),
      );
    });

    it('forwards search/page/limit query params to findAllPaginated', async () => {
      mockGuestsService.findAllPaginated.mockResolvedValueOnce({
        data: [],
        total: 0,
      });

      await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests')
        .query({ search: 'alice', page: 2, limit: 25 })
        .expect(200);

      expect(mockGuestsService.findAllPaginated).toHaveBeenCalledWith(
        'event-uuid-1',
        expect.objectContaining({ search: 'alice', page: 2, limit: 25 }),
      );
    });

    it('returns 400 when limit exceeds the max', async () => {
      await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests')
        .query({ limit: 1000 })
        .expect(400);
    });
  });

  describe('GET /user/events/:id/guests/ids', () => {
    it('returns 200 with an array of ids matching the search filter', async () => {
      mockGuestsService.findMatchingIds.mockResolvedValueOnce([
        'guest-uuid-1',
        'guest-uuid-2',
      ]);

      const response = await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests/ids')
        .query({ search: 'alice' })
        .expect(200);

      expect(response.body).toEqual(['guest-uuid-1', 'guest-uuid-2']);
      expect(mockGuestsService.findMatchingIds).toHaveBeenCalledWith(
        'event-uuid-1',
        'alice',
      );
    });

    it('returns all ids of the event when no search is given', async () => {
      mockGuestsService.findMatchingIds.mockResolvedValueOnce([
        'guest-uuid-1',
      ]);

      const response = await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests/ids')
        .expect(200);

      expect(response.body).toEqual(['guest-uuid-1']);
      expect(mockGuestsService.findMatchingIds).toHaveBeenCalledWith(
        'event-uuid-1',
        undefined,
      );
    });
  });

  describe('POST /user/events/:id/guests', () => {
    it('returns 201 with rsvpStatus = PENDING on valid body', async () => {
      const created = { ...MOCK_GUEST, rsvpStatus: 'PENDING' };
      mockGuestsService.create.mockResolvedValueOnce(created);

      const response = await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests')
        .send({ name: 'Alice', phone: '123456789' })
        .expect(201);

      expect(response.body).toMatchObject({ rsvpStatus: 'PENDING' });
      expect(mockGuestsService.create).toHaveBeenCalledWith(
        'event-uuid-1',
        expect.objectContaining({ name: 'Alice' }),
      );
    });

    it('returns 400 when required name field is missing', async () => {
      await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests')
        .send({ phone: '123456789' })
        .expect(400);
    });
  });

  describe('PATCH /user/events/:id/guests/:guestId', () => {
    it('returns 200 with updated rsvpStatus', async () => {
      const updated = { ...MOCK_GUEST, rsvpStatus: 'ACCEPTED' };
      mockGuestsService.update.mockResolvedValueOnce(updated);

      const response = await request(app.getHttpServer())
        .patch('/user/events/event-uuid-1/guests/guest-uuid-1')
        .send({ rsvpStatus: 'ACCEPTED' })
        .expect(200);

      expect(response.body).toMatchObject({ rsvpStatus: 'ACCEPTED' });
      expect(mockGuestsService.update).toHaveBeenCalledWith(
        'event-uuid-1',
        'guest-uuid-1',
        expect.objectContaining({ rsvpStatus: 'ACCEPTED' }),
      );
    });
  });

  describe('DELETE /user/events/:id/guests/:guestId', () => {
    it('returns 204 when guest is deleted', async () => {
      mockGuestsService.remove.mockResolvedValueOnce(undefined);

      await request(app.getHttpServer())
        .delete('/user/events/event-uuid-1/guests/guest-uuid-1')
        .expect(204);

      expect(mockGuestsService.remove).toHaveBeenCalledWith(
        'event-uuid-1',
        'guest-uuid-1',
      );
    });
  });

  describe('POST /user/events/:id/guests/notify', () => {
    it('returns 200 and forwards the selected guest ids', async () => {
      mockNotificationsService.notifySelected.mockResolvedValueOnce(
        MOCK_NOTIFY_RESULT,
      );

      const response = await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify')
        .send({ guestIds: ['11111111-1111-4111-8111-111111111111'] })
        .expect(200);

      expect(response.body).toMatchObject({ delivery: 'live', sentCount: 1 });
      expect(mockNotificationsService.notifySelected).toHaveBeenCalledWith(
        'event-uuid-1',
        ['11111111-1111-4111-8111-111111111111'],
      );
    });

    it('returns 400 when guestIds is empty', async () => {
      await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify')
        .send({ guestIds: [] })
        .expect(400);
    });

    it('returns 400 when guestIds contains a non-uuid', async () => {
      await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify')
        .send({ guestIds: ['not-a-uuid'] })
        .expect(400);
    });
  });

  describe('POST /user/events/:id/guests/notify-all', () => {
    it('returns 200 and notifies all guests of the event (empty body = everyone)', async () => {
      mockNotificationsService.notifyAll.mockResolvedValueOnce(
        MOCK_NOTIFY_RESULT,
      );

      const response = await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify-all')
        .expect(200);

      expect(response.body).toMatchObject({ delivery: 'live', sentCount: 1 });
      expect(mockNotificationsService.notifyAll).toHaveBeenCalledWith(
        'event-uuid-1',
        undefined,
      );
    });

    it('forwards search from the body to notifyAll', async () => {
      mockNotificationsService.notifyAll.mockResolvedValueOnce(
        MOCK_NOTIFY_RESULT,
      );

      await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify-all')
        .send({ search: 'john' })
        .expect(200);

      expect(mockNotificationsService.notifyAll).toHaveBeenCalledWith(
        'event-uuid-1',
        'john',
      );
    });
  });

  describe('POST /user/events/:id/guests/notify-pending', () => {
    it('returns 200 and notifies only pending guests (empty body = all pending)', async () => {
      mockNotificationsService.notifyPending.mockResolvedValueOnce(
        MOCK_NOTIFY_RESULT,
      );

      const response = await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify-pending')
        .expect(200);

      expect(response.body).toMatchObject({ delivery: 'live', sentCount: 1 });
      expect(mockNotificationsService.notifyPending).toHaveBeenCalledWith(
        'event-uuid-1',
        undefined,
      );
    });

    it('forwards search from the body to notifyPending', async () => {
      mockNotificationsService.notifyPending.mockResolvedValueOnce(
        MOCK_NOTIFY_RESULT,
      );

      await request(app.getHttpServer())
        .post('/user/events/event-uuid-1/guests/notify-pending')
        .send({ search: 'john' })
        .expect(200);

      expect(mockNotificationsService.notifyPending).toHaveBeenCalledWith(
        'event-uuid-1',
        'john',
      );
    });
  });
});

describe('UserGuestsController — unauthenticated (JWT rejected)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp(RejectJwtGuard, { canActivate: () => false });
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /user/events/:id/guests returns 403 when JWT guard rejects', async () => {
    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/guests')
      .expect(403);
  });

  it('POST /user/events/:id/guests returns 403 when JWT guard rejects', async () => {
    await request(app.getHttpServer())
      .post('/user/events/event-uuid-1/guests')
      .send({ name: 'Alice', phone: '123456789' })
      .expect(403);
  });
});

describe('UserGuestsController — non-member (member guard blocked)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp(MockJwtGuard, { canActivate: () => false });
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /user/events/:id/guests returns 403 for non-member', async () => {
    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/guests')
      .expect(403);
  });
});
