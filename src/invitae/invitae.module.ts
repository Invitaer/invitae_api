import { Module } from '@nestjs/common';
import { InvitaeController } from './invitae.controller';
import { InvitaeService } from './invitae.service';

@Module({
  controllers: [InvitaeController],
  providers: [InvitaeService],
})
export class InvitaeModule {}
