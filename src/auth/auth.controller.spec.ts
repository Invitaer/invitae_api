// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
    GOOGLE_CLIENT_ID: 'test-google-id',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
    FACEBOOK_APP_ID: 'test-fb-id',
    FACEBOOK_APP_SECRET: 'test-fb-secret',
    FACEBOOK_CALLBACK_URL: 'http://localhost:3000/auth/facebook/callback',
  },
}));
jest.mock('../database/database.service');
jest.mock('../crypto/crypto.service');

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUser } from './interfaces/auth-user.interface';
import { EmailVerificationService } from './email-verification.service';
import { authCookieName } from './auth-cookie';
import { UserRole } from '../database/schema';

// --- Fixtures ---

const MOCK_AUTH_USER: AuthUser = {
  id: 'test-user-id',
  email: 'test@test.com',
  name: 'Test User',
  role: UserRole.USER,
};

const MOCK_ADMIN_USER: AuthUser = {
  ...MOCK_AUTH_USER,
  id: 'test-admin-id',
  role: UserRole.ADMIN,
};

const MOCK_JWT = 'mock.signed.jwt.token';
const DASHBOARD_URL = 'http://localhost:8090';
const USER_DASHBOARD_URL = 'http://localhost:8091';

const ADMIN_COOKIE = authCookieName('admin');
const USER_COOKIE = authCookieName('user');

/** Whoever the OAuth provider "returns" for the current test. */
let oauthUser: AuthUser = MOCK_AUTH_USER;

// --- Mock AuthService ---

const mockAuthService = {
  login: jest.fn(),
  register: jest.fn(),
  issueJwt: jest.fn().mockReturnValue(MOCK_JWT),
};

const mockEmailVerification = {
  verify: jest.fn(),
  resendTo: jest.fn(),
  claimResendSlot: jest.fn(),
};

// --- Mock guards ---
// Inject a user into request.user, bypassing the real Passport flow.

class MockOAuthGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = oauthUser;
    return true;
  }
}

class MockJwtUserGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    context.switchToHttp().getRequest().user = MOCK_AUTH_USER;
    return true;
  }
}

class MockJwtAdminGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    context.switchToHttp().getRequest().user = MOCK_ADMIN_USER;
    return true;
  }
}

async function buildApp(): Promise<INestApplication> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: mockAuthService },
      { provide: EmailVerificationService, useValue: mockEmailVerification },
    ],
  })
    .overrideGuard(AuthGuard('google'))
    .useClass(MockOAuthGuard)
    .overrideGuard(AuthGuard('google-user'))
    .useClass(MockOAuthGuard)
    .overrideGuard(AuthGuard('facebook'))
    .useClass(MockOAuthGuard)
    .overrideGuard(AuthGuard('facebook-user'))
    .useClass(MockOAuthGuard)
    .overrideGuard(AuthGuard('jwt-user'))
    .useClass(MockJwtUserGuard)
    .overrideGuard(AuthGuard('jwt-admin'))
    .useClass(MockJwtAdminGuard)
    .compile();

  const app = module.createNestApplication();
  await app.init();
  return app;
}

const cookiesOf = (response: request.Response): string[] =>
  (response.headers['set-cookie'] as unknown as string[]) ?? [];

describe('AuthController', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAuthService.issueJwt.mockReturnValue(MOCK_JWT);
    oauthUser = MOCK_AUTH_USER;
    process.env.DASHBOARD_URL = DASHBOARD_URL;
    process.env.USER_DASHBOARD_URL = USER_DASHBOARD_URL;

    app = await buildApp();
  });

  afterEach(async () => {
    delete process.env.DASHBOARD_URL;
    delete process.env.USER_DASHBOARD_URL;
    await app.close();
  });

  /**
   * The bug this whole change exists to fix: both dashboards used to write a
   * cookie called `auth_token` on `localhost`, and cookies are not scoped by
   * port — so the two apps were sharing one session.
   */
  describe('session isolation between the two dashboards', () => {
    beforeEach(() => {
      mockAuthService.login.mockResolvedValue({
        token: MOCK_JWT,
        user: { id: MOCK_AUTH_USER.id, email: MOCK_AUTH_USER.email, name: MOCK_AUTH_USER.name },
      });
    });

    it('writes a different cookie name per application', async () => {
      const admin = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ email: 'test@test.com', password: 'pw' })
        .expect(201);

      const user = await request(app.getHttpServer())
        .post('/auth/user/login')
        .send({ email: 'test@test.com', password: 'pw' })
        .expect(201);

      expect(cookiesOf(admin)[0]).toContain(`${ADMIN_COOKIE}=${MOCK_JWT}`);
      expect(cookiesOf(user)[0]).toContain(`${USER_COOKIE}=${MOCK_JWT}`);
      expect(ADMIN_COOKIE).not.toBe(USER_COOKIE);
    });

    it('asks the service for the audience the route belongs to', async () => {
      await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ email: 'test@test.com', password: 'pw' });

      expect(mockAuthService.login).toHaveBeenCalledWith('test@test.com', 'pw', 'admin');

      await request(app.getHttpServer())
        .post('/auth/user/login')
        .send({ email: 'test@test.com', password: 'pw' });

      expect(mockAuthService.login).toHaveBeenLastCalledWith('test@test.com', 'pw', 'user');
    });

    it('signing out of one application leaves the other session untouched', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/admin/logout')
        .expect(200);

      const cleared = cookiesOf(response);
      expect(cleared[0]).toContain(`${ADMIN_COOKIE}=;`);
      expect(cleared.join(' ')).not.toContain(USER_COOKIE);
    });
  });

  describe('password login', () => {
    it('never returns the token in the body — it exists only as an httpOnly cookie', async () => {
      mockAuthService.login.mockResolvedValue({
        token: MOCK_JWT,
        user: { id: MOCK_AUTH_USER.id, email: MOCK_AUTH_USER.email, name: MOCK_AUTH_USER.name },
      });

      const response = await request(app.getHttpServer())
        .post('/auth/user/login')
        .send({ email: 'test@test.com', password: 'pw' })
        .expect(201);

      // Previously the body carried `access_token` so the admin dashboard could
      // read it from JS. Anything JS can read, an XSS can steal.
      expect(response.body).not.toHaveProperty('access_token');
      expect(response.body).not.toHaveProperty('token');
      expect(response.body.user).toMatchObject({ id: MOCK_AUTH_USER.id });
      expect(cookiesOf(response)[0]).toContain('HttpOnly');
    });

    it('sets no cookie when the credentials are rejected', async () => {
      mockAuthService.login.mockRejectedValue(new UnauthorizedException());

      const response = await request(app.getHttpServer())
        .post('/auth/user/login')
        .send({ email: 'test@test.com', password: 'wrong' })
        .expect(401);

      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('sets no admin cookie when the service refuses a non-admin', async () => {
      mockAuthService.login.mockRejectedValue(new ForbiddenException());

      const response = await request(app.getHttpServer())
        .post('/auth/admin/login')
        .send({ email: 'test@test.com', password: 'pw' })
        .expect(403);

      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('identity endpoints', () => {
    it('answers /auth/user/me for the user session', async () => {
      const response = await request(app.getHttpServer()).get('/auth/user/me').expect(200);

      expect(response.body).toEqual({
        id: MOCK_AUTH_USER.id,
        email: MOCK_AUTH_USER.email,
        name: MOCK_AUTH_USER.name,
      });
    });

    it('answers /auth/admin/me with the role, which the admin UI needs', async () => {
      const response = await request(app.getHttpServer()).get('/auth/admin/me').expect(200);

      expect(response.body).toMatchObject({
        id: MOCK_ADMIN_USER.id,
        role: UserRole.ADMIN,
      });
    });
  });

  describe('OAuth callbacks', () => {
    it('hands the user session over as an httpOnly cookie, never in the redirect URL', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/google/user/callback')
        .redirects(0)
        .expect(302);

      // The token used to travel as `?token=`, which parked a 7-day JWT in
      // browser history, referrers and any proxy log along the way.
      expect(response.headers['location']).toBe(
        `${USER_DASHBOARD_URL}/api/auth/callback/google`,
      );
      expect(response.headers['location']).not.toContain('token=');

      expect(cookiesOf(response)[0]).toContain(`${USER_COOKIE}=${MOCK_JWT}`);
      expect(cookiesOf(response)[0]).toContain('HttpOnly');
      expect(mockAuthService.issueJwt).toHaveBeenCalledWith(MOCK_AUTH_USER, 'user');
    });

    it('does the same for facebook', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/facebook/user/callback')
        .redirects(0)
        .expect(302);

      expect(response.headers['location']).toBe(
        `${USER_DASHBOARD_URL}/api/auth/callback/facebook`,
      );
      expect(cookiesOf(response)[0]).toContain(`${USER_COOKIE}=`);
    });

    it('now puts the admin session in a cookie too, dropping the ?token= hand-off', async () => {
      oauthUser = MOCK_ADMIN_USER;

      const response = await request(app.getHttpServer())
        .get('/auth/google/callback')
        .redirects(0)
        .expect(302);

      expect(response.headers['location']).toBe(
        `${DASHBOARD_URL}/api/auth/callback/google`,
      );
      expect(response.headers['location']).not.toContain('token=');
      expect(cookiesOf(response)[0]).toContain(`${ADMIN_COOKIE}=${MOCK_JWT}`);
      expect(mockAuthService.issueJwt).toHaveBeenCalledWith(MOCK_ADMIN_USER, 'admin');
    });

    /**
     * OAuth creates an account for anyone with a valid Google/Facebook login,
     * so without this the admin flow would mint admin tokens for strangers.
     */
    it.each([
      ['google', '/auth/google/callback'],
      ['facebook', '/auth/facebook/callback'],
    ])('refuses a non-admin on the %s admin callback', async (_provider, path) => {
      oauthUser = MOCK_AUTH_USER;

      const response = await request(app.getHttpServer())
        .get(path)
        .redirects(0)
        .expect(302);

      expect(response.headers['location']).toBe(`${DASHBOARD_URL}/login?error=forbidden`);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(mockAuthService.issueJwt).not.toHaveBeenCalled();
    });
  });

  describe('USER_DASHBOARD_URL fallback', () => {
    it('falls back to http://localhost:8091 when USER_DASHBOARD_URL is not set', async () => {
      delete process.env.USER_DASHBOARD_URL;
      await app.close();

      const freshApp = await buildApp();

      const response = await request(freshApp.getHttpServer())
        .get('/auth/google/user/callback')
        .redirects(0)
        .expect(302);

      expect(response.headers['location']).toContain('http://localhost:8091');

      await freshApp.close();
      app = await buildApp();
    });
  });

  describe('GET /auth/verify-email', () => {
    it('redirects to the dashboard with verified=1 when the token is good', async () => {
      mockEmailVerification.verify.mockResolvedValue(true);

      const response = await request(app.getHttpServer())
        .get('/auth/verify-email?token=good-token')
        .redirects(0)
        .expect(302);

      expect(mockEmailVerification.verify).toHaveBeenCalledWith('good-token');
      expect(response.headers['location']).toBe(`${USER_DASHBOARD_URL}/login?verified=1`);
    });

    it('redirects with an error flag when the token is expired or unknown', async () => {
      mockEmailVerification.verify.mockResolvedValue(false);

      const response = await request(app.getHttpServer())
        .get('/auth/verify-email?token=stale-token')
        .redirects(0)
        .expect(302);

      expect(response.headers['location']).toBe(`${USER_DASHBOARD_URL}/login?verified=0`);
    });

    it('redirects with the error flag when no token is supplied at all', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/verify-email')
        .redirects(0)
        .expect(302);

      expect(mockEmailVerification.verify).not.toHaveBeenCalled();
      expect(response.headers['location']).toBe(`${USER_DASHBOARD_URL}/login?verified=0`);
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('answers 202 and resends when the cooldown slot is free', async () => {
      mockEmailVerification.claimResendSlot.mockResolvedValue(true);
      mockEmailVerification.resendTo.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'test@test.com' })
        .expect(202);

      expect(mockEmailVerification.claimResendSlot).toHaveBeenCalledWith('test@test.com');
      expect(mockEmailVerification.resendTo).toHaveBeenCalledWith('test@test.com');
    });

    it('answers 202 without resending while the cooldown is active', async () => {
      mockEmailVerification.claimResendSlot.mockResolvedValue(false);

      await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'test@test.com' })
        .expect(202);

      expect(mockEmailVerification.resendTo).not.toHaveBeenCalled();
    });

    it('returns the SAME response for an unknown address — never reveals who is registered', async () => {
      mockEmailVerification.claimResendSlot.mockResolvedValue(true);
      mockEmailVerification.resendTo.mockResolvedValue(undefined);

      const known = await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'test@test.com' })
        .expect(202);

      const unknown = await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'nobody@test.com' })
        .expect(202);

      expect(unknown.body).toEqual(known.body);
    });
  });
});
