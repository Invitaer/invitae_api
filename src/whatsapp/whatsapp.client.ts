import { Injectable, Logger } from '@nestjs/common';
import { secrets } from '../config/secrets';

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
 * Thin outbound sender for the Meta WhatsApp Cloud (Graph) API. Every method
 * swallows its own errors (logs and returns) so a downstream Graph API
 * failure never bubbles up into the webhook handler — the webhook must
 * always answer 200 within Meta's 5s window regardless of send outcome.
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

  private async post(to: string, payload: Record<string, unknown>): Promise<void> {
    const url = `${secrets.WHATSAPP_API_URL}/${secrets.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secrets.WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.error(
          `WhatsApp Graph API responded with ${response.status} while sending to ${to}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send WhatsApp message to ${to}: ${(err as Error).message}`,
      );
    }
  }
}
