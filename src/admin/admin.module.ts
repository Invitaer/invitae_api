import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { GuestsModule } from './guests/guests.module';
import { ContentModule } from './content/content.module';

@Module({
  imports: [GuestsModule, ContentModule],
  controllers: [AdminController],
})
export class AdminModule {}
