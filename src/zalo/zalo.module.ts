import { Module } from '@nestjs/common';

import { ZaloController } from './zalo.controller';
import { ZaloLinkController } from './zalo-link.controller';
import { ZaloService } from './zalo.service';
import { UsersModule } from '../users/users.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { TelegramModule } from '../telegram/telegram.module';

/**
 * Zalo Bot channel — song song với Telegram channel.
 *
 * Phụ thuộc:
 *   - UsersModule: upsert user theo zaloUserId
 *   - AffiliateModule: tạo affiliate link
 *   - TelegramModule: dùng RateLimitService (share rate limiter giữa 2 channel)
 */
@Module({
  imports: [UsersModule, AffiliateModule, TelegramModule],
  controllers: [ZaloController, ZaloLinkController],
  providers: [ZaloService],
  exports: [ZaloService],
})
export class ZaloModule {}
