import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { session } from 'telegraf';

import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { TelegramModule } from './telegram/telegram.module';
import { PostbackModule } from './postback/postback.module';
import { AdminModule } from './admin/admin.module';
import { PayoutsModule } from './payouts/payouts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthController } from './health.controller';
import { AliboOpenController } from './affiliate/alibo-open.controller';
import { ZaloModule } from './zalo/zalo.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow<string>('TELEGRAM_BOT_TOKEN'),
        middlewares: [session()],
        // main.ts decides whether to start polling or configure webhooks.
        launchOptions: false,
      }),
    }),
    PrismaModule,
    NotificationsModule,
    UsersModule,
    AffiliateModule,
    PayoutsModule,
    AdminModule,
    TelegramModule,
    ZaloModule,
    PostbackModule,
  ],
  controllers: [HealthController, AliboOpenController],
})
export class AppModule {}
