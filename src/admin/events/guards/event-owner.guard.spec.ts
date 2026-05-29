// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../../../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../../../database/database.service');

import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventOwnerGuard } from './event-owner.guard';
import { EventsService } from '../events.service';

const MOCK_EVENT = {
  id: 'event-uuid-1',
  userId: 'user-uuid-1',
  name: 'My Wedding',
  slug: 'my-wedding-2025',
  date: new Date('2025-10-10'),
  createdAt: new Date(),
};

function buildExecutionContext(
  userId: string,
  eventId: string,
): ExecutionContext {
  const request = {
    params: { eventId },
    user: { id: userId },
    event: undefined as unknown,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('EventOwnerGuard', () => {
  let guard: EventOwnerGuard;
  const mockEventsService = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventOwnerGuard,
        { provide: EventsService, useValue: mockEventsService },
      ],
    }).compile();

    guard = module.get<EventOwnerGuard>(EventOwnerGuard);
  });

  describe('canActivate', () => {
    it('returns true and attaches event to request when user is the owner', async () => {
      mockEventsService.findOne.mockResolvedValueOnce(MOCK_EVENT);

      const ctx = buildExecutionContext('user-uuid-1', 'event-uuid-1');
      const request = ctx.switchToHttp().getRequest() as { event: unknown };

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request.event).toEqual(MOCK_EVENT);
      expect(mockEventsService.findOne).toHaveBeenCalledWith('event-uuid-1');
    });

    it('throws ForbiddenException when user does not own the event', async () => {
      mockEventsService.findOne.mockResolvedValueOnce({
        ...MOCK_EVENT,
        userId: 'different-user-id',
      });

      const ctx = buildExecutionContext('user-uuid-1', 'event-uuid-1');

      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException with correct message when non-owner accesses', async () => {
      mockEventsService.findOne.mockResolvedValueOnce({
        ...MOCK_EVENT,
        userId: 'other-user',
      });

      const ctx = buildExecutionContext('user-uuid-1', 'event-uuid-1');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        'You do not own this event',
      );
    });

    it('propagates NotFoundException when eventId does not exist', async () => {
      mockEventsService.findOne.mockRejectedValueOnce(
        new NotFoundException('Event nonexistent-id not found'),
      );

      const ctx = buildExecutionContext('user-uuid-1', 'nonexistent-id');

      await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
    });
  });
});
