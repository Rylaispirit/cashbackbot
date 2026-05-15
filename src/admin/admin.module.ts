import { Module } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AdminUpdate } from './admin.update';
import { AdminWebController } from './admin-web.controller';
import { PayoutsModule } from '../payouts/payouts.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { DealsModule } from '../deals/deals.module';
import { AliboOrdersModule } from '../alibo-orders/alibo-orders.module';

@Module({
  imports: [PayoutsModule, AffiliateModule, DealsModule, AliboOrdersModule],
  controllers: [AdminWebController],
  providers: [AdminGuard, AdminService, AdminUpdate],
  exports: [AdminGuard, AdminService],
})
export class AdminModule {}
