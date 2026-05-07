import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Link } from '@prisma/client';
import axios from 'axios';

import { PrismaService } from '../prisma/prisma.service';
import { detectMerchant, networkOf, Merchant, labelMerchant } from './url-detector';
import { AliboService } from './alibo.service';

interface CreateAffiliateLinkInput {
  userId: string;
  originalUrl: string;
}

export interface AffiliateLinkResult {
  link: Link;
  notice?: string; // Cảnh báo thêm hiển thị cho user (vd cảnh báo Taobao đối soát thủ công)
}

const DEFAULT_CAMPAIGN_IDS: Partial<Record<Merchant, string>> = {
  // Verified via /v1/campaigns: "Shopee Viet Nam Smartlink cho tat ca thiet bi".
  shopee: '4751584435713464237',
};

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly alibo: AliboService,
  ) {}

  /**
   * Detect merchant → route đến network phù hợp:
   *   - shopee/lazada/tiki/tiktok_shop → Accesstrade (template URL)
   *   - taobao/tmall/1688              → Alibo.vn (master account wrap)
   */
  async createAffiliateLink(
    input: CreateAffiliateLinkInput,
  ): Promise<AffiliateLinkResult> {
    const merchant = detectMerchant(input.originalUrl);
    if (!merchant) {
      throw new BadRequestException(
        'Link không được hỗ trợ. ChotDeal đang hỗ trợ: Shopee, Lazada, Tiki, TikTok Shop, Taobao, Tmall, 1688.',
      );
    }

    const network = networkOf(merchant);
    if (network === 'accesstrade' && !this.isAccesstradeMerchantEnabled(merchant)) {
      throw new BadRequestException(
        `${labelMerchant(merchant)} đang chuẩn bị mở cashback. ChotDeal hiện đang hỗ trợ: ${this.getEnabledMerchantLabels().join(', ')}.`,
      );
    }

    const subId = this.generateSubId(input.userId);
    const affiliateUrl =
      network === 'alibo'
        ? this.alibo.buildLink(input.originalUrl, subId, merchant)
        : (await this.createShortLinkViaApi(input.originalUrl, subId, merchant)) ??
          this.buildAccesstradeDeeplink(input.originalUrl, subId, merchant);

    const link = await this.prisma.link.create({
      data: {
        subId,
        userId: input.userId,
        merchant,
        network,
        originalUrl: input.originalUrl,
        affiliateUrl,
      },
    });

    return {
      link,
      notice: network === 'alibo' ? this.alibo.getUserNotice() : undefined,
    };
  }

  /**
   * List các merchant đang được bật. Dùng cho welcome message dynamic.
   */
  getEnabledMerchantLabels(): string[] {
    const accesstradeMerchants: Merchant[] = [
      'shopee',
      'lazada',
      'tiki',
      'tiktok_shop',
    ];
    const enabled = accesstradeMerchants
      .filter((merchant) => this.isAccesstradeMerchantEnabled(merchant))
      .map((merchant) => labelMerchant(merchant));

    if (this.alibo.isConfigured()) {
      enabled.push(
        labelMerchant('taobao'),
        labelMerchant('tmall'),
        labelMerchant('alibaba_1688'),
      );
    }

    return enabled.length > 0 ? enabled : [labelMerchant('shopee')];
  }

  /**
   * Sub_id format: tg<userId-prefix><random>
   */
  private generateSubId(userId: string): string {
    const prefix = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const random = randomBytes(3).toString('hex');
    return `tg${prefix}${random}`;
  }

  private buildAccesstradeDeeplink(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
  ): string {
    const pubId = this.config.get<string>('ACCESSTRADE_PUB_ID');
    if (!pubId) {
      throw new Error('ACCESSTRADE_PUB_ID chưa cấu hình trong .env');
    }
    const campaignId = this.getCampaignIdForMerchant(merchant);
    const template =
      this.config.get<string>('ACCESSTRADE_DEEPLINK_TEMPLATE') ??
      (campaignId
        ? 'https://go.isclix.com/deep_link/{pub_id}/{campaign_id}?url={url}&sub1={sub_id}&utm_source={sub_id}'
        : 'https://gj.accesstrade.vn/deep_link/{pub_id}?url={url}&aff_sub={sub_id}');

    return template
      .replaceAll('{pub_id}', encodeURIComponent(pubId))
      .replaceAll('{campaign_id}', encodeURIComponent(campaignId ?? ''))
      .replaceAll('{url}', encodeURIComponent(originalUrl))
      .replaceAll('{sub_id}', encodeURIComponent(subId))
      .replaceAll('{merchant}', encodeURIComponent(merchant));
  }

  /**
   * (Optional) Gọi Accesstrade API để tạo short link đẹp.
   * Trả về null nếu chưa cấu hình API token.
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
      const link = this.extractTrackingLink(res.data);
      if (!link) {
        this.logger.warn('AT API response did not include a tracking link, fallback to deeplink template');
      }
      return link;
    } catch (err) {
      this.logger.warn(
        `AT API failed, fallback to template: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private getCampaignIdForMerchant(merchant: Merchant): string | null {
    const keyByMerchant: Partial<Record<Merchant, string>> = {
      shopee: 'ACCESSTRADE_CAMPAIGN_ID_SHOPEE',
      lazada: 'ACCESSTRADE_CAMPAIGN_ID_LAZADA',
      tiki: 'ACCESSTRADE_CAMPAIGN_ID_TIKI',
      tiktok_shop: 'ACCESSTRADE_CAMPAIGN_ID_TIKTOK',
    };
    const key = keyByMerchant[merchant];
    return (
      (key ? this.config.get<string>(key) : undefined) ??
      DEFAULT_CAMPAIGN_IDS[merchant] ??
      null
    );
  }

  private isAccesstradeMerchantEnabled(merchant: Merchant): boolean {
    return Boolean(this.getCampaignIdForMerchant(merchant));
  }

  private extractTrackingLink(data: unknown): string | null {
    const body = data as {
      data?: {
        success_link?: Array<{ aff_link?: string; short_link?: string }>;
      } | Array<{ aff_link?: string; short_link?: string }>;
      aff_link?: string;
      short_link?: string;
    };
    const first =
      (Array.isArray(body.data)
        ? body.data[0]
        : body.data?.success_link?.[0]) ?? body;

    // Prefer the short URL for Telegram UX; it still redirects through the
    // affiliate link carrying campaign_id and sub1.
    return first?.short_link ?? first?.aff_link ?? null;
  }
}
