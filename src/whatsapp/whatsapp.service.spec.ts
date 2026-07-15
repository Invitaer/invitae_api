// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
    WHATSAPP_API_URL: 'https://graph.facebook.com/v18.0',
    WHATSAPP_API_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-id-123',
  },
}));
jest.mock('../redis/redis.service');
jest.mock('./whatsapp-link.service');
jest.mock('./conversation.store');
jest.mock('./whatsapp.client');
jest.mock('../user/events/user-events.service');
jest.mock('../admin/guests/guests.service');

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappService } from './whatsapp.service';
import { RedisService } from '../redis/redis.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';
import { WhatsappClient } from './whatsapp.client';
import { UserEventsService } from '../user/events/user-events.service';
import { GuestsService } from '../admin/guests/guests.service';

function buildPayload(messageId: string, from: string, text: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ id: messageId, from, text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

function buildInteractivePayload(
  messageId: string,
  from: string,
  interactiveId: string,
  replyType: 'button_reply' | 'list_reply' = 'list_reply',
) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: messageId,
                  from,
                  interactive: { [replyType]: { id: interactiveId, title: 'x' } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * `handleIncoming` now issues TWO `setNX` calls per message: first the
 * per-user lock (`wa:lock:{phone}`), then the message-id dedup claim
 * (`wa:msg:{id}`). This helper installs a key-aware implementation so the
 * lock acquisition succeeds by default and only the dedup key drives the
 * duplicate path — mirroring production, where the lock is normally free.
 */
function mockRedisSetNX(
  mock: jest.Mock,
  opts: { lock?: boolean; msgId?: boolean } = {},
): void {
  const lock = opts.lock ?? true;
  const msgId = opts.msgId ?? true;
  mock.mockImplementation((key: string) =>
    Promise.resolve(key.startsWith('wa:lock:') ? lock : msgId),
  );
}

describe('WhatsappService', () => {
  let service: WhatsappService;
  let redisServiceMock: { setNX: jest.Mock; del: jest.Mock; delIfEquals: jest.Mock };
  let delaySpy: jest.SpyInstance;
  let whatsappLinkServiceMock: {
    verifyAndLink: jest.Mock;
    resolvePhone: jest.Mock;
  };
  let conversationStoreMock: { get: jest.Mock; set: jest.Mock; clear: jest.Mock };
  let whatsappClientMock: {
    sendText: jest.Mock;
    sendInteractiveButtons: jest.Mock;
    sendInteractiveList: jest.Mock;
  };
  let userEventsServiceMock: { findOne: jest.Mock; findByUser: jest.Mock };
  let guestsServiceMock: {
    findAll: jest.Mock;
    findAllPaginated: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };

  const USER_ID = 'user-uuid-1';
  const PHONE = '+5491100000000';
  const EVENT_ID = 'event-uuid-1';

  beforeEach(async () => {
    redisServiceMock = { setNX: jest.fn(), del: jest.fn(), delIfEquals: jest.fn() };
    // Default: lock acquired, message-id unseen. Individual tests override.
    mockRedisSetNX(redisServiceMock.setNX);
    whatsappLinkServiceMock = {
      verifyAndLink: jest.fn(),
      resolvePhone: jest.fn(),
    };
    conversationStoreMock = { get: jest.fn(), set: jest.fn(), clear: jest.fn() };
    whatsappClientMock = {
      sendText: jest.fn(),
      sendInteractiveButtons: jest.fn(),
      sendInteractiveList: jest.fn(),
    };
    userEventsServiceMock = { findOne: jest.fn(), findByUser: jest.fn() };
    guestsServiceMock = {
      findAll: jest.fn(),
      findAllPaginated: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: WhatsappLinkService, useValue: whatsappLinkServiceMock },
        { provide: ConversationStore, useValue: conversationStoreMock },
        { provide: WhatsappClient, useValue: whatsappClientMock },
        { provide: UserEventsService, useValue: userEventsServiceMock },
        { provide: GuestsService, useValue: guestsServiceMock },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);

    // Never sleep for real during lock backoff — the `delay` method is
    // `protected` precisely so tests can stub it.
    delaySpy = jest
      .spyOn(service as unknown as { delay: (ms: number) => Promise<void> }, 'delay')
      .mockResolvedValue(undefined);

    // Default: sender is linked, unless a test overrides it
    whatsappLinkServiceMock.resolvePhone.mockResolvedValue(USER_ID);
    // Safe defaults so tests that dispatch but don't care about these
    // particular replies don't crash on undefined
    userEventsServiceMock.findByUser.mockResolvedValue([]);
  });

  describe('idempotency', () => {
    it('drops a duplicate message_id (dedup setNX false) without resolving the link', async () => {
      // Lock acquired, but the message-id was already claimed → duplicate.
      mockRedisSetNX(redisServiceMock.setNX, { msgId: false });

      await service.handleIncoming(buildPayload('msg-1', PHONE, 'hola'));

      expect(redisServiceMock.setNX).toHaveBeenCalledWith(
        'wa:msg:msg-1',
        expect.any(String),
        expect.any(Number),
      );
      expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
      expect(conversationStoreMock.get).not.toHaveBeenCalled();
    });

    it('claims and dispatches an unseen message_id (setNX true)', async () => {
      mockRedisSetNX(redisServiceMock.setNX);

      await service.handleIncoming(buildPayload('msg-2', PHONE, 'mis eventos'));

      expect(redisServiceMock.setNX).toHaveBeenCalledWith(
        'wa:msg:msg-2',
        expect.any(String),
        expect.any(Number),
      );
      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith(PHONE);
    });
  });

  describe('unlinked sender rejection', () => {
    it('does not touch the conversation store (no dispatch) when the phone has no verified link', async () => {
      mockRedisSetNX(redisServiceMock.setNX);
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue(null);

      await service.handleIncoming(buildPayload('msg-3', '+5491199999999', 'buscar Juan'));

      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith('+5491199999999');
      expect(conversationStoreMock.get).not.toHaveBeenCalled();
    });

    it('resolves the conversation context (identity resolution) when the phone IS linked', async () => {
      mockRedisSetNX(redisServiceMock.setNX);

      await service.handleIncoming(buildPayload('msg-4', PHONE, 'menu'));

      expect(conversationStoreMock.get).toHaveBeenCalledWith(PHONE);
    });
  });

  describe('OTP verification routing', () => {
    it('routes a 6-digit message from an UNLINKED phone to verifyAndLink (resolvePhone runs first and returns null)', async () => {
      mockRedisSetNX(redisServiceMock.setNX);
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue(null); // unlinked
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(true);

      await service.handleIncoming(buildPayload('msg-5', PHONE, '123456'));

      // F1: the phone is resolved BEFORE the OTP branch — only an unlinked
      // phone treats a 6-digit text as an OTP attempt.
      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith(PHONE);
      expect(whatsappLinkServiceMock.verifyAndLink).toHaveBeenCalledWith('123456', PHONE);
    });

    it('F1 — a LINKED user with an active flow who sends a 6-digit text is fed to the flow machine, NEVER verifyAndLink', async () => {
      mockRedisSetNX(redisServiceMock.setNX);
      // Linked user (default resolvePhone → USER_ID) already mid-flow.
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} },
      });

      await service.handleIncoming(buildPayload('msg-otp-hijack', PHONE, '123456'));

      // The 6-digit value must be consumed by the flow, not hijacked as an OTP.
      expect(whatsappLinkServiceMock.verifyAndLink).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({
          pendingAction: expect.objectContaining({ step: 'ASK_PHONE' }),
        }),
      );
    });
  });

  describe('per-user concurrency lock (F4)', () => {
    it('BLOCKER — never drops the message on lock contention: retries with backoff, then processes best-effort', async () => {
      // Lock is never acquirable (all attempts fail). Because Meta will not
      // retry a 200-acked webhook, the handler MUST still process the message.
      mockRedisSetNX(redisServiceMock.setNX, { lock: false });
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-contended', PHONE, 'menu'));

      // It backed off between attempts...
      expect(delaySpy).toHaveBeenCalled();
      // ...still claimed the message id and dispatched (best-effort)...
      expect(redisServiceMock.setNX).toHaveBeenCalledWith(
        'wa:msg:m-contended',
        expect.any(String),
        expect.any(Number),
      );
      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith(PHONE);
      expect(whatsappClientMock.sendText).toHaveBeenCalled();
      // ...and never released a lock it does not hold.
      expect(redisServiceMock.delIfEquals).not.toHaveBeenCalled();
    });

    it('acquires on a later attempt when the lock frees mid-backoff, then processes normally', async () => {
      // Fail the first two lock attempts, succeed on the third.
      let lockAttempts = 0;
      redisServiceMock.setNX.mockImplementation((key: string) => {
        if (key.startsWith('wa:lock:')) {
          lockAttempts += 1;
          return Promise.resolve(lockAttempts >= 3);
        }
        return Promise.resolve(true); // msg-id claim
      });
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-lock-eventual', PHONE, 'menu'));

      expect(lockAttempts).toBe(3);
      expect(delaySpy).toHaveBeenCalledTimes(2);
      expect(whatsappClientMock.sendText).toHaveBeenCalled();
      // Acquired -> released via compare-and-delete with its own token.
      expect(redisServiceMock.delIfEquals).toHaveBeenCalledWith(
        `wa:lock:${PHONE}`,
        'm-lock-eventual',
      );
    });

    it('CRITICAL — releases the per-user lock via compare-and-delete (token) after normal processing', async () => {
      mockRedisSetNX(redisServiceMock.setNX);
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-lock-release', PHONE, 'menu'));

      expect(redisServiceMock.delIfEquals).toHaveBeenCalledWith(
        `wa:lock:${PHONE}`,
        'm-lock-release',
      );
    });
  });

  describe('command dispatch — menu and navigation', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
    });

    it('replies to "menu" without touching UserEventsService/GuestsService', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-menu', PHONE, 'menu'));

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
      expect(userEventsServiceMock.findOne).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
    });

    it('"mis eventos" SENDS an interactive LIST (not text) whose rows are "select_event:{id}"', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findByUser.mockResolvedValue([
        { id: EVENT_ID, name: 'My Wedding' },
      ]);

      await service.handleIncoming(buildPayload('m-list', PHONE, 'mis eventos'));

      expect(userEventsServiceMock.findByUser).toHaveBeenCalledWith(USER_ID);
      expect(whatsappClientMock.sendInteractiveList).toHaveBeenCalledWith(
        PHONE,
        expect.any(String),
        expect.any(String),
        [{ id: `select_event:${EVENT_ID}`, title: 'My Wedding' }],
      );
      expect(whatsappClientMock.sendText).not.toHaveBeenCalled();
    });

    it('F8 — caps the events interactive list at 10 rows and notes the truncation when there are more than 10 events', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      const events = Array.from({ length: 14 }, (_, i) => ({
        id: `evt-${i}`,
        name: `Event ${i}`,
      }));
      userEventsServiceMock.findByUser.mockResolvedValue(events);

      await service.handleIncoming(buildPayload('m-list-cap', PHONE, 'mis eventos'));

      const [, body, , rows] = whatsappClientMock.sendInteractiveList.mock.calls[0];
      expect(rows.length).toBeLessThanOrEqual(10);
      expect(body).toContain('10');
    });

    it('FIX D — truncates a row title longer than WhatsApp\'s 24-char limit', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      const longName = 'Boda de Maria y Juan en el Salon Grande'; // > 24 chars
      userEventsServiceMock.findByUser.mockResolvedValue([{ id: EVENT_ID, name: longName }]);

      await service.handleIncoming(buildPayload('m-list-longtitle', PHONE, 'mis eventos'));

      const [, , , rows] = whatsappClientMock.sendInteractiveList.mock.calls[0];
      expect(rows[0].title.length).toBeLessThanOrEqual(24);
      // Row id still carries the FULL event id (only the title is clamped).
      expect(rows[0].id).toBe(`select_event:${EVENT_ID}`);
    });

    it('"mis eventos" with no memberships falls back to a text message (no empty interactive list)', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findByUser.mockResolvedValue([]);

      await service.handleIncoming(buildPayload('m-list-empty', PHONE, 'mis eventos'));

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        'No tenes eventos asociados todavia.',
      );
      expect(whatsappClientMock.sendInteractiveList).not.toHaveBeenCalled();
    });

    it('ROUND-TRIP: the exact "select_event:{id}" row id the bot SENDS via "mis eventos" is recognized back as SELECT_EVENT and sets currentEventId', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findByUser.mockResolvedValue([
        { id: EVENT_ID, name: 'My Wedding' },
      ]);

      await service.handleIncoming(buildPayload('m-list-rt', PHONE, 'mis eventos'));

      const [, , , rows] = whatsappClientMock.sendInteractiveList.mock.calls[0];
      const sentRowId: string = rows[0].id;

      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildInteractivePayload('m-list-rt-select', PHONE, sentRowId));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({ userId: USER_ID, currentEventId: EVENT_ID }),
      );
    });

    it('event-scoped command with no currentEventId prompts selection instead of executing', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID }); // no currentEventId

      await service.handleIncoming(buildPayload('m-detalle', PHONE, 'detalle'));

      expect(userEventsServiceMock.findOne).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
    });

    it('"cancelar" clears the conversation context', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { step: 'ASK_NAME' },
      });

      await service.handleIncoming(buildPayload('m-cancel', PHONE, 'cancelar'));

      expect(conversationStoreMock.clear).toHaveBeenCalledWith(PHONE);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
    });
  });

  describe('command dispatch — ownership enforcement (membership re-validation)', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
    });

    it('SELECT_EVENT: a member CAN select their event and currentEventId gets persisted', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });

      await service.handleIncoming(
        buildInteractivePayload('m-select', PHONE, `select_event:${EVENT_ID}`),
      );

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({ userId: USER_ID, currentEventId: EVENT_ID }),
      );
    });

    it('SELECT_EVENT: selecting an event the user is NOT a member of is rejected, context untouched', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findOne.mockRejectedValue(
        new NotFoundException(`Event ${EVENT_ID} not found`),
      );

      await service.handleIncoming(
        buildInteractivePayload('m-select-denied', PHONE, `select_event:${EVENT_ID}`),
      );

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(conversationStoreMock.set).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
    });

    it('a member of currentEventId CAN read that event guests (buscar)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
      guestsServiceMock.findAllPaginated.mockResolvedValue({ data: [], total: 0 });

      await service.handleIncoming(buildPayload('m-buscar', PHONE, 'buscar Juan'));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(guestsServiceMock.findAllPaginated).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ search: 'Juan' }),
      );
    });

    it('CRITICAL — non-member with a currentEventId in ctx is denied and GuestsService is NEVER called (cross-org leak prevention)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: 'attacker-uuid',
        currentEventId: EVENT_ID, // somehow present in Redis ctx, must NOT be trusted
      });
      userEventsServiceMock.findOne.mockRejectedValue(
        new NotFoundException(`Event ${EVENT_ID} not found`),
      );

      await service.handleIncoming(buildPayload('m-buscar-denied', PHONE, 'buscar Juan'));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, 'attacker-uuid');
      expect(guestsServiceMock.findAllPaginated).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
    });

    it('re-validates membership on EVERY dispatch, not just once — a second command from a now-removed member is denied', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      // First call (detalle) succeeds...
      userEventsServiceMock.findOne.mockResolvedValueOnce({ id: EVENT_ID, name: 'My Wedding' });
      await service.handleIncoming(buildPayload('m-detalle-1', PHONE, 'detalle'));
      expect(userEventsServiceMock.findOne).toHaveBeenNthCalledWith(1, EVENT_ID, USER_ID);

      // ...membership revoked between messages...
      userEventsServiceMock.findOne.mockRejectedValueOnce(
        new NotFoundException(`Event ${EVENT_ID} not found`),
      );
      await service.handleIncoming(buildPayload('m-resumen-2', PHONE, 'resumen'));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledTimes(2);
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
    });
  });

  describe('command dispatch — guest query commands', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    it('"detalle" fetches the event via UserEventsService.findOne and replies', async () => {
      await service.handleIncoming(buildPayload('m-detalle', PHONE, 'detalle'));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('My Wedding'),
      );
    });

    it('"filtrar confirmados" calls GuestsService.findAll and filters by ACCEPTED', async () => {
      guestsServiceMock.findAll.mockResolvedValue([
        { id: 'g1', name: 'A', rsvpStatus: 'ACCEPTED' },
        { id: 'g2', name: 'B', rsvpStatus: 'PENDING' },
        { id: 'g3', name: 'C', rsvpStatus: 'ACCEPTED' },
      ]);

      await service.handleIncoming(buildPayload('m-filtrar', PHONE, 'filtrar confirmados'));

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toContain('A');
      expect(message).toContain('C');
      expect(message).not.toContain('B');
    });

    it('"resumen" aggregates counts by rsvpStatus and total tickets', async () => {
      guestsServiceMock.findAll.mockResolvedValue([
        { id: 'g1', name: 'A', rsvpStatus: 'ACCEPTED', tickets: 2 },
        { id: 'g2', name: 'B', rsvpStatus: 'PENDING', tickets: 1 },
        { id: 'g3', name: 'C', rsvpStatus: 'DECLINED', tickets: 1 },
      ]);

      await service.handleIncoming(buildPayload('m-resumen', PHONE, 'resumen'));

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toEqual(expect.any(String));
    });
  });

  describe('guest detail (single search match) — RSVP confirm/reject buttons', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    it('a search that matches exactly one guest SENDS interactive BUTTONS ("confirmar:{id}"/"rechazar:{id}") instead of text', async () => {
      guestsServiceMock.findAllPaginated.mockResolvedValue({
        data: [{ id: 'guest-uuid-9', name: 'Juan Perez', rsvpStatus: 'PENDING' }],
        total: 1,
      });

      await service.handleIncoming(buildPayload('m-buscar-detail', PHONE, 'buscar Juan Perez'));

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: 'confirmar:guest-uuid-9' }),
          expect.objectContaining({ id: 'rechazar:guest-uuid-9' }),
        ]),
      );
      expect(whatsappClientMock.sendText).not.toHaveBeenCalled();
    });

    it('ROUND-TRIP: the exact "confirmar:{id}" button id sent for a single search match is recognized back as RSVP_CONFIRM', async () => {
      guestsServiceMock.findAllPaginated.mockResolvedValue({
        data: [{ id: 'guest-uuid-9', name: 'Juan Perez', rsvpStatus: 'PENDING' }],
        total: 1,
      });

      await service.handleIncoming(buildPayload('m-buscar-detail-rt', PHONE, 'buscar Juan Perez'));

      const [, , buttons] = whatsappClientMock.sendInteractiveButtons.mock.calls[0];
      const confirmButtonId: string = buttons.find(
        (b: { id: string }) => b.id.startsWith('confirmar:'),
      ).id;

      await service.handleIncoming(
        buildInteractivePayload('m-buscar-detail-confirm', PHONE, confirmButtonId, 'button_reply'),
      );

      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, 'guest-uuid-9', {
        rsvpStatus: 'ACCEPTED',
      });
    });

    it('a search matching multiple guests keeps the plain text list (no buttons — WhatsApp buttons are capped at 3)', async () => {
      guestsServiceMock.findAllPaginated.mockResolvedValue({
        data: [
          { id: 'g1', name: 'Juan Perez', rsvpStatus: 'PENDING' },
          { id: 'g2', name: 'Juan Gomez', rsvpStatus: 'ACCEPTED' },
        ],
        total: 2,
      });

      await service.handleIncoming(buildPayload('m-buscar-multi', PHONE, 'buscar Juan'));

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
    });
  });

  describe('write flow — agregar invitado (CONFIRM gate)', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    it('"agregar" with an active event starts the flow (pendingAction persisted) without calling GuestsService.create', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID, currentEventId: EVENT_ID });

      await service.handleIncoming(buildPayload('m-agregar', PHONE, 'agregar'));

      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({
          pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} },
        }),
      );
      expect(guestsServiceMock.create).not.toHaveBeenCalled();
    });

    it('CRITICAL — reaching the CONFIRM step without tapping confirm does NOT call GuestsService.create', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2 },
        },
      });

      await service.handleIncoming(buildPayload('m-agregar-noconfirm', PHONE, 'si, dale'));

      expect(guestsServiceMock.create).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
    });

    it('CRITICAL — tapping "confirm" BEFORE reaching the CONFIRM step does NOT call GuestsService.create', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_PHONE', data: { name: 'Juan Perez' } },
      });

      await service.handleIncoming(buildInteractivePayload('m-agregar-early-confirm', PHONE, 'confirm'));

      expect(guestsServiceMock.create).not.toHaveBeenCalled();
    });

    it('reaching AWAITING_CONFIRM (last step answered) SENDS interactive BUTTONS whose confirm id the parser resolves to CONFIRM_ACTION', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'ASK_EMAIL',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2 },
        },
      });

      await service.handleIncoming(buildPayload('m-agregar-awaiting-confirm', PHONE, 'skip'));

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ id: 'confirm' })]),
      );
      expect(whatsappClientMock.sendText).not.toHaveBeenCalled();
      expect(guestsServiceMock.create).not.toHaveBeenCalled();

      // The exact id sent above must be recognized back as CONFIRM_ACTION by
      // the parser — otherwise the button the bot just sent would be
      // untappable in production.
      const [, , buttons] = whatsappClientMock.sendInteractiveButtons.mock.calls[0];
      const confirmButton = buttons.find((b: { id: string }) => b.id === 'confirm');
      expect(confirmButton).toBeDefined();
    });

    it('tapping "confirm" AT the CONFIRM step calls GuestsService.create with the collected data and clears pendingAction', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2, email: 'juan@example.com' },
        },
      });

      await service.handleIncoming(buildInteractivePayload('m-agregar-confirm', PHONE, 'confirm'));

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(guestsServiceMock.create).toHaveBeenCalledWith(EVENT_ID, {
        name: 'Juan Perez',
        phone: '+5491122334455',
        tickets: 2,
        email: 'juan@example.com',
      });
      expect(conversationStoreMock.clear).toHaveBeenCalledWith(PHONE);
    });

    it('F3 — when GuestsService.create rejects, the flow is cleared and an error text is sent (no throw, no stuck CONFIRM)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2, email: 'juan@example.com' },
        },
      });
      guestsServiceMock.create.mockRejectedValue(new Error('db unavailable'));

      await expect(
        service.handleIncoming(buildInteractivePayload('m-agregar-fail', PHONE, 'confirm')),
      ).resolves.toBeUndefined();

      expect(guestsServiceMock.create).toHaveBeenCalled();
      expect(conversationStoreMock.clear).toHaveBeenCalledWith(PHONE);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No pude guardar'),
      );
    });

    it('FIX C — when the write SUCCEEDS but clearing the conversation throws, the user still gets the SUCCESS reply (no false failure -> no duplicate retry)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2, email: 'juan@example.com' },
        },
      });
      guestsServiceMock.create.mockResolvedValue({ id: 'guest-new' });
      // The write already committed — a clear() failure must NOT be reported as
      // a write failure, or the user would retry and duplicate the guest.
      conversationStoreMock.clear.mockRejectedValue(new Error('redis down'));

      await expect(
        service.handleIncoming(buildInteractivePayload('m-agregar-clearfail', PHONE, 'confirm')),
      ).resolves.toBeUndefined();

      expect(guestsServiceMock.create).toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        'Invitado agregado correctamente.',
      );
      expect(whatsappClientMock.sendText).not.toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No pude guardar'),
      );
    });
  });

  describe('write flow — editar invitado (CONFIRM gate)', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    it('reaching AWAITING_CONFIRM (valid value answered) SENDS interactive BUTTONS whose confirm id the parser resolves to CONFIRM_ACTION', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'EDITAR',
          step: 'ASK_VALUE',
          guestId: 'guest-uuid-9',
          field: 'phone',
        },
      });

      await service.handleIncoming(buildPayload('m-editar-awaiting-confirm', PHONE, '+5491199998888'));

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ id: 'confirm' })]),
      );
      expect(guestsServiceMock.update).not.toHaveBeenCalled();
    });

    it('tapping "confirm" AT the CONFIRM step calls GuestsService.update with only the changed field and clears pendingAction', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'EDITAR',
          step: 'CONFIRM',
          guestId: 'guest-uuid-9',
          field: 'phone',
          value: '+5491199998888',
        },
      });

      await service.handleIncoming(buildInteractivePayload('m-editar-confirm', PHONE, 'confirm'));

      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, 'guest-uuid-9', {
        phone: '+5491199998888',
      });
      expect(conversationStoreMock.clear).toHaveBeenCalledWith(PHONE);
    });

    it('reaching the CONFIRM step without tapping confirm does NOT call GuestsService.update', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'EDITAR',
          step: 'CONFIRM',
          guestId: 'guest-uuid-9',
          field: 'phone',
          value: '+5491199998888',
        },
      });

      await service.handleIncoming(buildPayload('m-editar-noconfirm', PHONE, 'listo'));

      expect(guestsServiceMock.update).not.toHaveBeenCalled();
    });
  });

  describe('RSVP confirm/reject buttons', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID, currentEventId: EVENT_ID });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    // NOTE ("never InvitaeService.confirmAttendance"): WhatsappService's
    // constructor never injects InvitaeService (see whatsapp.module.ts —
    // only UserEventsModule/GuestsModule are imported), so it is
    // structurally impossible for this dispatch path to reach
    // InvitaeService.confirmAttendance. The public confirmation flow lives
    // entirely in a separate, unrelated module.
    it('"confirmar:{guestId}" button calls GuestsService.update with rsvpStatus ACCEPTED', async () => {
      await service.handleIncoming(
        buildInteractivePayload('m-rsvp-confirm', PHONE, 'confirmar:guest-uuid-9'),
      );

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, 'guest-uuid-9', {
        rsvpStatus: 'ACCEPTED',
      });
    });

    it('"rechazar:{guestId}" button calls GuestsService.update with rsvpStatus DECLINED', async () => {
      await service.handleIncoming(
        buildInteractivePayload('m-rsvp-decline', PHONE, 'rechazar:guest-uuid-9'),
      );

      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, 'guest-uuid-9', {
        rsvpStatus: 'DECLINED',
      });
    });

    it('CRITICAL — a non-member tapping confirmar is denied and GuestsService.update is NEVER called', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: 'attacker-uuid',
        currentEventId: EVENT_ID,
      });
      userEventsServiceMock.findOne.mockRejectedValue(
        new NotFoundException(`Event ${EVENT_ID} not found`),
      );

      await service.handleIncoming(
        buildInteractivePayload('m-rsvp-confirm-denied', PHONE, 'confirmar:guest-uuid-9'),
      );

      expect(guestsServiceMock.update).not.toHaveBeenCalled();
    });
  });
});
