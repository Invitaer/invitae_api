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
import { INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUser } from './interfaces/auth-user.interface';

// --- Fixtures ---

const MOCK_AUTH_USER: AuthUser = {
  id: 'test-user-id',
  email: 'test@test.com',
  name: 'Test User',
};

const MOCK_JWT = 'mock.signed.jwt.token';

// --- Mock AuthService ---

const mockAuthService = {
  login: jest.fn(),
  register: jest.fn(),
  issueJwt: jest.fn().mockReturnValue(MOCK_JWT),
};

// --- Mock AuthGuard factory ---
// Injects MOCK_AUTH_USER into request.user, bypassing real Passport OAuth flow

class MockGoogleGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = MOCK_AUTH_USER;
    return true;
  }
}

class MockFacebookGuard {
  canActivate(context: import('@nestjs/common').ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = MOCK_AUTH_USER;
    return true;
  }
}

describe('AuthController — OAuth callback integration', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
      ],
    })
      .overrideGuard(AuthGuard('google'))
      .useClass(MockGoogleGuard)
      .overrideGuard(AuthGuard('facebook'))
      .useClass(MockFacebookGuard)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /auth/google/callback', () => {
    it('returns { access_token } when guard injects a known AuthUser', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/google/callback')
        .expect(200);

      // Assert
      expect(response.body).toEqual({ access_token: MOCK_JWT });
      expect(mockAuthService.issueJwt).toHaveBeenCalledWith(MOCK_AUTH_USER);
    });

    it('calls issueJwt with the user set by the guard', async () => {
      await request(app.getHttpServer())
        .get('/auth/google/callback')
        .expect(200);

      expect(mockAuthService.issueJwt).toHaveBeenCalledTimes(1);
      expect(mockAuthService.issueJwt).toHaveBeenCalledWith(
        expect.objectContaining({
          id: MOCK_AUTH_USER.id,
          email: MOCK_AUTH_USER.email,
          name: MOCK_AUTH_USER.name,
        }),
      );
    });
  });

  describe('GET /auth/facebook/callback', () => {
    it('returns { access_token } when guard injects a known AuthUser', async () => {
      // Act
      const response = await request(app.getHttpServer())
        .get('/auth/facebook/callback')
        .expect(200);

      // Assert
      expect(response.body).toEqual({ access_token: MOCK_JWT });
      expect(mockAuthService.issueJwt).toHaveBeenCalledWith(MOCK_AUTH_USER);
    });
  });
});
