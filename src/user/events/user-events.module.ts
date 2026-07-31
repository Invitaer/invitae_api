import { Module } from '@nestjs/common';
import { GuestsModule } from '../../admin/guests/guests.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { UserEventsController } from './user-events.controller';
import { UserEventsService } from './user-events.service';
import { UserGuestsController } from './user-guests.controller';
import { UserEventMemberGuard } from './guards/user-event-member.guard';

@Module({
  imports: [GuestsModule, NotificationsModule, RealtimeModule],
  controllers: [UserEventsController, UserGuestsController],
  providers: [UserEventsService, UserEventMemberGuard],
  exports: [UserEventsService],
})
export class UserEventsModule {}
