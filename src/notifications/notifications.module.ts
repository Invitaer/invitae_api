import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';

@Module({
  imports: [WhatsappSenderModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
