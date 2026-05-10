import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AliboService } from './alibo.service';
import { AliboBrowserService } from './alibo-browser.service';

@Module({
  providers: [AffiliateService, AliboService, AliboBrowserService],
  exports: [AffiliateService, AliboService],
})
export class AffiliateModule {}
