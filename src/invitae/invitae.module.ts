import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { InvitaeController } from './invitae.controller';
import { InvitaeService } from './invitae.service';

@Module({
  imports: [RealtimeModule],
  controllers: [InvitaeController],
  providers: [InvitaeService],
})
export class InvitaeModule {}
