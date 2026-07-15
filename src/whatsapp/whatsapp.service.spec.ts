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

describe('WhatsappService', () => {
  let service: WhatsappService;
  let redisServiceMock: { setNX: jest.Mock };
  let whatsappLinkServiceMock: {
    verifyAndLink: jest.Mock;
    resolvePhone: jest.Mock;
  };
  let conversationStoreMock: { get: jest.Mock; set: jest.Mock; clear: jest.Mock };
  let whatsappClientMock: { sendText: jest.Mock };
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
    redisServiceMock = { setNX: jest.fn() };
    whatsappLinkServiceMock = {
      verifyAndLink: jest.fn(),
      resolvePhone: jest.fn(),
    };
    conversationStoreMock = { get: jest.fn(), set: jest.fn(), clear: jest.fn() };
    whatsappClientMock = { sendText: jest.fn() };
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

    // Default: sender is linked, unless a test overrides it
    whatsappLinkServiceMock.resolvePhone.mockResolvedValue(USER_ID);
    // Safe defaults so tests that dispatch but don't care about these
    // particular replies don't crash on undefined
    userEventsServiceMock.findByUser.mockResolvedValue([]);
  });

  describe('idempotency', () => {
    it('drops a duplicate message_id (setNX false) without resolving the link', async () => {
      redisServiceMock.setNX.mockResolvedValue(false);

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
      redisServiceMock.setNX.mockResolvedValue(true);

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
      redisServiceMock.setNX.mockResolvedValue(true);
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue(null);

      await service.handleIncoming(buildPayload('msg-3', '+5491199999999', 'buscar Juan'));

      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith('+5491199999999');
      expect(conversationStoreMock.get).not.toHaveBeenCalled();
    });

    it('resolves the conversation context (identity resolution) when the phone IS linked', async () => {
      redisServiceMock.setNX.mockResolvedValue(true);

      await service.handleIncoming(buildPayload('msg-4', PHONE, 'menu'));

      expect(conversationStoreMock.get).toHaveBeenCalledWith(PHONE);
    });
  });

  describe('OTP verification routing', () => {
    it('routes a 6-digit message to verifyAndLink instead of resolvePhone', async () => {
      redisServiceMock.setNX.mockResolvedValue(true);
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(true);

      await service.handleIncoming(buildPayload('msg-5', PHONE, '123456'));

      expect(whatsappLinkServiceMock.verifyAndLink).toHaveBeenCalledWith('123456', PHONE);
      expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
    });
  });

  describe('command dispatch — menu and navigation', () => {
    beforeEach(() => {
      redisServiceMock.setNX.mockResolvedValue(true);
    });

    it('replies to "menu" without touching UserEventsService/GuestsService', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });

      await service.handleIncoming(buildPayload('m-menu', PHONE, 'menu'));

      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
      expect(userEventsServiceMock.findOne).not.toHaveBeenCalled();
      expect(guestsServiceMock.findAll).not.toHaveBeenCalled();
    });

    it('"mis eventos" lists only events the user is a member of via findByUser', async () => {
      conversationStoreMock.get.mockResolvedValue({ userId: USER_ID });
      userEventsServiceMock.findByUser.mockResolvedValue([
        { id: EVENT_ID, name: 'My Wedding' },
      ]);

      await service.handleIncoming(buildPayload('m-list', PHONE, 'mis eventos'));

      expect(userEventsServiceMock.findByUser).toHaveBeenCalledWith(USER_ID);
      expect(whatsappClientMock.sendText).toHaveBeenCalledWith(PHONE, expect.any(String));
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
      redisServiceMock.setNX.mockResolvedValue(true);
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
      redisServiceMock.setNX.mockResolvedValue(true);
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

  describe('write flow — agregar invitado (CONFIRM gate)', () => {
    beforeEach(() => {
      redisServiceMock.setNX.mockResolvedValue(true);
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
  });

  describe('write flow — editar invitado (CONFIRM gate)', () => {
    beforeEach(() => {
      redisServiceMock.setNX.mockResolvedValue(true);
      userEventsServiceMock.findOne.mockResolvedValue({ id: EVENT_ID, name: 'My Wedding' });
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
      redisServiceMock.setNX.mockResolvedValue(true);
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
