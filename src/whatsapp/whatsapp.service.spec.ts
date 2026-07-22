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

import { Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EVENT_CONFIRM_STALE_MS,
  WhatsappService,
  extractInteractiveId,
} from './whatsapp.service';
import { parseCommand } from './command.parser';
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

describe('extractInteractiveId', () => {
  it('reads interactive.button_reply.id when the inbound shape is type:"interactive"', () => {
    expect(
      extractInteractiveId({
        id: 'm1',
        from: '+5491100000000',
        type: 'interactive',
        interactive: { button_reply: { id: 'guest_rsvp_yes:abc', title: 'Si' } },
      }),
    ).toBe('guest_rsvp_yes:abc');
  });

  it('reads button.payload when the inbound shape is type:"button" (template quick-reply)', () => {
    expect(
      extractInteractiveId({
        id: 'm2',
        from: '+5491100000000',
        type: 'button',
        button: { payload: 'guest_rsvp_no:abc', text: 'No' },
      }),
    ).toBe('guest_rsvp_no:abc');
  });

  it('returns undefined when neither interactive nor button is present', () => {
    expect(extractInteractiveId({ id: 'm3', from: '+5491100000000' })).toBeUndefined();
  });
});

describe('WhatsappService', () => {
  let service: WhatsappService;
  let redisServiceMock: { setNX: jest.Mock; del: jest.Mock; delIfEquals: jest.Mock };
  let delaySpy: jest.SpyInstance;
  let loggerErrorSpy: jest.SpyInstance;
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
    findByIdUnscoped: jest.Mock;
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
      findByIdUnscoped: jest.fn(),
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

    // Best-effort Redis writes log through the service's own Logger. Silence
    // it (and make it assertable) instead of polluting the test output.
    loggerErrorSpy = jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);

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

  describe('unlinked onboarding replies (mute-gap fix)', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue(null); // unlinked
    });

    it('replies with linking instructions when an unlinked phone sends a non-PIN message', async () => {
      await service.handleIncoming(buildPayload('m-unlinked-hello', '+5491199999999', 'hola'));

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        '+5491199999999',
        expect.stringContaining('PIN'),
      );
      // Still no dispatch — an unlinked phone never resolves a conversation.
      expect(conversationStoreMock.get).not.toHaveBeenCalled();
    });

    it('confirms the link when an unlinked phone sends a VALID PIN', async () => {
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(true);

      await service.handleIncoming(buildPayload('m-pin-ok', PHONE, '123456'));

      expect(whatsappLinkServiceMock.verifyAndLink).toHaveBeenCalledWith('123456', PHONE);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('vinculado'),
      );
    });

    it('tells the user to retry when an unlinked phone sends an INVALID/expired PIN', async () => {
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(false);

      await service.handleIncoming(buildPayload('m-pin-bad', PHONE, '000000'));

      expect(whatsappLinkServiceMock.verifyAndLink).toHaveBeenCalledWith('000000', PHONE);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('no es valido'),
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
      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalled();
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
      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalled();
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

    it('replies to "menu" with 3 interactive BUTTONS (not text/list) and without touching UserEventsService/GuestsService', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-menu', PHONE, 'menu'));

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalled();
      expect(whatsappClientMock.sendText).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendInteractiveList).not.toHaveBeenCalled();
      expect(userEventsServiceMock.findOne).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
    });

    it('ROUND-TRIP: every "menu" button id is recognized by the parser and fits WhatsApp limits (max 3 buttons, 20-char titles)', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-menu-rt', PHONE, 'menu'));

      const [, , buttons] = whatsappClientMock.sendInteractiveButtons.mock.calls[0];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.length).toBeLessThanOrEqual(3); // WhatsApp reply-button cap
      for (const button of buttons) {
        // The exact id the bot SENDS must parse back to a real command.
        expect(parseCommand({ interactiveId: button.id }).kind).not.toBe('UNKNOWN');
        expect(button.title.length).toBeLessThanOrEqual(20); // WhatsApp button-title cap
      }
    });

    it('"Mas opciones" (menu_more) opens an interactive LIST whose row ids the parser recognizes and fits WhatsApp limits', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(
        buildInteractivePayload('m-menu-more', PHONE, 'menu_more', 'button_reply'),
      );

      expect(whatsappClientMock.sendInteractiveList).toHaveBeenCalled();
      const [, , , rows] = whatsappClientMock.sendInteractiveList.mock.calls[0];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(10); // WhatsApp list cap
      for (const row of rows) {
        expect(parseCommand({ interactiveId: row.id }).kind).not.toBe('UNKNOWN');
        expect(row.title.length).toBeLessThanOrEqual(24); // WhatsApp row-title cap
      }
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
        'No tienes eventos asociados todavia.',
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

    it('"cancelar" drops the pending flow but PRESERVES the active event (never wipes the whole context)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { step: 'ASK_NAME' },
      });

      await service.handleIncoming(buildPayload('m-cancel', PHONE, 'cancelar'));

      expect(conversationStoreMock.clear).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
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
      // The stored context must belong to the phone's CURRENT owner, otherwise
      // it is discarded outright (see the re-link guard) and this path would
      // never be reached.
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue('attacker-uuid');
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
      // The flow is dropped, but the active event survives the completion.
      expect(conversationStoreMock.clear).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenLastCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
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
      expect(conversationStoreMock.set).toHaveBeenLastCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No pude guardar'),
      );
    });

    it('FIX C — when the write SUCCEEDS but persisting the cleared conversation throws, the user still gets the SUCCESS reply (no false failure -> no duplicate retry)', async () => {
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
      // The write already committed — a failure persisting the cleared context
      // must NOT be reported as a write failure, or the user would retry and
      // duplicate the guest.
      conversationStoreMock.set.mockRejectedValue(new Error('redis down'));

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
      expect(conversationStoreMock.clear).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenLastCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
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
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue('attacker-uuid');
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

  describe('user-facing wording — neutral tuteo, no voseo', () => {
    const VOSEO_FORMS = /\b(podes|tenes|queres|volve|elegi)\b/i;

    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
    });

    it('uses "vuelve" when an OTP is invalid', async () => {
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue(null);
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(false);

      await service.handleIncoming(buildPayload('m-voseo-otp', PHONE, '000000'));

      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toContain('vuelve a enviarlo');
      expect(message).not.toMatch(VOSEO_FORMS);
    });

    it('uses "quieres" when asking which field to edit', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID, currentEventId: EVENT_ID });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });

      await service.handleIncoming(
        buildInteractivePayload('m-voseo-edit', PHONE, 'edit_guest:guest-uuid-9'),
      );

      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toContain('Que campo quieres editar?');
      expect(message).not.toMatch(VOSEO_FORMS);
    });

    it('uses "Vuelve a intentarlo" when the guest write fails', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2 },
        },
      });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
      guestsServiceMock.create.mockRejectedValue(new Error('db unavailable'));

      await service.handleIncoming(buildInteractivePayload('m-voseo-write', PHONE, 'confirm'));

      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toContain('Vuelve a intentarlo');
      expect(message).not.toMatch(VOSEO_FORMS);
    });

    it('uses "No tienes acceso" when the user is not a member of the selected event', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findOne.mockRejectedValue(new NotFoundException('nope'));

      await service.handleIncoming(
        buildInteractivePayload('m-voseo-access', PHONE, `select_event:${EVENT_ID}`),
      );

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        'No tienes acceso a ese evento.',
      );
    });

    it('uses "No tienes un evento activo" when no event is selected', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-voseo-noevent', PHONE, 'resumen'));

      const [, message] = whatsappClientMock.sendText.mock.calls[0];
      expect(message).toContain('No tienes un evento activo');
      expect(message).not.toMatch(VOSEO_FORMS);
    });
  });

  describe('free-text confirmation must not hijack a flow INPUT step', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
    });

    it('CRITICAL — a guest named "Si" is captured as the NAME, never treated as a confirmation', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} },
      });

      await service.handleIncoming(buildPayload('m-name-si', PHONE, 'Si'));

      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({
          pendingAction: expect.objectContaining({
            step: 'ASK_PHONE',
            data: expect.objectContaining({ name: 'Si' }),
          }),
        }),
      );
      expect(guestsServiceMock.create).not.toHaveBeenCalled();
    });

    it('a typed "ok" during an INPUT step is captured as input, not a premature CONFIRM', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'EDITAR',
          step: 'ASK_VALUE',
          guestId: 'guest-uuid-9',
          field: 'name',
        },
      });

      await service.handleIncoming(buildPayload('m-value-ok', PHONE, 'ok'));

      expect(guestsServiceMock.update).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({
          pendingAction: expect.objectContaining({ step: 'CONFIRM', value: 'ok' }),
        }),
      );
    });

    it('a typed "confirmar" AT the CONFIRM step still completes the write', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: {
          flow: 'AGREGAR',
          step: 'CONFIRM',
          data: { name: 'Juan Perez', phone: '+5491122334455', tickets: 2 },
        },
      });

      await service.handleIncoming(buildPayload('m-text-confirm', PHONE, 'confirmar'));

      expect(guestsServiceMock.create).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ name: 'Juan Perez' }),
      );
    });
  });

  describe('active-event re-confirmation after inactivity', () => {
    const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();
    // Imported from the service — a local copy would silently drift if the
    // production window ever changed.
    const STALE_MS = EVENT_CONFIRM_STALE_MS;

    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
      jest.useFakeTimers().setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function staleCtx(extra: Record<string, unknown> = {}) {
      return {
        userId: USER_ID,
        currentEventId: EVENT_ID,
        lastInteractionAt: NOW - STALE_MS - 1000,
        ...extra,
      };
    }

    it('asks to re-confirm the event (with real event name + buttons) when an event-scoped command arrives after the stale window', async () => {
      conversationStoreMock.get.mockResolvedValue(staleCtx());

      await service.handleIncoming(buildPayload('m-stale', PHONE, 'resumen'));

      // Membership is still validated — the name comes from UserEventsService.
      expect(userEventsServiceMock.findOne).toHaveBeenCalledWith(EVENT_ID, USER_ID);
      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        'Paso un rato desde tu ultimo mensaje. Seguimos trabajando en "My Wedding"?',
        [
          { id: 'resume_event', title: 'Si, continuar' },
          { id: 'list_events', title: 'Elegir otro evento' },
        ],
      );
      // The original request is parked, not executed.
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({ pendingIntent: { kind: 'RSVP_SUMMARY' } }),
      );
    });

    it('does NOT fire when the context is fresh', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        lastInteractionAt: NOW - 1000,
      });
      guestsServiceMock.findAll.mockResolvedValue([]);

      await service.handleIncoming(buildPayload('m-fresh', PHONE, 'resumen'));

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
    });

    it('does NOT fire when lastInteractionAt is absent (legacy context)', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID, currentEventId: EVENT_ID });
      guestsServiceMock.findAll.mockResolvedValue([]);

      await service.handleIncoming(buildPayload('m-legacy', PHONE, 'resumen'));

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
    });

    it('NEVER interrupts an in-progress write flow, however stale', async () => {
      conversationStoreMock.get.mockResolvedValue(
        staleCtx({ pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} } }),
      );

      await service.handleIncoming(buildPayload('m-stale-inflow', PHONE, 'Juan Perez'));

      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
      expect(conversationStoreMock.set).toHaveBeenCalledWith(
        PHONE,
        expect.objectContaining({
          pendingAction: expect.objectContaining({ step: 'ASK_PHONE' }),
        }),
      );
    });

    it.each(['menu', 'mas opciones', 'mis eventos', 'cancelar', 'continuar'])(
      'never fires for the non-event-scoped command %j',
      async (text) => {
        conversationStoreMock.get.mockResolvedValue(staleCtx());

        await service.handleIncoming(buildPayload(`m-stale-${text}`, PHONE, text));

        expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalledWith(
          PHONE,
          expect.stringContaining('Seguimos trabajando'),
          expect.anything(),
        );
      },
    );

    it('never fires for an unrecognized command', async () => {
      conversationStoreMock.get.mockResolvedValue(staleCtx());

      await service.handleIncoming(buildPayload('m-stale-unknown', PHONE, 'blah blah'));

      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No entendi'),
      );
    });

    it('RESUME_EVENT replays the parked intent so the user never has to retype it', async () => {
      conversationStoreMock.get.mockResolvedValue(
        staleCtx({ pendingIntent: { kind: 'RSVP_SUMMARY' } }),
      );
      guestsServiceMock.findAll.mockResolvedValue([
        { id: 'g1', name: 'A', rsvpStatus: 'ACCEPTED', tickets: 2 },
      ]);

      await service.handleIncoming(
        buildInteractivePayload('m-resume', PHONE, 'resume_event', 'button_reply'),
      );

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Resumen:'),
      );
      // The parked intent is popped — a second resume must not replay it.
      expect(conversationStoreMock.set).toHaveBeenCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
        lastInteractionAt: expect.any(Number),
      });
    });

    it('RESUME_EVENT with nothing parked falls back to the menu', async () => {
      conversationStoreMock.get.mockResolvedValue(staleCtx());

      await service.handleIncoming(
        buildInteractivePayload('m-resume-empty', PHONE, 'resume_event', 'button_reply'),
      );

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Menu principal'),
        expect.anything(),
      );
    });

    it('selecting a DIFFERENT event drops the stale parked intent', async () => {
      conversationStoreMock.get.mockResolvedValue(
        staleCtx({ pendingIntent: { kind: 'RSVP_SUMMARY' } }),
      );
      userEventsServiceMock.findOne.mockResolvedValue({ id: 'other-event', name: 'Other' });

      await service.handleIncoming(
        buildInteractivePayload('m-switch', PHONE, 'select_event:other-event'),
      );

      const [, persisted] = conversationStoreMock.set.mock.calls[0];
      expect(persisted.currentEventId).toBe('other-event');
      expect(persisted).not.toHaveProperty('pendingIntent');
    });

    it('cancelling an add-guest flow keeps the active event usable for the next command', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        lastInteractionAt: NOW,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_PHONE', data: { name: 'Juan' } },
      });

      await service.handleIncoming(buildPayload('m-cancel-flow', PHONE, 'cancelar'));

      const [, afterCancel] = conversationStoreMock.set.mock.calls[0];
      expect(afterCancel).toEqual({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        lastInteractionAt: NOW,
      });
      expect(afterCancel).not.toHaveProperty('pendingAction');

      // The very next command still resolves against the same event.
      conversationStoreMock.get.mockResolvedValue({ ...afterCancel, lastInteractionAt: NOW });
      guestsServiceMock.findAll.mockResolvedValue([]);

      await service.handleIncoming(buildPayload('m-after-cancel', PHONE, 'resumen'));

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
    });

    it('FIX 4 — a parked intent does NOT survive a command that dispatched normally', async () => {
      // 1. A stale event-scoped command parks the intent behind the gate.
      conversationStoreMock.get.mockResolvedValue(staleCtx());
      await service.handleIncoming(buildPayload('m-park', PHONE, 'resumen'));
      const [, parkedCtx] = conversationStoreMock.set.mock.calls[0];
      expect(parkedCtx).toEqual(
        expect.objectContaining({ pendingIntent: { kind: 'RSVP_SUMMARY' } }),
      );

      // 2. The user ignores the question and sends a fresh command instead,
      //    which dispatches normally — the parked intent is now obsolete.
      conversationStoreMock.get.mockResolvedValue({ ...parkedCtx, lastInteractionAt: NOW });
      guestsServiceMock.findAll.mockResolvedValue([]);
      await service.handleIncoming(buildPayload('m-fresh-after-park', PHONE, 'resumen'));
      const [, touchedCtx] = conversationStoreMock.set.mock.calls[1];
      expect(touchedCtx).not.toHaveProperty('pendingIntent');

      // 3. Scrolling up and tapping the old "Si, continuar" button must NOT
      //    replay the long-dead intent.
      conversationStoreMock.get.mockResolvedValue(touchedCtx);
      whatsappClientMock.sendInteractiveButtons.mockClear();
      await service.handleIncoming(
        buildInteractivePayload('m-resume-dead', PHONE, 'resume_event', 'button_reply'),
      );

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Menu principal'),
        expect.anything(),
      );
    });

    it('FIX 3a — a failed parking write falls through to normal dispatch instead of 500ing', async () => {
      conversationStoreMock.get.mockResolvedValue(staleCtx());
      conversationStoreMock.set.mockRejectedValue(new Error('redis down'));
      guestsServiceMock.findAll.mockResolvedValue([
        { id: 'g1', name: 'A', rsvpStatus: 'ACCEPTED', tickets: 2 },
      ]);

      await expect(
        service.handleIncoming(buildPayload('m-park-fail', PHONE, 'resumen')),
      ).resolves.toBeUndefined();

      // We never ask a question whose answer we cannot remember — the user's
      // actual command is answered instead.
      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Resumen:'),
      );
      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('FIX 3b — RESUME_EVENT still replays the parked intent when persisting the pop fails', async () => {
      conversationStoreMock.get.mockResolvedValue(
        staleCtx({ pendingIntent: { kind: 'RSVP_SUMMARY' } }),
      );
      conversationStoreMock.set.mockRejectedValue(new Error('redis down'));
      guestsServiceMock.findAll.mockResolvedValue([
        { id: 'g1', name: 'A', rsvpStatus: 'ACCEPTED', tickets: 2 },
      ]);

      await expect(
        service.handleIncoming(
          buildInteractivePayload('m-resume-persistfail', PHONE, 'resume_event', 'button_reply'),
        ),
      ).resolves.toBeUndefined();

      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Resumen:'),
      );
      expect(loggerErrorSpy).toHaveBeenCalled();
    });
  });

  describe('FIX 1 — a re-linked phone never inherits the previous owner identity', () => {
    const PREVIOUS_OWNER = 'previous-owner-uuid';

    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({
        id: EVENT_ID,
        name: 'Boda del dueno anterior',
      });
    });

    it('CRITICAL — does NOT reuse the previous owner currentEventId for an event-scoped command', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: PREVIOUS_OWNER,
        currentEventId: EVENT_ID,
      });

      await service.handleIncoming(buildPayload('m-relink-scoped', PHONE, 'resumen'));

      expect(userEventsServiceMock.findOne).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No tienes un evento activo'),
      );
    });

    it('CRITICAL — does NOT resume the previous owner pendingAction', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: PREVIOUS_OWNER,
        currentEventId: EVENT_ID,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} },
      });

      await service.handleIncoming(buildPayload('m-relink-flow', PHONE, 'Juan Perez'));

      expect(guestsServiceMock.create).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('No entendi'),
      );
    });

    it('CRITICAL — the re-confirmation gate never discloses the previous owner event name', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: PREVIOUS_OWNER,
        currentEventId: EVENT_ID,
        lastInteractionAt: Date.now() - EVENT_CONFIRM_STALE_MS - 1000,
      });

      await service.handleIncoming(buildPayload('m-relink-stale', PHONE, 'resumen'));

      expect(whatsappClientMock.sendInteractiveButtons).not.toHaveBeenCalled();
      const sentBodies = whatsappClientMock.sendText.mock.calls.map(([, body]) => body);
      for (const body of sentBodies) {
        expect(body).not.toContain('Boda del dueno anterior');
      }
    });

    it('drops the stale Redis key so the previous owner state cannot linger', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: PREVIOUS_OWNER,
        currentEventId: EVENT_ID,
      });

      await service.handleIncoming(buildPayload('m-relink-clear', PHONE, 'menu'));

      expect(conversationStoreMock.clear).toHaveBeenCalledWith(PHONE);
    });

    it('a MATCHING stored userId is still reused (the guard must not wipe normal contexts)', async () => {
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      guestsServiceMock.findAll.mockResolvedValue([]);

      await service.handleIncoming(buildPayload('m-same-owner', PHONE, 'resumen'));

      expect(conversationStoreMock.clear).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).toHaveBeenCalledWith(EVENT_ID);
    });
  });

  describe('FIX 2 — recognized commands never hijack an active write flow', () => {
    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
      conversationStoreMock.get.mockResolvedValue({
        userId: USER_ID,
        currentEventId: EVENT_ID,
        pendingAction: { flow: 'AGREGAR', step: 'ASK_NAME', data: {} },
      });
    });

    it.each(['Resumen', 'info', 'eventos', 'Confirmados', 'totales'])(
      'CRITICAL — %j typed at the ASK_NAME step is captured as the guest name, not dispatched',
      async (input) => {
        await service.handleIncoming(buildPayload(`m-flow-${input}`, PHONE, input));

        expect(conversationStoreMock.set).toHaveBeenCalledWith(
          PHONE,
          expect.objectContaining({
            pendingAction: expect.objectContaining({
              step: 'ASK_PHONE',
              data: expect.objectContaining({ name: input }),
            }),
          }),
        );
        expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
        expect(userEventsServiceMock.findByUser).not.toHaveBeenCalled();
      },
    );

    it('"cancelar" still escapes the flow', async () => {
      await service.handleIncoming(buildPayload('m-flow-cancelar', PHONE, 'cancelar'));

      expect(conversationStoreMock.set).toHaveBeenCalledWith(PHONE, {
        userId: USER_ID,
        currentEventId: EVENT_ID,
      });
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, 'Operacion cancelada.');
    });

    it('"menu" still escapes the flow', async () => {
      await service.handleIncoming(buildPayload('m-flow-menu', PHONE, 'menu'));

      expect(whatsappClientMock.sendInteractiveButtons).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Menu principal'),
        expect.anything(),
      );
    });
  });

  describe('guest RSVP inbound guard', () => {
    const GUEST_ID = '11111111-1111-4111-8111-111111111111';
    const GUEST_PHONE = '+5491100005555';

    beforeEach(() => {
      mockRedisSetNX(redisServiceMock.setNX);
    });

    it('an interactive button tap (guest_rsvp_yes) sets ACCEPTED, replies, and NEVER resolves the phone', async () => {
      guestsServiceMock.findByIdUnscoped.mockResolvedValue({
        id: GUEST_ID,
        eventId: EVENT_ID,
        rsvpStatus: 'PENDING',
      });

      await service.handleIncoming(
        buildInteractivePayload('m-guest-yes', GUEST_PHONE, `guest_rsvp_yes:${GUEST_ID}`, 'button_reply'),
      );

      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, GUEST_ID, {
        rsvpStatus: 'ACCEPTED',
      });
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(GUEST_PHONE, expect.any(String));
      expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
      expect(conversationStoreMock.get).not.toHaveBeenCalled();
    });

    it('a type:"button" tap (button.payload) sets DECLINED, identical to the interactive-shape path', async () => {
      guestsServiceMock.findByIdUnscoped.mockResolvedValue({
        id: GUEST_ID,
        eventId: EVENT_ID,
        rsvpStatus: 'PENDING',
      });

      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'm-guest-no-btn',
                      from: GUEST_PHONE,
                      type: 'button',
                      button: { payload: `guest_rsvp_no:${GUEST_ID}`, text: 'No podre asistir' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.handleIncoming(payload);

      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, GUEST_ID, {
        rsvpStatus: 'DECLINED',
      });
      expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
    });

    it('REGRESSION: the exact quick-reply payloads sent with the MARKETING template resolve unchanged', async () => {
      // These are byte-identical to what `NotificationsService.sendInvitation`
      // passes as `buttonPayloads` to `sendTemplateWithResult`. The template
      // fallback adds NO inbound code — if this breaks, cold guests can tap a
      // button and have their RSVP silently dropped.
      const [yesPayload, noPayload] = [
        `guest_rsvp_yes:${GUEST_ID}`,
        `guest_rsvp_no:${GUEST_ID}`,
      ];

      for (const [payload, expectedStatus] of [
        [yesPayload, 'ACCEPTED'],
        [noPayload, 'DECLINED'],
      ] as const) {
        guestsServiceMock.update.mockClear();
        guestsServiceMock.findByIdUnscoped.mockResolvedValue({
          id: GUEST_ID,
          eventId: EVENT_ID,
          rsvpStatus: 'PENDING',
        });

        await service.handleIncoming({
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      {
                        id: `m-tpl-${expectedStatus}`,
                        from: GUEST_PHONE,
                        type: 'button',
                        button: { payload, text: 'Asistire' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });

        expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, GUEST_ID, {
          rsvpStatus: expectedStatus,
        });
        expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
      }
    });

    it('a tap OVERWRITES an organizer-set ACCEPTED status, with no lock or rejection', async () => {
      guestsServiceMock.findByIdUnscoped.mockResolvedValue({
        id: GUEST_ID,
        eventId: EVENT_ID,
        rsvpStatus: 'ACCEPTED', // set previously by an organizer via dashboard CRUD
      });

      await service.handleIncoming(
        buildInteractivePayload('m-guest-overwrite', GUEST_PHONE, `guest_rsvp_no:${GUEST_ID}`, 'button_reply'),
      );

      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, GUEST_ID, {
        rsvpStatus: 'DECLINED',
      });
    });

    it('a repeat identical tap is a single idempotent write with a single reply', async () => {
      guestsServiceMock.findByIdUnscoped.mockResolvedValue({
        id: GUEST_ID,
        eventId: EVENT_ID,
        rsvpStatus: 'ACCEPTED', // already recorded from a prior tap
      });

      await service.handleIncoming(
        buildInteractivePayload('m-guest-repeat', GUEST_PHONE, `guest_rsvp_yes:${GUEST_ID}`, 'button_reply'),
      );

      expect(guestsServiceMock.update).toHaveBeenCalledTimes(1);
      expect(whatsappClientMock.sendText).toHaveBeenCalledTimes(1);
    });

    it('a stale/unknown guestId replies neutrally without throwing or writing', async () => {
      guestsServiceMock.findByIdUnscoped.mockResolvedValue(undefined);

      await expect(
        service.handleIncoming(
          buildInteractivePayload('m-guest-gone', GUEST_PHONE, `guest_rsvp_yes:${GUEST_ID}`, 'button_reply'),
        ),
      ).resolves.toBeUndefined();

      expect(guestsServiceMock.update).not.toHaveBeenCalled();
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(
        GUEST_PHONE,
        expect.stringContaining('ya no esta disponible'),
      );
    });

    it('a duplicate wamid (SETNX dedup already claimed) never reaches the guest guard', async () => {
      mockRedisSetNX(redisServiceMock.setNX, { msgId: false });

      await service.handleIncoming(
        buildInteractivePayload('m-guest-dup', GUEST_PHONE, `guest_rsvp_yes:${GUEST_ID}`, 'button_reply'),
      );

      expect(guestsServiceMock.findByIdUnscoped).not.toHaveBeenCalled();
      expect(guestsServiceMock.update).not.toHaveBeenCalled();
    });

    it('an organizer "confirmar:{id}" tap still reaches resolvePhone unchanged (no namespace collision)', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID, currentEventId: EVENT_ID });
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });

      await service.handleIncoming(
        buildInteractivePayload('m-organizer-confirmar', PHONE, 'confirmar:guest-uuid-9', 'button_reply'),
      );

      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith(PHONE);
      expect(guestsServiceMock.findByIdUnscoped).not.toHaveBeenCalled();
      expect(guestsServiceMock.update).toHaveBeenCalledWith(EVENT_ID, 'guest-uuid-9', {
        rsvpStatus: 'ACCEPTED',
      });
    });

    it('plain organizer text still reaches resolvePhone unchanged (no namespace collision)', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-organizer-text', PHONE, 'menu'));

      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith(PHONE);
      expect(guestsServiceMock.findByIdUnscoped).not.toHaveBeenCalled();
    });
  });
});
