// Mock secrets before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_SECRET: 'test-secret',
  },
}));
jest.mock('../database/database.service');

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service';
import { SendFailureReason, WhatsappClient } from '../whatsapp/whatsapp.client';
import { NotificationsService } from './notifications.service';

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
  let whatsappClientMock: { sendWithResult: jest.Mock; sendTemplateWithResult: jest.Mock };

  beforeEach(async () => {
    dbServiceMock = { db: buildMockDb() };
    whatsappClientMock = {
      sendWithResult: jest.fn(),
      // Default: the template fallback is reachable but fails, so a test that
      // does not opt into it explicitly cannot silently "pass" through it.
      sendTemplateWithResult: jest
        .fn()
        .mockResolvedValue({ ok: false, reason: SendFailureReason.UNKNOWN }),
    };

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
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
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
        'Hola Alice, Carlos te ha invitado a su evento, ¿te gustaría confirmar tu asistencia?',
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
        allSent: true,
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
      dbServiceMock.db = buildMockDb([[mockGuestA, invalidPhoneGuest], [], [EVENT_ROW], [USER_ROW]]);
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

    it('produces a mixed-batch result where a 131047 recipient carries the TEMPLATE failure, never throwing', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult
        .mockResolvedValueOnce({ ok: true, messageId: 'wamid.1' })
        .mockResolvedValueOnce({
          ok: false,
          reason: SendFailureReason.WINDOW_CLOSED,
          graphCode: 131047,
        });
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(1);
      // The template result is the SOLE outcome for the cold recipient — the
      // failed free-form attempt is not reported separately.
      expect(result.recipients).toContainEqual(
        expect.objectContaining({
          id: 'guest-uuid-2',
          status: 'failed',
          reason: SendFailureReason.MARKETING_THROTTLED,
          graphCode: 131049,
        }),
      );
      expect(result.recipients).toHaveLength(2);
    });

    it('keeps a 131049 (marketing throttled) failure DISTINCT from a 131047 (window closed) failure', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
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
        [], // no additional phones
        [EVENT_ROW],
        [{ name: '   ' }], // whitespace-only user name
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      const bodies = whatsappClientMock.sendWithResult.mock.calls.map(([, body]) => body);
      expect(bodies[0]).toContain(EVENT_ROW.name);
      expect(bodies[1]).toContain(EVENT_ROW.name);
      // Exactly 4 select() calls total (recipients, guest_phones, event, user)
      // for 2 recipients proves the name was resolved ONCE, not per recipient.
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(4);
    });

    it('flips guests.invitationSent to true (best-effort) after a successful send', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
      expect(dbServiceMock.db._internals.updateSet).toHaveBeenCalledWith({ invitationSent: true });
    });

    it('does NOT flip invitationSent when the send fails', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.UNKNOWN,
      });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(dbServiceMock.db.update).not.toHaveBeenCalled();
    });

    it('swallows a failure while flipping invitationSent — never blocks the response (best-effort)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      dbServiceMock.db._internals.updateWhere.mockRejectedValueOnce(new Error('db down'));
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await expect(
        service.notifySelected('event-uuid-1', ['guest-uuid-1']),
      ).resolves.toMatchObject({ sentCount: 1 });
    });
  });

  describe('notifySelected — multi-phone fan-out over guest_phones', () => {
    it('sends to the primary AND every additional phone, reporting ONE "sent" outcome per guest', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA],
        [
          { guestId: 'guest-uuid-1', phone: '541100000002' },
          { guestId: 'guest-uuid-1', phone: '541100000003' },
        ],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(3);
      const dialed = whatsappClientMock.sendWithResult.mock.calls.map(([p]) => p);
      expect(dialed).toEqual(['541100000001', '541100000002', '541100000003']);
      expect(result.sentCount).toBe(1);
      expect(result.notifiedCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
      // flipInvitationSent runs exactly ONCE per guest, not once per phone.
      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('deduplicates a primary that equals an additional number — sends only ONCE (Familia Martinez bug)', async () => {
      const martinez = {
        ...mockGuestA,
        id: 'guest-uuid-9',
        name: 'Familia Martinez',
        phone: '523319638873',
      };
      dbServiceMock.db = buildMockDb([
        [martinez],
        [{ guestId: 'guest-uuid-9', phone: '523319638873' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-9']);

      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(1);
      expect(result.sentCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-9', name: 'Familia Martinez', phone: '523319638873', status: 'sent' },
      ]);
    });

    it('deduplicates by NORMALIZED number (an MX 521 wa_id additional collapses onto the 52 primary)', async () => {
      const guest = { ...mockGuestA, id: 'guest-uuid-10', name: 'Mextel', phone: '523319638873' };
      dbServiceMock.db = buildMockDb([
        [guest],
        [{ guestId: 'guest-uuid-10', phone: '5213319638873' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-10']);

      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(1);
      expect(result.sentCount).toBe(1);
    });

    it('reports "sent" when the primary FAILS but an additional SUCCEEDS (any success wins)', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA],
        [{ guestId: 'guest-uuid-1', phone: '541100000099' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockImplementation((phone: string) =>
        phone === '541100000001'
          ? Promise.resolve({ ok: false, reason: SendFailureReason.WINDOW_CLOSED, graphCode: 131047 })
          : Promise.resolve({ ok: true }),
      );

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(2);
      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('reports "sent" when the primary SUCCEEDS but an additional FAILS (partial failure hidden by design)', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA],
        [{ guestId: 'guest-uuid-1', phone: '541100000099' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockImplementation((phone: string) =>
        phone === '541100000001'
          ? Promise.resolve({ ok: true })
          : Promise.resolve({ ok: false, reason: SendFailureReason.UNKNOWN }),
      );

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.recipients[0]).toMatchObject({ id: 'guest-uuid-1', status: 'sent' });
    });

    it('behaves exactly as today for a guest with NO additional phones — a single send, single outcome', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
    });

    it('skips a guest with an empty primary and no valid additional numbers, WITHOUT attempting a send', async () => {
      const noPhone = { ...mockGuestA, id: 'guest-uuid-3', name: 'Nadie', phone: '' };
      dbServiceMock.db = buildMockDb([[noPhone], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-3']);

      expect(whatsappClientMock.sendWithResult).not.toHaveBeenCalled();
      expect(result.skippedCount).toBe(1);
      expect(result.recipients).toEqual([
        {
          id: 'guest-uuid-3',
          name: 'Nadie',
          phone: '',
          status: 'skipped',
          reason: SendFailureReason.INVALID_PHONE,
        },
      ]);
    });

    it('aggregates counts PER-GUEST across a mixed batch (sent / skipped / failed)', async () => {
      const sender = { ...mockGuestA, id: 'g-sent', name: 'Sent', phone: '541100000001' };
      const skipper = { ...mockGuestA, id: 'g-skip', name: 'Skip', phone: '' };
      const failer = { ...mockGuestA, id: 'g-fail', name: 'Fail', phone: '541100000005' };
      dbServiceMock.db = buildMockDb([
        [sender, skipper, failer],
        [{ guestId: 'g-sent', phone: '541100000002' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockImplementation((phone: string) =>
        phone === '541100000005'
          ? Promise.resolve({ ok: false, reason: SendFailureReason.WINDOW_CLOSED, graphCode: 131047 })
          : Promise.resolve({ ok: true }),
      );
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });

      const result = await service.notifySelected('event-uuid-1', ['g-sent', 'g-skip', 'g-fail']);

      expect(result.notifiedCount).toBe(3);
      expect(result.sentCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      // sender: primary + 1 additional = 2 sends; failer: 1 send; skipper: 0 sends.
      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(3);
      expect(result.recipients).toContainEqual({
        id: 'g-sent',
        name: 'Sent',
        phone: '541100000001',
        status: 'sent',
      });
      expect(result.recipients).toContainEqual({
        id: 'g-skip',
        name: 'Skip',
        phone: '',
        status: 'skipped',
        reason: SendFailureReason.INVALID_PHONE,
      });
      expect(result.recipients).toContainEqual({
        id: 'g-fail',
        name: 'Fail',
        phone: '541100000005',
        status: 'failed',
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });
      // One outcome per recipient, always — the template fallback never adds
      // or drops a row.
      expect(result.recipients).toHaveLength(3);
    });
  });

  describe('notifySelected — cold-guest template fallback (24h window closed)', () => {
    const TEMPLATE_ARGS = {
      name: 'guest_invite_rsvp',
      lang: 'es',
      message: 'Esperamos que puedas acompañarnos',
    };

    it('does NOT touch the template when the free-form send succeeds (in-window guest)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendTemplateWithResult).not.toHaveBeenCalled();
      expect(result.sentCount).toBe(1);
      expect(result.recipients).toHaveLength(1);
    });

    it('falls back to the approved template on WINDOW_CLOSED and reports ONE "sent" outcome', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.WINDOW_CLOSED,
        graphCode: 131047,
      });
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({
        ok: true,
        messageId: 'wamid.tpl',
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendTemplateWithResult).toHaveBeenCalledTimes(1);
      const [phone, name, lang, bodyParams, buttonPayloads] =
        whatsappClientMock.sendTemplateWithResult.mock.calls[0];
      expect(phone).toBe('541100000001');
      expect(name).toBe(TEMPLATE_ARGS.name);
      expect(lang).toBe(TEMPLATE_ARGS.lang);
      expect(bodyParams).toEqual(['Alice', 'Carlos', TEMPLATE_ARGS.message]);
      expect(buttonPayloads).toEqual([
        'guest_rsvp_yes:guest-uuid-1',
        'guest_rsvp_no:guest-uuid-1',
      ]);

      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
      // invitationSent is flipped exactly once — the template send counts.
      expect(dbServiceMock.db.update).toHaveBeenCalledTimes(1);
    });

    it('reports ONE "failed" carrying the TEMPLATE reason when the fallback also fails', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.WINDOW_CLOSED,
        graphCode: 131047,
      });
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.TEMPLATE_PARAM_INVALID,
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(result.failedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      expect(result.recipients).toEqual([
        {
          id: 'guest-uuid-1',
          name: 'Alice',
          phone: '541100000001',
          status: 'failed',
          reason: SendFailureReason.TEMPLATE_PARAM_INVALID,
          graphCode: undefined,
        },
      ]);
      expect(dbServiceMock.db.update).not.toHaveBeenCalled();
    });

    it('does NOT fall back to the template for an INVALID_PHONE free-form failure', async () => {
      const badPhoneGuest = { ...mockGuestA, id: 'guest-uuid-4', phone: '541100000123' };
      dbServiceMock.db = buildMockDb([[badPhoneGuest], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.INVALID_PHONE,
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-4']);

      expect(whatsappClientMock.sendTemplateWithResult).not.toHaveBeenCalled();
      expect(result.skippedCount).toBe(1);
      expect(result.recipients).toHaveLength(1);
      expect(result.recipients[0].status).toBe('skipped');
    });

    it('does NOT fall back to the template for a MARKETING_THROTTLED failure (only 131047 is a window problem)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendTemplateWithResult).not.toHaveBeenCalled();
      expect(result.failedCount).toBe(1);
      expect(result.recipients[0]).toMatchObject({
        reason: SendFailureReason.MARKETING_THROTTLED,
      });
    });

    it('applies the fallback PER NUMBER when a guest has additional phones', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA],
        [{ guestId: 'guest-uuid-1', phone: '541100000099' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.WINDOW_CLOSED,
        graphCode: 131047,
      });
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(whatsappClientMock.sendTemplateWithResult).toHaveBeenCalledTimes(2);
      const dialed = whatsappClientMock.sendTemplateWithResult.mock.calls.map(([p]) => p);
      expect(dialed).toEqual(['541100000001', '541100000099']);
      expect(result.sentCount).toBe(1);
      expect(result.recipients).toHaveLength(1);
    });
  });

  describe('notifyAll — real per-recipient send (delivery: "live")', () => {
    beforeEach(() => {
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });
    });

    it('sends a real message to every guest of the event (no search)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifyAll('event-uuid-1');

      expect(result.delivery).toBe('live');
      expect(result.notifiedCount).toBe(2);
      expect(result.sentCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(2);
      const dialed = whatsappClientMock.sendWithResult.mock.calls.map(([p]) => p);
      expect(dialed).toEqual(['541100000001', '541100000002']);
    });

    it('fans out to the additional phones of each recipient', async () => {
      dbServiceMock.db = buildMockDb([
        [mockGuestA],
        [{ guestId: 'guest-uuid-1', phone: '541100000099' }],
        [EVENT_ROW],
        [USER_ROW],
      ]);

      const result = await service.notifyAll('event-uuid-1');

      const dialed = whatsappClientMock.sendWithResult.mock.calls.map(([p]) => p);
      expect(dialed).toEqual(['541100000001', '541100000099']);
      expect(result.sentCount).toBe(1);
      expect(result.recipients).toHaveLength(1);
    });

    it('short-circuits without sending when no guest matches', async () => {
      dbServiceMock.db = buildMockDb([[]]);

      const result = await service.notifyAll('event-uuid-1', 'nobody');

      expect(result).toEqual({
        delivery: 'live',
        allSent: true,
        notifiedCount: 0,
        sentCount: 0,
        failedCount: 0,
        skippedCount: 0,
        recipients: [],
      });
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(1);
      expect(whatsappClientMock.sendWithResult).not.toHaveBeenCalled();
    });

    it('applies the search filter when provided, notifying only matching guests', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifyAll('event-uuid-1', 'alice');

      expect(result.notifiedCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
    });

    it('produces a DIFFERENT where condition with search vs without (proves the filter is really applied, not dropped)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      await service.notifyAll('event-uuid-1');
      const conditionWithoutSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      await service.notifyAll('event-uuid-1', 'alice');
      const conditionWithSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      expect(conditionWithSearch).not.toEqual(conditionWithoutSearch);
    });
  });

  describe('notifyPending — real per-recipient send (delivery: "live")', () => {
    beforeEach(() => {
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });
    });

    it('sends only to pending guests (no search)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifyPending('event-uuid-1');

      expect(result).toMatchObject({ delivery: 'live', notifiedCount: 1, sentCount: 1 });
      expect(whatsappClientMock.sendWithResult).toHaveBeenCalledTimes(1);
      expect(dbServiceMock.db._internals.whereFns[0]).toHaveBeenCalledTimes(1);
    });

    it('combines the search filter with the PENDING restriction', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifyPending('event-uuid-1', 'alice');

      expect(result.notifiedCount).toBe(1);
      expect(result.recipients).toEqual([
        { id: 'guest-uuid-1', name: 'Alice', phone: '541100000001', status: 'sent' },
      ]);
    });

    it('falls back to the approved template when the 24h window is closed', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({
        ok: false,
        reason: SendFailureReason.WINDOW_CLOSED,
        graphCode: 131047,
      });
      whatsappClientMock.sendTemplateWithResult.mockResolvedValue({ ok: true });

      const result = await service.notifyPending('event-uuid-1');

      expect(whatsappClientMock.sendTemplateWithResult).toHaveBeenCalledTimes(1);
      expect(result.sentCount).toBe(1);
    });

    it('short-circuits without sending when no pending guest matches', async () => {
      dbServiceMock.db = buildMockDb([[]]);

      const result = await service.notifyPending('event-uuid-1');

      expect(result.notifiedCount).toBe(0);
      expect(dbServiceMock.db.select).toHaveBeenCalledTimes(1);
      expect(whatsappClientMock.sendWithResult).not.toHaveBeenCalled();
    });

    it('produces a DIFFERENT where condition for notifyPending with search vs without (proves the filter is really applied)', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      await service.notifyPending('event-uuid-1');
      const conditionWithoutSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      await service.notifyPending('event-uuid-1', 'alice');
      const conditionWithSearch = dbServiceMock.db._internals.whereFns[0].mock.calls[0][0];

      expect(conditionWithSearch).not.toEqual(conditionWithoutSearch);
    });
  });

  describe('allSent — one-field delivery signal for the dashboard', () => {
    it('is true when every recipient was sent', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(result.sentCount).toBe(2);
      expect(result.allSent).toBe(true);
    });

    it('is false when at least one recipient failed', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult
        .mockResolvedValueOnce({ ok: true, messageId: 'wamid.1' })
        .mockResolvedValueOnce({
          ok: false,
          reason: SendFailureReason.MARKETING_THROTTLED,
          graphCode: 131049,
        });

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(result.failedCount).toBe(1);
      expect(result.allSent).toBe(false);
    });

    it('is false when a recipient was skipped (no valid number)', async () => {
      const noPhoneGuest = { ...mockGuestA, phone: '' };
      dbServiceMock.db = buildMockDb([[noPhoneGuest], [], [EVENT_ROW], [USER_ROW]]);

      const result = await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(result.skippedCount).toBe(1);
      expect(result.allSent).toBe(false);
    });
  });

  describe('dispatch logging — surfaces every non-sent recipient', () => {
    let warnSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('warns once per non-sent recipient, naming the guest and the reason', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA, mockGuestB], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult
        .mockResolvedValueOnce({ ok: true, messageId: 'wamid.1' })
        .mockResolvedValueOnce({
          ok: false,
          reason: SendFailureReason.MARKETING_THROTTLED,
          graphCode: 131049,
        });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1', 'guest-uuid-2']);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warned = warnSpy.mock.calls[0][0] as string;
      expect(warned).toContain('guest-uuid-2');
      expect(warned).toContain(SendFailureReason.MARKETING_THROTTLED);
    });

    it('warns for a guest skipped because it has no valid number at all', async () => {
      const noPhoneGuest = { ...mockGuestA, phone: '' };
      dbServiceMock.db = buildMockDb([[noPhoneGuest], [], [EVENT_ROW], [USER_ROW]]);

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warned = warnSpy.mock.calls[0][0] as string;
      expect(warned).toContain('guest-uuid-1');
      expect(warned).toContain('skipped');
    });

    it('does not warn when every recipient was sent', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('logs a per-event summary with the sent/failed/skipped counts', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true, messageId: 'wamid.1' });

      await service.notifySelected('event-uuid-1', ['guest-uuid-1']);

      const summary = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(summary).toContain('event-uuid-1');
      expect(summary).toMatch(/1 sent/);
    });
  });

  describe('request logging — proves the real dispatch started, even when nobody matches', () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const logsFor = () => logSpy.mock.calls.map((c) => String(c[0]));

    it('logs that a PENDING notify was requested, naming the event, BEFORE any send', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifyPending('event-uuid-1');

      expect(
        logsFor().some((l) => l.includes('event-uuid-1') && /pending/i.test(l) && /request/i.test(l)),
      ).toBe(true);
    });

    it('logs a dispatch line even when ZERO pending guests match, so an empty set is NOT silent', async () => {
      dbServiceMock.db = buildMockDb([[]]);

      await service.notifyPending('event-uuid-1');

      expect(
        logsFor().some((l) => l.includes('event-uuid-1') && /0 recipient/i.test(l)),
      ).toBe(true);
    });

    it('records the search term when a filtered PENDING notify is requested', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifyPending('event-uuid-1', 'alice');

      expect(logsFor().some((l) => /request/i.test(l) && l.includes('alice'))).toBe(true);
    });

    it('logs an ALL notify request naming the mode', async () => {
      dbServiceMock.db = buildMockDb([[mockGuestA], [], [EVENT_ROW], [USER_ROW]]);
      whatsappClientMock.sendWithResult.mockResolvedValue({ ok: true });

      await service.notifyAll('event-uuid-1');

      expect(logsFor().some((l) => l.includes('event-uuid-1') && /all/i.test(l) && /request/i.test(l))).toBe(true);
    });

    it('logs a SELECTED notify request even for an empty selection (short-circuit path)', async () => {
      await service.notifySelected('event-uuid-1', []);

      expect(
        logsFor().some((l) => l.includes('event-uuid-1') && /selected/i.test(l) && /request/i.test(l)),
      ).toBe(true);
    });
  });
});
