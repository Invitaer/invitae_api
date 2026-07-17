jest.mock('../config/secrets', () => ({
  secrets: {
    WHATSAPP_API_URL: 'https://graph.facebook.com/v18.0',
    WHATSAPP_API_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-id-123',
  },
}));

import { WhatsappClient } from './whatsapp.client';

describe('WhatsappClient', () => {
  let client: WhatsappClient;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new WhatsappClient();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('sendText', () => {
    it('POSTs a text message to the Graph API messages endpoint', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);

      await client.sendText('+5491100000000', 'Hola, este es tu resumen');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v18.0/phone-id-123/messages',
      );
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer test-token');
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: 'whatsapp',
        // Argentine wa_id (+549…) is normalized to the valid send format (54…).
        to: '541100000000',
        type: 'text',
        text: { body: 'Hola, este es tu resumen' },
      });
    });

    it('normalizes a Mexican wa_id recipient (strips the extra 1) before sending', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);

      await client.sendText('5213319638873', 'hola');

      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(init.body).to).toBe('523319638873');
    });

    it('does not throw when the Graph API responds with a non-ok status (logs instead)', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500 } as Response);

      await expect(
        client.sendText('+5491100000000', 'hola'),
      ).resolves.toBeUndefined();
    });

    it('does not throw when the fetch call itself rejects (network failure)', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      await expect(
        client.sendText('+5491100000000', 'hola'),
      ).resolves.toBeUndefined();
    });
  });
});
