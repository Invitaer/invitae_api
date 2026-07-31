/**
 * Pure, side-effect-free builders for the transactional emails this service
 * sends. Kept separate from `MailService` so the copy can be unit-tested and
 * reviewed without touching transport code. Each builder returns the full
 * `{ subject, html, text }` triple — a plain-text alternative is ALWAYS
 * provided so the message is not penalized as HTML-only by spam filters.
 */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Minimal HTML escaping for values interpolated into the HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Account/auth confirmation email with a single verification link. Used when a
 * user must confirm ownership of their email address before the account is
 * fully active.
 */
export function renderEmailVerification(params: {
  name?: string;
  verificationUrl: string;
}): RenderedEmail {
  const greeting = params.name?.trim() ? `Hola ${escapeHtml(params.name.trim())}` : 'Hola';
  const url = params.verificationUrl;

  const subject = 'Confirma tu cuenta de Invitae';
  const text =
    `${params.name?.trim() ? `Hola ${params.name.trim()}` : 'Hola'},\n\n` +
    `Confirma tu cuenta abriendo este enlace:\n${url}\n\n` +
    `Si no creaste esta cuenta, puedes ignorar este correo.`;
  const html =
    `<p>${greeting},</p>` +
    `<p>Confirma tu cuenta de Invitae haciendo clic en el siguiente botón:</p>` +
    `<p><a href="${escapeHtml(url)}">Confirmar mi cuenta</a></p>` +
    `<p>O copia y pega este enlace en tu navegador:<br>${escapeHtml(url)}</p>` +
    `<p>Si no creaste esta cuenta, puedes ignorar este correo.</p>`;

  return { subject, html, text };
}

/**
 * One-time password email used to confirm the phone number a user wants to
 * link to the WhatsApp bot. The code is shown verbatim; `ttlMinutes` tells the
 * recipient how long it stays valid.
 */
export function renderWhatsappOtp(params: {
  code: string;
  ttlMinutes: number;
}): RenderedEmail {
  const { code, ttlMinutes } = params;
  const safeCode = escapeHtml(code);

  const subject = `Tu código de Invitae es ${code} ✨`;

  const text =
    `¡Hola! 👋\n\n` +
    `Estás a un paso de conectar tu WhatsApp con Invitae.\n\n` +
    `Tu código de verificación es: ${code}\n\n` +
    `Escríbelo en el chat del bot para confirmar tu número.\n` +
    `El código vence en ${ttlMinutes} minuto(s), así que no tardes 🙂\n\n` +
    `Si no fuiste tú, puedes ignorar este correo con tranquilidad.\n\n` +
    `Con cariño,\nEl equipo de Invitae 💌`;

  const html = `
  <div style="margin:0;padding:32px 16px;background:#f5f3ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(91,33,182,0.12);">
      <tr>
        <td style="background:linear-gradient(135deg,#7c3aed,#a855f7);padding:28px 32px;text-align:center;">
          <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">Invitae ✨</span>
        </td>
      </tr>
      <tr>
        <td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#1f2937;">¡Hola! 👋</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b5563;">
            Estás a un paso de conectar tu <strong>WhatsApp</strong> con Invitae.
            Usa este código para confirmar tu número:
          </p>
          <div style="margin:0 auto 24px;text-align:center;">
            <span style="display:inline-block;padding:16px 28px;background:#f5f3ff;border:1px dashed #c4b5fd;border-radius:12px;font-size:32px;font-weight:700;letter-spacing:8px;color:#6d28d9;">${safeCode}</span>
          </div>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#4b5563;text-align:center;">
            Escríbelo en el chat del bot para confirmar tu número.
          </p>
          <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;text-align:center;">
            ⏳ El código vence en <strong>${ttlMinutes} minuto(s)</strong>, así que no tardes 🙂
          </p>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;text-align:center;">
            Si no fuiste tú, puedes ignorar este correo con tranquilidad.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 32px;background:#faf5ff;text-align:center;">
          <p style="margin:0;font-size:12px;color:#a78bfa;">Con cariño, el equipo de Invitae 💌</p>
        </td>
      </tr>
    </table>
  </div>`;

  return { subject, html, text };
}
