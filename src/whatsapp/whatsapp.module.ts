import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';

@Module({
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappLinkService,
    ConversationStore,
    WhatsappSignatureGuard,
  ],
})
export class WhatsappModule {}
