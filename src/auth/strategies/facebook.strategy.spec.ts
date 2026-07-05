// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { FacebookStrategy } from './facebook.strategy';
import { OAuthService } from '../oauth.service';
import { AuthUser } from '../interfaces/auth-user.interface';
import { UserRole } from '../../database/schema';

const mockOAuthService = {
  findOrCreateUser: jest.fn(),
};

describe('FacebookStrategy', () => {
  let strategy: FacebookStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FacebookStrategy,
        { provide: OAuthService, useValue: mockOAuthService },
      ],
    }).compile();

    strategy = module.get<FacebookStrategy>(FacebookStrategy);
  });

  it('should be defined', () => {
    expect(strategy).toBeDefined();
  });

  describe('validate()', () => {
    const mockProfile = {
      id: 'fb-456',
      displayName: 'FB User',
      emails: [{ value: 'fbuser@example.com' }],
    };

    const expectedAuthUser: AuthUser = {
      id: 'user-uuid-2',
      email: 'fbuser@example.com',
      name: 'FB User',
      role: UserRole.USER,
    };

    it('should call oauthService.findOrCreateUser with provider facebook and correct args', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      await strategy.validate('fb-access-token', 'fb-refresh-token', mockProfile);

      expect(mockOAuthService.findOrCreateUser).toHaveBeenCalledWith(
        'facebook',
        'fb-456',
        { email: 'fbuser@example.com', name: 'FB User' },
      );
    });

    it('should return the AuthUser returned by oauthService', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      const result = await strategy.validate(
        'fb-access-token',
        'fb-refresh-token',
        mockProfile,
      );

      expect(result).toEqual(expectedAuthUser);
    });

    it('should return an object with id, email, and name properties', async () => {
      mockOAuthService.findOrCreateUser.mockResolvedValue(expectedAuthUser);

      const result = await strategy.validate(
        'fb-access-token',
        'fb-refresh-token',
        mockProfile,
      );

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('name');
    });
  });
});
