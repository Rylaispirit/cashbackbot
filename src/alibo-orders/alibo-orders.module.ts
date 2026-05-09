import { Module } from '@nestjs/common';

import { AliboOrdersService } from './alibo-orders.service';

@Module({
  providers: [AliboOrdersService],
  exports: [AliboOrdersService],
})
export class AliboOrdersModule {}
