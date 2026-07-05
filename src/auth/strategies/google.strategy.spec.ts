// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { GoogleStrategy } from './google.strategy';
import { OAuthService } from '../oauth.service';
import { AuthUser } from '../interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

const mockOAuthService = {
  findOrCreateUser: jest.fn(),
};

describe('GoogleStrategy', () => {
  let strategy: GoogleStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleStrategy,
        { provide: OAuthService, useValue: mockOAuthService },
      ],
    }).compile();

    strategy = module.get<GoogleStrategy>(GoogleStrategy);
  });

  it('should be defined', () => {
    expect(strategy).toBeDefined();
  });

  describe('validate()', () => {
    const mockProfile = {
      id: 'google-123',
      displayName: 'Test User',
      emails: [{ value: 'test@example.com' }],
    };

    const expectedAuthUser: AuthUser = {
      id: 'user-uuid-1',
      email: 'test@example.com',
      name: 'Test User',
      role: UserRole.USER,
    };

    it('should call oauthService.findOrCreateUser with provider google and correct args', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      await strategy.validate('access-token', 'refresh-token', mockProfile);

      expect(mockOAuthService.findOrCreateUser).toHaveBeenCalledWith(
        'google',
        'google-123',
        { email: 'test@example.com', name: 'Test User' },
      );
    });

    it('should return the AuthUser returned by oauthService', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      const result = await strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
      );

      expect(result).toEqual(expectedAuthUser);
    });

    it('should return an object with id, email, and name properties', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      const result = await strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
      );

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('name');
    });
  });
});
