import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Link } from '@prisma/client';
import axios from 'axios';

import { PrismaService } from '../prisma/prisma.service';
import { detectMerchant, Merchant } from './url-detector';

interface CreateAffiliateLinkInput {
  userId: string;
  originalUrl: string;
}

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createAffiliateLink(input: CreateAffiliateLinkInput): Promise<Link> {
    const merchant = detectMerchant(input.originalUrl);
    if (!merchant) {
      throw new BadRequestException(
        'Link không được hỗ trợ. Bot đang hỗ trợ: Shopee, Lazada, Tiki, TikTok Shop.',
      );
    }

    const subId = this.generateSubId(input.userId);
    const affiliateUrl =
      (await this.createShortLinkViaApi(input.originalUrl, subId, merchant)) ??
      this.buildDeeplink(input.originalUrl, subId, merchant);

    return this.prisma.link.create({
      data: {
        subId,
        userId: input.userId,
        merchant,
        network: 'accesstrade',
        originalUrl: input.originalUrl,
        affiliateUrl,
      },
    });
  }

  private generateSubId(userId: string): string {
    const prefix = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const random = randomBytes(3).toString('hex');
    return `tg${prefix}${random}`;
  }

  private buildDeeplink(originalUrl: string, subId: string, merchant: Merchant): string {
    const pubId = this.config.get<string>('ACCESSTRADE_PUB_ID');
    if (!pubId) {
      throw new Error('ACCESSTRADE_PUB_ID chưa cấu hình trong env');
    }
    const template =
      this.config.get<string>('ACCESSTRADE_DEEPLINK_TEMPLATE') ??
      'https://gj.accesstrade.vn/deep_link/{pub_id}?url={url}&aff_sub={sub_id}';

    return template
      .replace('{pub_id}', encodeURIComponent(pubId))
      .replace('{url}', encodeURIComponent(originalUrl))
      .replace('{sub_id}', encodeURIComponent(subId))
      .replace('{merchant}', encodeURIComponent(merchant));
  }

  async createShortLinkViaApi(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
  ): Promise<string | null> {
    const token = this.config.get<string>('ACCESSTRADE_API_TOKEN');
    if (!token) return null;
    const campaignId = this.getCampaignIdForMerchant(merchant);
    if (!campaignId) return null;

    try {
      const res = await axios.post(
        'https://api.accesstrade.vn/v1/product_link/create',
        {
          campaign_id: campaignId,
          urls: [originalUrl],
          sub1: subId,
          utm_source: subId,
          url_enc: true,
        },
        {
          headers: {
            Authorization: `Token ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );

      const shortUrl: string | undefined =
        res.data?.data?.success_link?.[0]?.short_link ??
        res.data?.data?.success_link?.[0]?.aff_link ??
        res.data?.data?.[0]?.short_link ??
        res.data?.short_link;
      return shortUrl ?? null;
    } catch (err) {
      this.logger.warn(`AT API failed, fallback to deeplink template: ${(err as Error).message}`);
      return null;
    }
  }

  private getCampaignIdForMerchant(merchant: Merchant): string | null {
    const keyByMerchant: Record<Merchant, string> = {
      shopee: 'ACCESSTRADE_CAMPAIGN_ID_SHOPEE',
      lazada: 'ACCESSTRADE_CAMPAIGN_ID_LAZADA',
      tiki: 'ACCESSTRADE_CAMPAIGN_ID_TIKI',
      tiktok_shop: 'ACCESSTRADE_CAMPAIGN_ID_TIKTOK',
    };

    return this.config.get<string>(keyByMerchant[merchant]) ?? null;
  }
}
