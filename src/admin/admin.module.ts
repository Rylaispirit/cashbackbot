import { Module } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AdminUpdate } from './admin.update';
import { PayoutsModule } from '../payouts/payouts.module';

@Module({
  imports: [PayoutsModule],
  providers: [AdminGuard, AdminService, AdminUpdate],
  exports: [AdminGuard, AdminService],
})
export class AdminModule {}
