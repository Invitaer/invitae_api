import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventOwnerGuard } from './guards/event-owner.guard';

@Module({
  controllers: [EventsController],
  providers: [EventsService, EventOwnerGuard],
  exports: [EventsService, EventOwnerGuard],
})
export class EventsModule {}
