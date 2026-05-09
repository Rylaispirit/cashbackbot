import { Module } from '@nestjs/common';

import { DealsService } from './deals.service';

@Module({
  providers: [DealsService],
  exports: [DealsService],
})
export class DealsModule {}
