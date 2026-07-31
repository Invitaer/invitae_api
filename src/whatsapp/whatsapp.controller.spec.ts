// Mock secrets before any imports to prevent validation side-effects at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
    WHATSAPP_APP_SECRET: 'test-app-secret',
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { AuthUser } from '../auth/interfaces/auth-user.interface';

function buildMockResponse() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

describe('WhatsappController', () => {
  let controller: WhatsappController;
  let whatsappServiceMock: { handleIncoming: jest.Mock };
  let whatsappLinkServiceMock: { startLink: jest.Mock };

  beforeEach(async () => {
    whatsappServiceMock = { handleIncoming: jest.fn().mockResolvedValue(undefined) };
    whatsappLinkServiceMock = { startLink: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappController],
      providers: [
        { provide: WhatsappService, useValue: whatsappServiceMock },
        { provide: WhatsappLinkService, useValue: whatsappLinkServiceMock },
      ],
    }).compile();

    controller = module.get<WhatsappController>(WhatsappController);
  });

  describe('verify (GET webhook)', () => {
    it('responds 200 and echoes hub.challenge when hub.verify_token matches', () => {
      const res = buildMockResponse();

      controller.verify('subscribe', 'test-verify-token', 'challenge-123', res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('challenge-123');
    });

    it('responds 403 and does not echo challenge when hub.verify_token does not match', () => {
      const res = buildMockResponse();

      controller.verify('subscribe', 'wrong-token', 'challenge-123', res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).not.toHaveBeenCalledWith('challenge-123');
    });
  });

  describe('startLink (POST link/start)', () => {
    it('delegates to WhatsappLinkService.startLink with the authenticated user id and email', async () => {
      whatsappLinkServiceMock.startLink.mockResolvedValue({ delivered: true, email: 'a@b.com' });
      const user: AuthUser = {
        id: 'user-uuid-1',
        email: 'a@b.com',
        name: 'Alice',
        role: 'USER' as any,
      };

      const result = await controller.startLink(user);

      expect(whatsappLinkServiceMock.startLink).toHaveBeenCalledWith('user-uuid-1', 'a@b.com');
      expect(result).toEqual({ delivered: true, email: 'a@b.com' });
    });
  });
});
