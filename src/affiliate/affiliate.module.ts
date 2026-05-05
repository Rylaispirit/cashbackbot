import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';

@Module({
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
