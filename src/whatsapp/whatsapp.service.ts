import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';

export interface WhatsappWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id: string;
          from: string;
          text?: { body: string };
        }>;
      };
    }>;
  }>;
}

interface WhatsappMessage {
  id: string;
  from: string;
  text?: { body: string };
}

const MESSAGE_ID_TTL_SECONDS = 86400; // 24h — enough to cover Meta's retry window
const OTP_CODE_PATTERN = /^\d{6}$/;

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly whatsappLinkService: WhatsappLinkService,
    private readonly conversationStore: ConversationStore,
  ) {}

  async handleIncoming(payload: WhatsappWebhookPayload): Promise<void> {
    const message = this.extractMessage(payload);
    if (!message) {
      return;
    }

    const claimed = await this.redisService.setNX(
      `wa:msg:${message.id}`,
      'processed',
      MESSAGE_ID_TTL_SECONDS,
    );

    if (!claimed) {
      this.logger.log(`Duplicate message_id ${message.id} — skipping reprocessing`);
      return;
    }

    const phoneNumber = message.from;
    const text = message.text?.body?.trim() ?? '';

    if (OTP_CODE_PATTERN.test(text)) {
      const linked = await this.whatsappLinkService.verifyAndLink(text, phoneNumber);
      if (!linked) {
        this.logger.log(`Failed OTP verification attempt from ${phoneNumber}`);
      }
      return;
    }

    const userId = await this.whatsappLinkService.resolvePhone(phoneNumber);
    if (!userId) {
      this.logger.log(`Unlinked phone ${phoneNumber} — replying with linking instructions`);
      return;
    }

    // Identity resolved. Command parsing/dispatch is implemented in Slice 3.
    await this.conversationStore.get(phoneNumber);
  }

  private extractMessage(payload: WhatsappWebhookPayload): WhatsappMessage | undefined {
    return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  }
}
