import { Injectable, Logger } from '@nestjs/common';
import { secrets } from '../config/secrets';
import { normalizeWhatsappRecipient } from './phone.util';

interface InteractiveButton {
  id: string;
  title: string;
}

interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

/**
 * Distinguishes WHY an outbound send failed. `WINDOW_CLOSED` (Graph 131047)
 * and `MARKETING_THROTTLED` (Graph 131049) are kept separate on purpose —
 * the operator remedy differs: 131047 means "ask the recipient to message
 * us first", 131049 means "wait, WhatsApp throttled this number".
 */
export enum SendFailureReason {
  WINDOW_CLOSED = 'window_closed',
  MARKETING_THROTTLED = 'marketing_throttled',
  INVALID_PHONE = 'invalid_phone',
  TRANSPORT = 'transport',
  UNKNOWN = 'unknown',
}

export type SendOutcome =
  | { ok: true; messageId?: string }
  | { ok: false; reason: SendFailureReason; graphCode?: number };

const GRAPH_CODE_TO_REASON: Partial<Record<number, SendFailureReason>> = {
  131047: SendFailureReason.WINDOW_CLOSED,
  131049: SendFailureReason.MARKETING_THROTTLED,
};

/** Minimum/maximum plausible E.164 national-significant-number length. */
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

function isValidPhoneShape(phone: string): boolean {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
}

/**
 * Thin outbound sender for the Meta WhatsApp Cloud (Graph) API. The
 * pre-existing `sendText`/`sendInteractiveButtons`/`sendInteractiveList`
 * methods swallow their own errors (logs and returns `void`) so a
 * downstream Graph API failure never bubbles up into the webhook handler —
 * the webhook must always answer 200 within Meta's 5s window regardless of
 * send outcome. They are UNCHANGED and remain thin wrappers over `post`.
 *
 * `sendWithResult` is a result-returning sibling for callers (real
 * notification dispatch) that need to know WHY a send failed.
 */
@Injectable()
export class WhatsappClient {
  private readonly logger = new Logger(WhatsappClient.name);

  async sendText(to: string, body: string): Promise<void> {
    await this.post(to, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    });
  }

  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: InteractiveButton[],
  ): Promise<void> {
    await this.post(to, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((button) => ({
            type: 'reply',
            reply: { id: button.id, title: button.title },
          })),
        },
      },
    });
  }

  /**
   * Result-returning sibling of `sendInteractiveButtons`. Validates the
   * phone shape BEFORE attempting a send (local, pre-send check — never
   * counted as a Graph/transport failure) and surfaces Graph error codes as
   * a typed `SendOutcome` instead of swallowing them.
   */
  async sendWithResult(
    to: string,
    bodyText: string,
    buttons: InteractiveButton[],
  ): Promise<SendOutcome> {
    if (!isValidPhoneShape(to)) {
      return { ok: false, reason: SendFailureReason.INVALID_PHONE };
    }

    return this.postWithResult(to, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((button) => ({
            type: 'reply',
            reply: { id: button.id, title: button.title },
          })),
        },
      },
    });
  }

  async sendInteractiveList(
    to: string,
    bodyText: string,
    buttonLabel: string,
    rows: InteractiveListRow[],
  ): Promise<void> {
    await this.post(to, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: [{ rows }],
        },
      },
    });
  }

  /** Unchanged never-throw contract — the webhook path depends on it. */
  private async post(to: string, payload: Record<string, unknown>): Promise<void> {
    await this.postWithResult(to, payload);
  }

  private async postWithResult(
    to: string,
    payload: Record<string, unknown>,
  ): Promise<SendOutcome> {
    const url = `${secrets.WHATSAPP_API_URL}/${secrets.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    // The inbound `from`/wa_id is not always a valid send target (MX/AR carry an
    // extra digit Meta rejects). Normalize here — the single outbound choke point.
    const recipient = normalizeWhatsappRecipient(to);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secrets.WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, to: recipient }),
      });

      if (!response.ok) {
        const graphCode = await this.extractGraphErrorCode(response);
        this.logger.error(
          `WhatsApp Graph API responded with ${response.status} while sending to ${recipient}`,
        );
        return {
          ok: false,
          reason: GRAPH_CODE_TO_REASON[graphCode as number] ?? SendFailureReason.UNKNOWN,
          graphCode,
        };
      }

      return { ok: true, messageId: await this.extractMessageId(response) };
    } catch (err) {
      this.logger.error(
        `Failed to send WhatsApp message to ${recipient}: ${(err as Error).message}`,
      );
      return { ok: false, reason: SendFailureReason.TRANSPORT };
    }
  }

  /** Best-effort — a malformed/absent error body never blocks classification. */
  private async extractGraphErrorCode(response: Response): Promise<number | undefined> {
    try {
      const body = (await response.json()) as { error?: { code?: number } };
      return body?.error?.code;
    } catch {
      return undefined;
    }
  }

  /** Best-effort — the caller only needs this for observability, never required. */
  private async extractMessageId(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as { messages?: Array<{ id?: string }> };
      return body?.messages?.[0]?.id;
    } catch {
      return undefined;
    }
  }
}
