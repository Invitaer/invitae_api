import { Module } from '@nestjs/common';
import { ContentModule } from '../../admin/content/content.module';
import { GuestsModule } from '../../admin/guests/guests.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { UserEventsController } from './user-events.controller';
import { UserEventsService } from './user-events.service';
import { UserGuestsController } from './user-guests.controller';
import { UserInvitationController } from './user-invitation.controller';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

@Module({
  imports: [ContentModule, GuestsModule, NotificationsModule, RealtimeModule],
  controllers: [UserEventsController, UserGuestsController, UserInvitationController],
  providers: [UserEventsService, UserEventMemberGuard],
  exports: [UserEventsService],
})
export class UserEventsModule {}
