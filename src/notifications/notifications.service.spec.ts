// Mock secrets before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { DatabaseService } from '../database/database.service';
import { WhatsappClient, SendFailureReason } from '../whatsapp/whatsapp.client';

const mockGuestA = {
  id: 'guest-uuid-1',
  eventId: 'event-uuid-1',
  name: 'Alice',
  phone: '541100000001',
  email: null,
  tableId: null,
  tickets: 1,
  tableNumber: null,
  rsvpStatus: 'PENDING',
  invitationSent: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockGuestB = { ...mockGuestA, id: 'guest-uuid-2', name: 'Bob', phone: '541100000002' };

const EVENT_ROW = { userId: 'user-uuid-1', name: 'Boda de Alice' };
const USER_ROW = { name: 'Carlos' };

/**
 * Mock `DatabaseService` whose `select().from().where()` chain resolves to
 * the NEXT array in `selectResultsQueue`, one array per `select()` call —
 * this lets a single mock represent the recipients query, the event-name
 * query, and the user-name query as separate, ordered calls. `update()`
 * resolves via a separately controllable chain for `invitationSent` flips.
 */
function buildMockDb(selectResultsQueue: unknown[][] = []) {
  let callIndex = 0;
  const whereFns: jest.Mock[] = [];

  const select = jest.fn().mockImplementation(() => {
    const rows = selectResultsQueue[callIndex] ?? [];
    callIndex += 1;
    const where = jest.fn().mockResolvedValue(rows);
    whereFns.push(where);
    const from = jest.fn().mockReturnValue({ where });
    return { from };
  });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set: updateSet });

  return {
    select,
    update,
    _internals: { whereFns, updateSet, updateWhere },
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let dbServiceMock: { db: ReturnType<typeof buildMockDb> };
  let whatsappClientMock: { sendWithResult: jest.Mock };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };
    whatsappClientMock = { sendWithResult: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: DatabaseService, useValue: dbServiceMock },
        { provide: WhatsappClient, useValue: whatsappClientMock },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('notifySelected — real per-recipient send (delivery: "live")', () => {
    it('sends a real interactive message to every recipient and reports "sent" outcomes', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(result.delivery).toBe('live');
      expect(result.notifiedCount).toBe(1);
      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);

      const [phone, body, buttons] = whatsappClientMock.sendWithResult.mock.calls[0];
      expect(phone).toBe('541100000001');
      expect(body).toBe(
        'Hola Alice, Carlos te ha invitado a su evento, ¿quieres confirmar tu asistencia?',
      );
      expect(buttons).toEqual([
        { id: 'guest_rsvp_yes:guest-uuid-1', title: 'Asistiré' },
        { id: 'guest_rsvp_no:guest-uuid-1', title: 'No podré asistir' },
      ]);
    });

    it('short-circuits without querying when guestIds is empty', async () => {
      const result = await service.notifySelected('event-uuid-1', []);

      expect(result).toEqual({
        delivery: 'live',
        notifiedCount: 0,
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
        recipients: [],
      });
      expect(dbServiceMock.db.select).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendWithResult).not.toHaveBeenCalled();
    });

    it('skips an invalid/empty-phone recipient WITHOUT blocking the rest of the batch', async () => {
      const invalidPhoneGuest = { ...mockGuestB, phone: '' };
      dbServiceMock.db = buildMockDb([[mockGuestA, invalidPhoneGuest], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockImplementation((phone: string) =>
        phone === ''
          ? Promise.resolve({ ok: false, reason: SendFailureReason.INVALID_PHONE })
          : Promise.resolve({ ok: true }),
      );

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(result.sentCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.recipients).toContainEqual({
        id: 'guest-uuid-2',
        name: 'Bob',
        phone: '',
        status: 'skipped',
        reason: SendFailureReason.INVALID_PHONE,
      });
      // The valid recipient was still sent — the batch was not blocked.
      expect(result.recipients).toContainEqual(
        expect.objectContaining({ id: 'guest-uuid-1', status: 'sent' }),
      );
    });

    it('produces a mixed-batch result distinguishing a 131047 (window closed) failure from a success, never throwing', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult
        .mockResolvedValueOnce({ ok: true, messageId: 'wamid.1' })
        .mockResolvedValueOnce({
          ok: false,
          reason: SendFailureReason.WINDOW_CLOSED,
          graphCode: 131047,
        });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.recipients).toContainEqual(
        expect.objectContaining({
          id: 'guest-uuid-2',
          status: 'failed',
          reason: SendFailureReason.WINDOW_CLOSED,
          graphCode: 131047,
        }),
      );
    });

    it('keeps a 131049 (marketing throttled) failure DISTINCT from a 131047 (window closed) failure', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(result.recipients[0]).toEqual(
        expect.objectContaining({ reason: SendFailureReason.MARKETING_THROTTLED, graphCode: 131049 }),
      );
      expect(result.recipients[0].reason).not.toBe(SendFailureReason.WINDOW_CLOSED);
    });

    it('falls back to events.name when the resolved inviter name is empty/whitespace, resolved ONCE per call (not per recipient)', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA, mockGuestB],
        [EVENT_ROW],
        [{ name: '   ' }], // whitespace-only user name
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      const bodies = whatsappClientMock.sendWithResult.mock.calls.map(([, body]) => body);
      expect(bodies[0]).toContain(EVENT_ROW.name);
      expect(bodies[1]).toContain(EVENT_ROW.name);
      // Exactly 3 select() calls total (recipients, event, user) for 2
      // recipients proves the name was resolved ONCE, not per recipient.
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(3);
    });

    it('flips guests.invitationSent to true (best-effort) after a successful send', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
      expect(dbServiceMock.db._internals.updateSet).toHaveBeenCalledWith({ invitationSent: true });
    });

    it('does NOT flip invitationSent when the send fails', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.UNKNOWN,
      });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(dbServiceMock.db.update).not.toHaveBeenCalled();
    });

    it('swallows a failure while flipping invitationSent — never blocks the response (best-effort)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [EVENT_ROW], [USER_ROW]]);
      dbServiceMock.db._internals.updateWhere.mockRejectedValueOnce(new Error('db down'));
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await expect(
        service.notifySelected('event-uuid-1', ['guest-uuid-1']),
      ).resolves.toMatchObject({ sentCount: 1 });
    });
  });

  describe('notifyAll (delivery: "mock" — real delivery out of scope for this slice)', () => {
    it('returns delivery:"mock" for every guest of the event (no search)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB]]);

      const result = await service.notifyAll('event-uuid-1');

      expect(result.delivery).toBe('mock');
      expect(result.notifiedCount).toBe(2);
      expect(result.sentCount).toBe(0);
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(1);
      expect(whatsappClientMock.sendWithResult).not.toHaveBeenCalled();
    });

    it('applies the search filter when provided, notifying only matching guests', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA]]);

      const result = await service.notifyAll('event-uuid-1', 'alice');

      expect(result.notifiedCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'skipped' },
      ]);
    });

    it('produces a DIFFERENT where condition with search vs without (proves the filter is really applied, not dropped)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA]]);
      await service.notifyAll('event-uuid-1');
      const conditionWithoutSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      dbServiceMock.db = buildMockDb([[mockGuestA]]);
      await service.notifyAll('event-uuid-1', 'alice');
      const conditionWithSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      expect(conditionWithSearch).not.toEqual(conditionWithoutSearch);
    });
  });

  describe('notifyPending (delivery: "mock" — real delivery out of scope for this slice)', () => {
    it('returns delivery:"mock" scoped to pending guests (no search)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA]]);

      const result = await service.notifyPending('event-uuid-1');

      expect(result).toMatchObject({ delivery: 'mock', notifiedCount: 1 });
      expect(dbServiceMock.db._internals.whereFns[0]).toHaveBeenCalledTimes(1);
    });

    it('combines the search filter with the PENDING restriction', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA]]);

      const result = await service.notifyPending('event-uuid-1', 'alice');

      expect(result.notifiedCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'skipped' },
      ]);
    });

    it('produces a DIFFERENT where condition for notifyPending with search vs without (proves the filter is really applied)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA]]);
      await service.notifyPending('event-uuid-1');
      const conditionWithoutSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      dbServiceMock.db = buildMockDb([[mockGuestA]]);
      await service.notifyPending('event-uuid-1', 'alice');
      const conditionWithSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      expect(conditionWithSearch).not.toEqual(conditionWithoutSearch);
    });
  });
});
