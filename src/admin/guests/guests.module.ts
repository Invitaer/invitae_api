import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

@Module({
  imports: [EventsModule, RealtimeModule],
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
