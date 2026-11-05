import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

@Module({
  imports: [EventsModule],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
