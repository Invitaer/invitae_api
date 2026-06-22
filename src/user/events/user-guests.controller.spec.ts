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
import { UserEventMemberGuard } from './guards/user-event-member.guard';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';

// --- Fixtures ---

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'user@test.com',
  name: 'User',
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
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
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
    it('returns 200 with guest array (each guest has rsvpStatus)', async () => {
      mockGuestsService.findAll.mockResolvedValueOnce([MOCK_GUEST]);

      const response = await request(app.getHttpServer())
        .get('/user/events/event-uuid-1/guests')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ rsvpStatus: 'PENDING' });
      expect(mockGuestsService.findAll).toHaveBeenCalledWith('event-uuid-1');
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
