import { Module } from '@nestjs/common';
import { TelegramUpdate } from './telegram.update';
import { SetBankScene } from './scenes/setbank.scene';
import { UsersModule } from '../users/users.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { DealsModule } from '../deals/deals.module';
import { RateLimitService } from './rate-limit.service';

@Module({
  imports: [UsersModule, AffiliateModule, PayoutsModule, DealsModule],
  providers: [TelegramUpdate, SetBankScene, RateLimitService],
  exports: [RateLimitService],
})
export class TelegramModule {}
