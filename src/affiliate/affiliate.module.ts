import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AliboService } from './alibo.service';

@Module({
  providers: [AffiliateService, AliboService],
  exports: [AffiliateService, AliboService],
})
export class AffiliateModule {}
