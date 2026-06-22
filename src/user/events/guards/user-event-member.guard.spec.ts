// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../../database/database.service');

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserEventMemberGuard } from './user-event-member.guard';
import { DatabaseService } from '../../../database/database.service';

function buildExecutionContext(userId: string, eventId: string): ExecutionContext {
  const request = {
    params: { id: eventId },
    user: { id: userId },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function buildMockDb(rows: unknown[] = []) {
  const selectWhere = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where: selectWhere });

  return {
    select: jest.fn().mockReturnValue({ from }),
    _internals: { from, selectWhere },
  };
}

describe('UserEventMemberGuard', () => {
  let guard: UserEventMemberGuard;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventMemberGuard,
        { provide: DatabaseService, useValue: dbServiceMock },
      ],
    }).compile();

    guard = module.get<UserEventMemberGuard>(UserEventMemberGuard);
    jest.clearAllMocks();
  });

  describe('canActivate', () => {
    it('returns true when user is a member of the event', async () => {
      const membership = [{ id: 'eu-1', eventId: 'event-uuid-1', userId: 'user-uuid-1' }];
      dbServiceMock.db = buildMockDb(membership);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventMemberGuard,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const g = module.get<UserEventMemberGuard>(UserEventMemberGuard);

      const ctx = buildExecutionContext('user-uuid-1', 'event-uuid-1');
      const result = await g.canActivate(ctx);

      expect(result).toBe(true);
    });

    it('throws ForbiddenException when user is NOT a member of the event', async () => {
      dbServiceMock.db = buildMockDb([]);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventMemberGuard,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const g = module.get<UserEventMemberGuard>(UserEventMemberGuard);

      const ctx = buildExecutionContext('user-uuid-99', 'event-uuid-1');

      await expect(g.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException with correct message when non-member accesses', async () => {
      dbServiceMock.db = buildMockDb([]);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventMemberGuard,
          { provide: DatabaseService, useValue: dbServiceMock },
        ],
      }).compile();
      const g = module.get<UserEventMemberGuard>(UserEventMemberGuard);

      const ctx = buildExecutionContext('user-uuid-99', 'event-uuid-1');

      await expect(g.canActivate(ctx)).rejects.toThrow(
        'You are not a member of this event',
      );
    });

    it('reads params.id (not params.eventId) for the event identifier', async () => {
      const membership = [{ id: 'eu-1', eventId: 'event-uuid-42', userId: 'user-uuid-1' }];
      const selectWhere = jest.fn().mockResolvedValue(membership);
      const from = jest.fn().mockReturnValue({ where: selectWhere });
      const db = { select: jest.fn().mockReturnValue({ from }) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UserEventMemberGuard,
          { provide: DatabaseService, useValue: { db } },
        ],
      }).compile();
      const g = module.get<UserEventMemberGuard>(UserEventMemberGuard);

      // Use params.id = 'event-uuid-42'
      const ctx = buildExecutionContext('user-uuid-1', 'event-uuid-42');
      const result = await g.canActivate(ctx);

      expect(result).toBe(true);
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });
});
