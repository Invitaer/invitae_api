import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AdminModule } from './admin/admin.module';
import { AdminUsersModule } from './admin/users/admin-users.module';
import { UserEventsModule } from './user/events/user-events.module';
import { InvitaeModule } from './invitae/invitae.module';
import { AuthModule } from './auth/auth.module';
import { CryptoModule } from './crypto/crypto.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
    RedisModule,
    CryptoModule,
    AuthModule,
    AdminModule,
    AdminUsersModule,
    UserEventsModule,
    InvitaeModule,
    WhatsappModule,
    MailModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
