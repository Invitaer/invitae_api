import {
  escapeHtml,
  renderEmailVerification,
  renderWhatsappOtp,
} from './mail.templates';

describe('mail templates', () => {
  describe('escapeHtml', () => {
    it('escapes HTML metacharacters so interpolated values cannot inject markup', () => {
      expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;');
    });
  });

  describe('renderEmailVerification', () => {
    it('greets by name and embeds the verification URL in both html and text', () => {
      const email = renderEmailVerification({
        name: 'Alice',
        verificationUrl: 'https://app.test/verify?t=1',
      });

      expect(email.subject).toMatch(/invitae/i);
      expect(email.html).toContain('Alice');
      expect(email.html).toContain('https://app.test/verify?t=1');
      expect(email.text).toContain('https://app.test/verify?t=1');
    });

    it('falls back to a neutral greeting when no name is given', () => {
      const email = renderEmailVerification({ verificationUrl: 'https://app.test/v' });
      expect(email.html).toContain('Hola,');
      expect(email.html).not.toContain('undefined');
    });

    it('escapes a name containing markup', () => {
      const email = renderEmailVerification({
        name: '<b>x</b>',
        verificationUrl: 'https://app.test/v',
      });
      expect(email.html).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(email.html).not.toContain('<b>x</b>');
    });
  });

  describe('renderWhatsappOtp', () => {
    it('shows the code in subject, html and text and states the TTL', () => {
      const email = renderWhatsappOtp({ code: '482913', ttlMinutes: 7 });

      expect(email.subject).toContain('482913');
      expect(email.html).toContain('482913');
      expect(email.text).toContain('482913');
      expect(email.text).toContain('7');
    });
  });
});
