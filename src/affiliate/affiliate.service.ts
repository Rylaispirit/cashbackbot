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

  /**
   * Tạo affiliate link cho user.
   *  1. Detect merchant
   *  2. Generate sub_id duy nhất (gắn user.id + random)
   *  3. Build AT deeplink (template) — có option dùng AT API nếu muốn short link đẹp hơn
   *  4. Lưu Link row vào DB
   */
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

  /**
   * Sub_id format: tg<userId-prefix><random>
   * - userId-prefix: 8 ký tự đầu của cuid để debug/lookup nhanh
   * - random: 6 ký tự hex để đảm bảo unique giữa các lần click
   * Tổng: ~16 ký tự, an toàn trong giới hạn sub_id của AT (thường 30 char).
   */
  private generateSubId(userId: string): string {
    const prefix = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const random = randomBytes(3).toString('hex');
    return `tg${prefix}${random}`;
  }

  /**
   * Build deeplink theo template Accesstrade.
   *
   * Default template:
   *   https://gj.accesstrade.vn/deep_link/{pub_id}?url={url_encoded}&aff_sub={sub_id}
   *
   * Bạn có thể override qua env ACCESSTRADE_DEEPLINK_TEMPLATE nếu AT cấp template khác.
   * Placeholders hỗ trợ: {pub_id}, {url}, {sub_id}, {merchant}
   */
  private buildDeeplink(originalUrl: string, subId: string, merchant: Merchant): string {
    const pubId = this.config.get<string>('ACCESSTRADE_PUB_ID');
    if (!pubId) {
      throw new Error('ACCESSTRADE_PUB_ID chưa cấu hình trong .env');
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

  /**
   * (Optional) Gọi AT API để tạo short link đẹp.
   * Trả về null nếu chưa cấu hình API token — caller sẽ fallback về template.
   *
   * Docs: https://docs.accesstrade.vn/
   */
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
      // Response shape có thể khác — tuỳ AT. User cần verify bằng curl trước khi tin response.
      const shortUrl: string | undefined =
        res.data?.data?.success_link?.[0]?.short_link ??
        res.data?.data?.success_link?.[0]?.aff_link ??
        res.data?.data?.[0]?.short_link ??
        res.data?.short_link;
      return shortUrl ?? null;
    } catch (err) {
      this.logger.warn(`AT API failed, fallback to template: ${(err as Error).message}`);
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
