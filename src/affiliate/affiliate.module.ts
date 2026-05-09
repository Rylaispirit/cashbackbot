import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AliboService } from './alibo.service';
import { AliboBrowserService } from './alibo-browser.service';
import { AliboOpenController } from './alibo-open.controller';

@Module({
  controllers: [AliboOpenController],
  providers: [AffiliateService, AliboService, AliboBrowserService],
  exports: [AffiliateService, AliboService],
})
export class AffiliateModule {}
