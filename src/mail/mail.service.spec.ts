import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MAIL_SENDER } from './mail-sender.port';
import { MailService } from './mail.service';

/**
 * These tests exercise POLICY only — which email is composed, what TTL is
 * assumed, how an outcome is reported. Transport is a test double behind the
 * `MAIL_SENDER` port, so switching provider cannot break this suite.
 */
describe('MailService', () => {
  let service: MailService;
  let sender: { send: jest.Mock };

  /** The `RenderedEmail` handed to the port on the Nth send. */
  const sentEmail = (call = 0) => sender.send.mock.calls[call][1];
  const recipient = (call = 0) => sender.send.mock.calls[call][0];

  beforeEach(async () => {
    jest.clearAllMocks();
    sender = { send: jest.fn().mockResolvedValue({ ok: true, messageId: 'msg-1' }) };
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [MailService, { provide: MAIL_SENDER, useValue: sender }],
    }).compile();

    service = module.get(MailService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendWhatsappOtp', () => {
    it('hands the port a rendered OTP email addressed to the recipient', async () => {
      const result = await service.sendWhatsappOtp('user@example.com', { code: '482913' });

      expect(result).toEqual({ ok: true, messageId: 'msg-1' });
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(recipient()).toBe('user@example.com');

      const email = sentEmail();
      expect(email.subject).toContain('482913');
      expect(email.text).toContain('482913');
      expect(email.html).toContain('482913');
      // A plain-text alternative is always provided.
      expect(email.text.length).toBeGreaterThan(0);
    });

    it('states the caller-supplied expiry window in the message', async () => {
      await service.sendWhatsappOtp('user@example.com', { code: '111222', ttlMinutes: 5 });

      expect(sentEmail().text).toContain('5');
    });

    it('falls back to a 10 minute window when the caller omits ttlMinutes', async () => {
      await service.sendWhatsappOtp('user@example.com', { code: '111222' });

      expect(sentEmail().text).toContain('10');
    });
  });

  describe('sendEmailVerification', () => {
    it('hands the port a rendered verification email carrying the link and name', async () => {
      const result = await service.sendEmailVerification('user@example.com', {
        name: 'Alice',
        verificationUrl: 'https://app.invitae.test/verify?token=abc',
      });

      expect(result).toEqual({ ok: true, messageId: 'msg-1' });
      expect(recipient()).toBe('user@example.com');

      const email = sentEmail();
      expect(email.html).toContain('https://app.invitae.test/verify?token=abc');
      expect(email.text).toContain('https://app.invitae.test/verify?token=abc');
      expect(email.html).toContain('Alice');
    });
  });

  describe('failure handling', () => {
    it('propagates the port failure as { ok: false, error } and never throws', async () => {
      sender.send.mockResolvedValueOnce({ ok: false, error: 'ECONNREFUSED' });

      const result = await service.sendWhatsappOtp('user@example.com', { code: '000000' });

      expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
    });

    it('logs an error naming the kind of email that failed', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      sender.send.mockResolvedValueOnce({ ok: false, error: 'boom' });

      await service.sendEmailVerification('user@example.com', {
        verificationUrl: 'https://x.test',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('email-verification'));
    });

    it('survives a port that throws despite the contract, without propagating', async () => {
      sender.send.mockRejectedValueOnce(new Error('adapter blew up'));

      await expect(
        service.sendWhatsappOtp('user@example.com', { code: '000000' }),
      ).resolves.toEqual({ ok: false, error: 'adapter blew up' });
    });
  });
});
