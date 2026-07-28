import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GuestEventsService } from './guest-events.service';

@Module({
  imports: [RedisModule],
  providers: [GuestEventsService],
  exports: [GuestEventsService],
})
export class RealtimeModule {}
