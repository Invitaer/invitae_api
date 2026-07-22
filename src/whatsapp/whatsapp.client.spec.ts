jest.mock('../config/secrets', () => ({
  secrets: {
    WHATSAPP_API_URL: 'https://graph.facebook.com/v18.0',
    WHATSAPP_API_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'phone-id-123',
  },
}));

import { WhatsappClient, SendFailureReason } from './whatsapp.client';

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

  describe('sendWithResult', () => {
    const BUTTONS = [
      { id: 'guest_rsvp_yes:guest-1', title: 'Asistire' },
      { id: 'guest_rsvp_no:guest-1', title: 'No podre asistir' },
    ];

    it('returns ok:true on a successful Graph API response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.abc' }] }),
      } as Response);

      const outcome = await client.sendWithResult(
        '+5491100000000',
        'Hola, confirmas tu asistencia?',
        BUTTONS,
      );

      expect(outcome).toEqual({ ok: true, messageId: 'wamid.abc' });
    });

    it('maps Graph error code 131047 to SendFailureReason.WINDOW_CLOSED', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131047, message: 'window closed' } }),
      } as Response);

      const outcome = await client.sendWithResult('+5491100000000', 'body', BUTTONS);

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.WINDOW_CLOSED,
        graphCode: 131047,
      });
    });

    it('maps Graph error code 131049 to SendFailureReason.MARKETING_THROTTLED (distinct from 131047)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131049, message: 'throttled' } }),
      } as Response);

      const outcome = await client.sendWithResult('+5491100000000', 'body', BUTTONS);

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });
      expect(outcome).not.toMatchObject({ reason: SendFailureReason.WINDOW_CLOSED });
    });

    it('maps any other Graph error code to SendFailureReason.UNKNOWN', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 100, message: 'bad request' } }),
      } as Response);

      const outcome = await client.sendWithResult('+5491100000000', 'body', BUTTONS);

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.UNKNOWN,
        graphCode: 100,
      });
    });

    it('returns SendFailureReason.INVALID_PHONE for an empty phone WITHOUT calling fetch', async () => {
      const outcome = await client.sendWithResult('', 'body', BUTTONS);

      expect(outcome).toEqual({ ok: false, reason: SendFailureReason.INVALID_PHONE });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns SendFailureReason.INVALID_PHONE for a malformed (too-short) phone WITHOUT calling fetch', async () => {
      const outcome = await client.sendWithResult('123', 'body', BUTTONS);

      expect(outcome).toEqual({ ok: false, reason: SendFailureReason.INVALID_PHONE });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns SendFailureReason.TRANSPORT when the fetch call itself throws (network failure)', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      const outcome = await client.sendWithResult('+5491100000000', 'body', BUTTONS);

      expect(outcome).toEqual({ ok: false, reason: SendFailureReason.TRANSPORT });
    });
  });

  describe('sendTemplateWithResult', () => {
    const BODY_PARAMS = ['Alice', 'Carlos', 'Esperamos que puedas acompañarnos'];
    const BUTTON_PAYLOADS = ['guest_rsvp_yes:guest-1', 'guest_rsvp_no:guest-1'];

    function send(to = '+5491100000000') {
      return client.sendTemplateWithResult(
        to,
        'guest_invite_rsvp',
        'es',
        BODY_PARAMS,
        BUTTON_PAYLOADS,
      );
    }

    it('POSTs a template payload with body params and two dynamic quick-reply buttons', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.tpl' }] }),
      } as Response);

      const outcome = await send();

      expect(outcome).toEqual({ ok: true, messageId: 'wamid.tpl' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        messaging_product: 'whatsapp',
        // Argentine wa_id normalization still applies — same choke point.
        to: '541100000000',
        type: 'template',
        template: {
          name: 'guest_invite_rsvp',
          language: { code: 'es' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Alice' },
                { type: 'text', text: 'Carlos' },
                { type: 'text', text: 'Esperamos que puedas acompañarnos' },
              ],
            },
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: 0,
              parameters: [{ type: 'payload', payload: 'guest_rsvp_yes:guest-1' }],
            },
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: 1,
              parameters: [{ type: 'payload', payload: 'guest_rsvp_no:guest-1' }],
            },
          ],
        },
      });
    });

    it('maps Graph error code 131049 to MARKETING_THROTTLED (templates are throttled, not window-blocked)', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131049, message: 'throttled' } }),
      } as Response);

      expect(await send()).toEqual({
        ok: false,
        reason: SendFailureReason.MARKETING_THROTTLED,
        graphCode: 131049,
      });
    });

    it('returns INVALID_PHONE for a malformed phone WITHOUT calling fetch', async () => {
      expect(await send('123')).toEqual({
        ok: false,
        reason: SendFailureReason.INVALID_PHONE,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns TEMPLATE_PARAM_INVALID for a param with a newline WITHOUT calling fetch', async () => {
      const outcome = await client.sendTemplateWithResult(
        '+5491100000000',
        'guest_invite_rsvp',
        'es',
        ['Alice', 'Carlos', 'Hola\nmundo'],
        BUTTON_PAYLOADS,
      );

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.TEMPLATE_PARAM_INVALID,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns TEMPLATE_PARAM_INVALID when the substituted body reaches 1024 chars WITHOUT calling fetch', async () => {
      const outcome = await client.sendTemplateWithResult(
        '+5491100000000',
        'guest_invite_rsvp',
        'es',
        ['Alice', 'Carlos', 'a'.repeat(1024)],
        BUTTON_PAYLOADS,
      );

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.TEMPLATE_PARAM_INVALID,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns TEMPLATE_PARAM_INVALID when a button payload is empty WITHOUT calling fetch', async () => {
      const outcome = await client.sendTemplateWithResult(
        '+5491100000000',
        'guest_invite_rsvp',
        'es',
        BODY_PARAMS,
        ['guest_rsvp_yes:guest-1', ''],
      );

      expect(outcome).toEqual({
        ok: false,
        reason: SendFailureReason.TEMPLATE_PARAM_INVALID,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns SendFailureReason.TRANSPORT when the fetch call itself throws', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      expect(await send()).toEqual({ ok: false, reason: SendFailureReason.TRANSPORT });
    });
  });
});
