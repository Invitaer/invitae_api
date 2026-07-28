const sendMailMock = jest.fn();
const createTransportMock = jest.fn((_config: unknown) => ({ sendMail: sendMailMock }));
jest.mock('nodemailer', () => ({
  createTransport: (config: unknown) => createTransportMock(config),
}));

import { SmtpMailSender, SmtpMailConfig } from './smtp-mail.sender';
import { RenderedEmail } from './mail.templates';

const CONFIG: SmtpMailConfig = {
  host: 'smtp.resend.test',
  port: 465,
  user: 'resend',
  pass: 're_test_key',
  from: 'Invitae <no-reply@invitae.test>',
};

const EMAIL: RenderedEmail = {
  subject: 'Asunto de prueba',
  html: '<p>cuerpo</p>',
  text: 'cuerpo',
};

describe('SmtpMailSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMailMock.mockResolvedValue({ messageId: 'msg-1' });
  });

  describe('transport construction', () => {
    it('builds the transport from the injected config, secure=true on port 465', () => {
      new SmtpMailSender(CONFIG);

      expect(createTransportMock).toHaveBeenCalledTimes(1);
      expect(createTransportMock).toHaveBeenCalledWith({
        host: 'smtp.resend.test',
        port: 465,
        secure: true,
        auth: { user: 'resend', pass: 're_test_key' },
      });
    });

    it('uses secure=false on a STARTTLS port so 587 is not forced into implicit TLS', () => {
      new SmtpMailSender({ ...CONFIG, port: 587 });

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false }),
      );
    });
  });

  describe('send', () => {
    it('sends the rendered email to the recipient under the configured From', async () => {
      const sender = new SmtpMailSender(CONFIG);

      const result = await sender.send('user@example.com', EMAIL);

      expect(result).toEqual({ ok: true, messageId: 'msg-1' });
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).toHaveBeenCalledWith({
        from: 'Invitae <no-reply@invitae.test>',
        to: 'user@example.com',
        subject: 'Asunto de prueba',
        text: 'cuerpo',
        html: '<p>cuerpo</p>',
      });
    });

    it('still reports ok when the transport omits a messageId', async () => {
      sendMailMock.mockResolvedValueOnce({});
      const sender = new SmtpMailSender(CONFIG);

      await expect(sender.send('user@example.com', EMAIL)).resolves.toEqual({
        ok: true,
        messageId: undefined,
      });
    });
  });

  describe('failure handling', () => {
    it('maps a transport rejection to { ok: false, error } instead of throwing', async () => {
      sendMailMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const sender = new SmtpMailSender(CONFIG);

      await expect(sender.send('user@example.com', EMAIL)).resolves.toEqual({
        ok: false,
        error: 'ECONNREFUSED',
      });
    });

    it('stringifies a non-Error rejection so the outcome always carries a message', async () => {
      sendMailMock.mockRejectedValueOnce('socket closed');
      const sender = new SmtpMailSender(CONFIG);

      await expect(sender.send('user@example.com', EMAIL)).resolves.toEqual({
        ok: false,
        error: 'socket closed',
      });
    });
  });
});
