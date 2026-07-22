import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLinkService } from './whatsapp-link.service';
import { ConversationStore } from './conversation.store';
import { WhatsappSenderModule } from './whatsapp-sender.module';
import { WhatsappSignatureGuard } from './guards/whatsapp-signature.guard';
import { UserEventsModule } from '../user/events/user-events.module';
import { GuestsModule } from '../admin/guests/guests.module';

@Module({
  imports: [UserEventsModule, GuestsModule, WhatsappSenderModule],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappLinkService,
    ConversationStore,
    WhatsappSignatureGuard,
  ],
})
export class WhatsappModule {}
