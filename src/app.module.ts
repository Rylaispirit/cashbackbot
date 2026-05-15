import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { session, type Context, type MiddlewareFn } from 'telegraf';

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

function adminMenuShortcut(config: ConfigService): MiddlewareFn<Context> {
  const adminIds = new Set(
    config
      .get<string>('TELEGRAM_ADMIN_IDS', '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => BigInt(s)),
  );

  return async (ctx, next) => {
    const message = ctx.message as { text?: string } | undefined;
    const command = message?.text
      ?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i)?.[1]
      ?.toLowerCase();
    if (command !== 'admin') {
      return next();
    }

    const telegramId = ctx.from?.id;
    if (!telegramId || !adminIds.has(BigInt(telegramId))) {
      await ctx.reply(
        [
          'Bạn chưa có quyền dùng lệnh admin trên Telegram.',
          'Nếu đây là tài khoản admin, hãy kiểm tra TELEGRAM_ADMIN_IDS.',
        ].join('\n'),
      );
      return;
    }

    await ctx.reply(buildAdminMenuMessage());
  };
}

function buildAdminMenuMessage(): string {
  return [
    'Admin commands:',
    '/admin_stats - tổng quan',
    '/admin_links - 10 link mới nhất',
    '/admin_link <sub_id> - chi tiết 1 link',
    '/admin_recent - 10 đơn gần nhất',
    '/admin_payouts - list payout pending',
    '/admin_paid <id> - mark payout đã chuyển',
    '/admin_cancel <id> - huỷ payout',
    '/admin_user <telegram_id>',
    '/admin_block <telegram_id>',
    '/admin_unblock <telegram_id>',
    '/admin_broadcast_test <nội dung> - gửi thử cho admin',
    '/admin_broadcast <nội dung> - gửi thông báo tới toàn bộ user',
    '/admin_deal_test <url> | <tiêu đề> | <mô tả> - gửi thử deal cho admin',
    '/admin_deal <url> | <tiêu đề> | <mô tả> - gửi deal tới subscriber',
    '/admin_deal_send <deal_id> - gửi deal đã tạo từ bản test',
    '/admin_deals - 10 deal gần nhất',
    '/admin_deal_subscribers - số người đang bật nhận deal',
    '/admin_scan_deals [limit] - quét deal Shopee từ Accesstrade',
    '',
    'Alibo sync:',
    '/admin_alibo_auto_match [days] [dry|apply] - auto-match HIGH-confidence orders',
    '/admin_alibo_sync [days] - sync đơn từ trang Alibo',
    '/admin_alibo_orders [unmatched|matched|all] - xem đơn Alibo đã sync',
    '/admin_alibo_order <id> - chi tiết 1 đơn Alibo',
    '/admin_alibo_match_order <order_prefix> <subId_prefix> [status] [commission_vnd] - match đơn sync vào user',
    '',
    'Reconcile alibo:',
    '/admin_alibo_pending - link Taobao chưa có đơn',
    '/admin_alibo_match <subId_prefix> <orderId> <commission_report> [sale] [status] - tạo đơn manual',
  ].join('\n');
}

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
        middlewares: [adminMenuShortcut(config), session()],
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
    PostbackModule,
    ZaloModule,
  ],
  controllers: [HealthController, AliboOpenController],
})
export class AppModule {}
