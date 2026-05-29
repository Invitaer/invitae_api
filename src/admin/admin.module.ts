import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { EventsModule } from './events/events.module';
import { GuestsModule } from './guests/guests.module';
import { ContentModule } from './content/content.module';

@Module({
  imports: [EventsModule, GuestsModule, ContentModule],
  controllers: [AdminController],
})
export class AdminModule {}
