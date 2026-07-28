// Mock secrets and DatabaseService before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { OAuthService } from './oauth.service';
import { DatabaseService } from '../database/database.service';
import { UserRole } from '../database/schema';

// --- Fixtures ---

const GOOGLE_PROVIDER = 'google' as const;
const PROVIDER_ID = 'google-123';
const PROFILE = { email: 'user@example.com', name: 'Test User' };

const EXISTING_USER = {
  id: 'user-uuid-1',
  email: 'user@example.com',
  name: 'Test User',
  role: UserRole.USER,
  password: null as string | null,
  createdAt: new Date(),
};

const EXISTING_ACCOUNT = {
  id: 'oauth-uuid-1',
  userId: 'user-uuid-1',
  provider: 'google',
  providerId: 'google-123',
  accessToken: null as string | null,
  refreshToken: null as string | null,
  createdAt: new Date(),
};

describe('OAuthService', () => {
  let service: OAuthService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  function buildMockDb(overrides?: {
    oauthLookup?: unknown[];
    userLookup?: unknown[];
    insertedUser?: unknown[];
  }) {
    const { oauthLookup = [], userLookup = [], insertedUser = [] } = overrides ?? {};
    let selectCallCount = 0;
    let insertCallCount = 0;

    return {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        const idx = selectCallCount;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(idx === 1 ? oauthLookup : userLookup),
          }),
        };
      }),
      insert: jest.fn().mockImplementation(() => {
        insertCallCount++;
        const idx = insertCallCount;
        if (idx === 1) {
          // users insert
          return {
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue(insertedUser),
              }),
            }),
          };
        }
        // oauth_accounts insert
        return {
          values: jest.fn().mockResolvedValue(undefined),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
  }

  /** Grabs the `.values({...})` payload of the Nth `db.insert(...)` call. */
  function insertedValues(callIndex: number): Record<string, unknown> {
    const chain = dbServiceMock.db.insert.mock.results[callIndex].value;
    return chain.values.mock.calls[0][0];
  }

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OAuthService,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    service = module.get<OAuthService>(OAuthService);
  });

  describe('findOrCreateUser', () => {
    it('returns existing user when OAuth account already exists', async () => {
      // Arrange
      dbServiceMock.db = buildMockDb({
        oauthLookup: [EXISTING_ACCOUNT],
        userLookup: [EXISTING_USER],
      });

      // Act
      const result = await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      // Assert
      expect(result).toEqual({
        id: EXISTING_USER.id,
        email: EXISTING_USER.email,
        name: EXISTING_USER.name,
        role: EXISTING_USER.role,
      });
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(2);
      expect(dbServiceMock.db.insert).not.toHaveBeenCalled();
    });

    it('creates user and oauth_accounts row when OAuth account does not exist', async () => {
      // Arrange: no existing account, insert returns new user
      const newUser = { ...EXISTING_USER, id: 'new-user-uuid' };
      dbServiceMock.db = buildMockDb({
        oauthLookup: [],         // no existing oauth account
        userLookup: [newUser],   // fallback select (not needed since insert returns user)
        insertedUser: [newUser], // users.insert.returning()
      });

      // Act
      const result = await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      // Assert
      expect(result).toEqual({
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
      });
      expect(dbServiceMock.db.insert).toHaveBeenCalledTimes(2);
    });

    it('marks the new account as email-verified — the provider already proved ownership', async () => {
      const newUser = { ...EXISTING_USER, id: 'new-user-uuid' };
      dbServiceMock.db = buildMockDb({
        oauthLookup: [],
        userLookup: [newUser],
        insertedUser: [newUser],
      });

      await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      expect(insertedValues(0).emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('confirms a pre-existing local account that signs in with the same address', async () => {
      // Registered with a password, never clicked the link, now uses Google.
      // Google vouches for the mailbox, so the account must stop being stuck.
      const unverified = { ...EXISTING_USER, emailVerifiedAt: null };
      dbServiceMock.db = buildMockDb({
        oauthLookup: [],
        userLookup: [unverified],
        insertedUser: [], // onConflictDoNothing — the email is taken
      });

      await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('does not re-stamp an account that was already verified', async () => {
      const verified = { ...EXISTING_USER, emailVerifiedAt: new Date() };
      dbServiceMock.db = buildMockDb({
        oauthLookup: [],
        userLookup: [verified],
        insertedUser: [],
      });

      await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      expect(dbServiceMock.db.update).not.toHaveBeenCalled();
    });

    it('is idempotent — same provider+providerId always returns the same user without duplicate inserts', async () => {
      // Simulate calling with an already-existing account (the "found" path)
      // This verifies no inserts happen on repeated calls
      dbServiceMock.db = buildMockDb({
        oauthLookup: [EXISTING_ACCOUNT],
        userLookup: [EXISTING_USER],
      });

      const firstResult = await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      // Reset mock for second call — same scenario
      dbServiceMock.db = buildMockDb({
        oauthLookup: [EXISTING_ACCOUNT],
        userLookup: [EXISTING_USER],
      });

      const secondResult = await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      // Assert: both calls return the same user shape, no inserts
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).toEqual({
        id: EXISTING_USER.id,
        email: EXISTING_USER.email,
        name: EXISTING_USER.name,
        role: EXISTING_USER.role,
      });
      expect(dbServiceMock.db.insert).not.toHaveBeenCalled();
    });

    it('handles email-collision path — when user already exists by email, falls back to select by email', async () => {
      // Arrange: no existing oauth account, insert returns empty (onConflictDoNothing hit),
      // fallback select by email returns the existing user
      const existingUserByEmail = { ...EXISTING_USER, id: 'email-collision-uuid' };

      let selectCallCount = 0;
      let insertCallCount = 0;

      dbServiceMock.db = {
        select: jest.fn().mockImplementation(() => {
          selectCallCount++;
          const idx = selectCallCount;
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockImplementation((condition) => {
                if (idx === 1) {
                  // First select: oauth_accounts lookup → empty (no existing account)
                  return Promise.resolve([]);
                }
                // Third select: user lookup by email (fallback after conflict)
                return {
                  then: jest.fn().mockImplementation((cb: ([u]: unknown[]) => unknown) =>
                    Promise.resolve(cb([existingUserByEmail])),
                  ),
                };
              }),
            }),
          };
        }),
        insert: jest.fn().mockImplementation(() => {
          insertCallCount++;
          const idx = insertCallCount;
          if (idx === 1) {
            // users insert — onConflictDoNothing returns empty (email already taken)
            return {
              values: jest.fn().mockReturnValue({
                onConflictDoNothing: jest.fn().mockReturnValue({
                  returning: jest.fn().mockResolvedValue([]),
                }),
              }),
            };
          }
          // oauth_accounts insert — succeeds
          return {
            values: jest.fn().mockResolvedValue(undefined),
          };
        }),
        // The collision target may be an unconfirmed local account, which the
        // service releases by stamping emailVerifiedAt.
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      } as unknown as typeof dbServiceMock.db;

      // Act
      const result = await service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE);

      // Assert: returns the user found by email, not a newly created one
      expect(result).toEqual({
        id: existingUserByEmail.id,
        email: existingUserByEmail.email,
        name: existingUserByEmail.name,
        role: existingUserByEmail.role,
      });
      expect(dbServiceMock.db.insert).toHaveBeenCalledTimes(2);
    });

    it('propagates errors thrown by the database during oauth account lookup', async () => {
      // Arrange: DB throws on first select (oauth_accounts lookup)
      const dbError = new Error('DB connection lost');

      dbServiceMock.db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockRejectedValue(dbError),
          }),
        }),
        insert: jest.fn(),
      } as unknown as typeof dbServiceMock.db;

      // Act & Assert
      await expect(
        service.findOrCreateUser(GOOGLE_PROVIDER, PROVIDER_ID, PROFILE),
      ).rejects.toThrow('DB connection lost');
    });
  });
});
