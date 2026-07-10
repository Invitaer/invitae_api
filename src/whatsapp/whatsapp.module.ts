import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';
import { WhatsappClient } from './whatsapp.client';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { UserEventsModule } from '../user/events/user-events.module';
import { GuestsModule } from '../admin/guests/guests.module';

@Module({
  imports: [UserEventsModule, GuestsModule],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappLinkService,
    ConversationStore,
    WhatsappClient,
    WhatsappSignatureGuard,
  ],
})
export class WhatsappModule {}
