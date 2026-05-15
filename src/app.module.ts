import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AdminModule } from './admin/admin.module';
import { InvitaeModule } from './invitae/invitae.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    AdminModule,
    InvitaeModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
