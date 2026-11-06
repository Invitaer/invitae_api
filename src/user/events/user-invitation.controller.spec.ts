// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { UserInvitationController } from './user-invitation.controller';
import { UserEventsService } from './user-events.service';
import { UserEventMemberGuard } from './guards/user-event-member.guard';
import { ContentService } from '../../admin/content/content.service';
import { AuthUser } from '../../auth/interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

const MOCK_USER: AuthUser = {
  id: 'user-uuid-1',
  email: 'user@test.com',
  name: 'User',
  role: UserRole.USER,
};

const MOCK_EVENT = {
  id: 'event-uuid-1',
  userId: 'creator-uuid',
  name: 'Susan Y Nacho',
  slug: 'boda-susan-y-nacho-24-10-2027',
  date: new Date('2027-10-24T00:00:00'),
  createdAt: new Date(),
  eventType: 'wedding',
  location: null,
};

const VALID_INVITATION = {
  metadata: { slug: 'ignored', eventType: 'ignored', language: 'es' },
  theme: { bgBase: '#fff', bgCard: '#fff', accent: '#c9a96e', text: '#111' },
  assets: { heroImage: null, music: null },
  settings: { whatsappNumber: '5215555555555', mapsUrl: '', musicAutoplay: false },
  sections: [
    { type: 'hero', enabled: true, order: 1, data: { subtitle: 'Nos casamos' } },
    { type: 'gallery', enabled: false, order: 2, data: { images: [] } },
  ],
};

class MockJwtGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    context.switchToHttp().getRequest().user = MOCK_USER;
    return true;
  }
}

const mockUserEventsService = { findOne: jest.fn() };
const mockContentService = {
  getInvitation: jest.fn(),
  setInvitation: jest.fn(),
  getOriginalInvitation: jest.fn(),
};

async function buildApp(memberGuard: { canActivate: () => boolean }) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [UserInvitationController],
    providers: [
      { provide: UserEventsService, useValue: mockUserEventsService },
      { provide: ContentService, useValue: mockContentService },
    ],
  })
    .overrideGuard(AuthGuard('jwt-user'))
    .useClass(MockJwtGuard)
    .overrideGuard(UserEventMemberGuard)
    .useValue(memberGuard)
    .compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
  return app;
}

describe('UserInvitationController — event member', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUserEventsService.findOne.mockResolvedValue(MOCK_EVENT);
    app = await buildApp({ canActivate: () => true });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET returns the projected invitation of the event the member owns', async () => {
    mockContentService.getInvitation.mockResolvedValue(VALID_INVITATION);

    const res = await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation')
      .expect(200);

    expect(res.body).toEqual(VALID_INVITATION);
    expect(mockUserEventsService.findOne).toHaveBeenCalledWith('event-uuid-1', MOCK_USER.id);
    expect(mockContentService.getInvitation).toHaveBeenCalledWith(MOCK_EVENT);
  });

  it('GET answers 404 while the invitation was never published', async () => {
    mockContentService.getInvitation.mockRejectedValue(new NotFoundException());

    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation')
      .expect(404);
  });

  it('PUT stores the invitation, including disabled sections, against the event row', async () => {
    mockContentService.setInvitation.mockImplementation(async (_e, dto) => dto);

    const res = await request(app.getHttpServer())
      .put('/user/events/event-uuid-1/invitation')
      .send(VALID_INVITATION)
      .expect(200);

    expect(mockContentService.setInvitation).toHaveBeenCalledWith(
      MOCK_EVENT,
      expect.objectContaining({ sections: VALID_INVITATION.sections }),
    );
    expect(res.body.sections[1]).toEqual({
      type: 'gallery',
      enabled: false,
      order: 2,
      data: { images: [] },
    });
  });

  it('GET /original returns the original invitation of the event, projected', async () => {
    mockContentService.getOriginalInvitation.mockResolvedValue(VALID_INVITATION);

    const res = await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation/original')
      .expect(200);

    expect(res.body).toEqual(VALID_INVITATION);
    expect(mockUserEventsService.findOne).toHaveBeenCalledWith('event-uuid-1', MOCK_USER.id);
    expect(mockContentService.getOriginalInvitation).toHaveBeenCalledWith(MOCK_EVENT);
  });

  it('GET /original answers 404 when the event has no original yet', async () => {
    mockContentService.getOriginalInvitation.mockRejectedValue(new NotFoundException());

    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation/original')
      .expect(404);
  });

  it('PUT rejects a payload that breaks the invitation contract', async () => {
    await request(app.getHttpServer())
      .put('/user/events/event-uuid-1/invitation')
      .send({ ...VALID_INVITATION, sections: [{ type: 'hero', enabled: 'yes', order: 1, data: {} }] })
      .expect(400);

    expect(mockContentService.setInvitation).not.toHaveBeenCalled();
  });
});

describe('UserInvitationController — no session', () => {
  it('authenticates before checking membership', async () => {
    const memberGuard = { canActivate: jest.fn(() => true) };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserInvitationController],
      providers: [
        { provide: UserEventsService, useValue: mockUserEventsService },
        { provide: ContentService, useValue: mockContentService },
      ],
    })
      .overrideGuard(AuthGuard('jwt-user'))
      .useValue({ canActivate: () => false })
      .overrideGuard(UserEventMemberGuard)
      .useValue(memberGuard)
      .compile();
    const app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation')
      .expect(403);

    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation/original')
      .expect(403);

    expect(memberGuard.canActivate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('UserInvitationController — not a member of the event', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await buildApp({
      canActivate: () => {
        throw new ForbiddenException('You are not a member of this event');
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET is forbidden and reads nothing', async () => {
    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation')
      .expect(403);

    expect(mockContentService.getInvitation).not.toHaveBeenCalled();
  });

  it('GET /original is forbidden and reads nothing', async () => {
    await request(app.getHttpServer())
      .get('/user/events/event-uuid-1/invitation/original')
      .expect(403);

    expect(mockContentService.getOriginalInvitation).not.toHaveBeenCalled();
  });

  it('PUT is forbidden and writes nothing', async () => {
    await request(app.getHttpServer())
      .put('/user/events/event-uuid-1/invitation')
      .send(VALID_INVITATION)
      .expect(403);

    expect(mockContentService.setInvitation).not.toHaveBeenCalled();
  });
});
