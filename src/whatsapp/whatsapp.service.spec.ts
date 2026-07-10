// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));
jest.mock('../redis/redis.service');
jest.mock('./whatsapp-link.service');
jest.mock('./conversation.store');

import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappService } from './whatsapp.service';
import { RedisService } from '../redis/redis.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';

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

describe('WhatsappService', () => {
  let service: WhatsappService;
  let redisServiceMock: { setNX: jest.Mock };
  let whatsappLinkServiceMock: {
    verifyAndLink: jest.Mock;
    resolvePhone: jest.Mock;
  };
  let conversationStoreMock: { get: jest.Mock };

  beforeEach(async () => {
    redisServiceMock = { setNX: jest.fn() };
    whatsappLinkServiceMock = {
      verifyAndLink: jest.fn(),
      resolvePhone: jest.fn(),
    };
    conversationStoreMock = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: WhatsappLinkService, useValue: whatsappLinkServiceMock },
        { provide: ConversationStore, useValue: conversationStoreMock },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
  });

  describe('idempotency', () => {
    it('drops a duplicate message_id (setNX false) without resolving the link', async () => {
      redisServiceMock.setNX.mockResolvedValue(false);

      await service.handleIncoming(buildPayload('msg-1', '+5491100000000', 'hola'));

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
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue('user-uuid-1');

      await service.handleIncoming(buildPayload('msg-2', '+5491100000000', 'mis eventos'));

      expect(redisServiceMock.setNX).toHaveBeenCalledWith(
        'wa:msg:msg-2',
        expect.any(String),
        expect.any(Number),
      );
      expect(whatsappLinkServiceMock.resolvePhone).toHaveBeenCalledWith('+5491100000000');
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
      whatsappLinkServiceMock.resolvePhone.mockResolvedValue('user-uuid-1');

      await service.handleIncoming(buildPayload('msg-4', '+5491100000000', 'menu'));

      expect(conversationStoreMock.get).toHaveBeenCalledWith('+5491100000000');
    });
  });

  describe('OTP verification routing', () => {
    it('routes a 6-digit message to verifyAndLink instead of resolvePhone', async () => {
      redisServiceMock.setNX.mockResolvedValue(true);
      whatsappLinkServiceMock.verifyAndLink.mockResolvedValue(true);

      await service.handleIncoming(buildPayload('msg-5', '+5491100000000', '123456'));

      expect(whatsappLinkServiceMock.verifyAndLink).toHaveBeenCalledWith(
        '123456',
        '+5491100000000',
      );
      expect(whatsappLinkServiceMock.resolvePhone).not.toHaveBeenCalled();
    });
  });
});
