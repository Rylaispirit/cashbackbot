import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Link } from '@prisma/client';
import axios from 'axios';

import { PrismaService } from '../prisma/prisma.service';
import { detectMerchant, networkOf, Merchant, labelMerchant } from './url-detector';
import { AliboService, type AliboVoucherInfo } from './alibo.service';

export type LinkChannel = 'telegram' | 'zalo';

interface CreateAffiliateLinkInput {
  userId: string;
  originalUrl: string;
  channel?: LinkChannel;
}

export interface AffiliateLinkResult {
  link: Link;
  notice?: string;
  mobileDeepLink?: string;
  voucherInfo?: AliboVoucherInfo;
}

@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly alibo: AliboService,
  ) {}

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
    const subId = this.generateSubId(input.userId);
    const aliboLink =
      network === 'alibo'
        ? await this.alibo.createLink(input.originalUrl, subId, merchant)
        : undefined;
    const affiliateUrl =
      aliboLink?.affiliateUrl ??
      (await this.createAccesstradeLinkOrThrow(
        input.originalUrl,
        subId,
        merchant,
        network,
      ));

    const link = await this.prisma.link.create({
      data: {
        subId,
        userId: input.userId,
        channel: input.channel ?? 'telegram',
        merchant,
        network,
        originalUrl: input.originalUrl,
        affiliateUrl,
      },
    });

    return {
      link,
      notice: network === 'alibo' ? this.alibo.getUserNotice() : undefined,
      mobileDeepLink: aliboLink?.mobileDeepLink,
      voucherInfo: aliboLink?.voucherInfo,
    };
  }

  getEnabledMerchantLabels(): string[] {
    const labels = [
      labelMerchant('shopee'),
      labelMerchant('lazada'),
      labelMerchant('tiki'),
      labelMerchant('tiktok_shop'),
    ];
    if (this.alibo.isConfigured()) {
      labels.push(
        labelMerchant('taobao'),
        labelMerchant('tmall'),
        labelMerchant('alibaba_1688'),
      );
    }
    return labels;
  }

  private generateSubId(userId: string): string {
    const prefix = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const random = randomBytes(3).toString('hex');
    return `tg${prefix}${random}`;
  }

  private async createAccesstradeLinkOrThrow(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
    network: string,
  ): Promise<string> {
    if (network !== 'accesstrade') {
      throw new BadRequestException('Network affiliate chưa được hỗ trợ.');
    }

    const link = await this.createShortLinkViaApi(originalUrl, subId, merchant);
    if (link) return link;

    throw new BadRequestException(
      `Hiện hệ thống tạo link ${labelMerchant(
        merchant,
      )} đang bận. Mình chưa tạo link cashback để tránh gửi bạn link lỗi. Bạn thử lại sau 1-2 phút nhé.`,
    );
  }

  async createShortLinkViaApi(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
  ): Promise<string | null> {
    const token = this.config.get<string>('ACCESSTRADE_API_TOKEN');
    if (!token) {
      this.logger.warn(`AT API skipped for ${merchant}: missing API token`);
      return null;
    }

    const campaignId = this.getCampaignId(merchant);
    if (!campaignId) {
      this.logger.warn(
        `AT API skipped for ${merchant}: missing campaign id`,
      );
      return null;
    }

    const maxAttempts = this.getAccesstradeApiAttempts();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
            timeout: 30_000,
          },
        );
        const successLink = res.data?.data?.success_link?.[0];
        const shortUrl: string | undefined =
          successLink?.short_link ??
          successLink?.aff_link ??
          res.data?.data?.[0]?.short_link ??
          res.data?.short_link;
        if (shortUrl) return shortUrl;

        this.logger.warn(
          `AT API returned no short link for ${merchant} attempt=${attempt}/${maxAttempts}`,
        );
      } catch (err) {
        this.logger.warn(
          `AT API failed for ${merchant} attempt=${attempt}/${maxAttempts}: ${
            (err as Error).message
          }`,
        );
      }
    }

    return null;
  }

  private getAccesstradeApiAttempts(): number {
    const raw = this.config.get<string>('ACCESSTRADE_API_RETRIES');
    const parsed = raw ? Number.parseInt(raw, 10) : 2;
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
  }

  private getCampaignId(merchant: Merchant): string | null {
    const keyByMerchant: Record<Merchant, string | undefined> = {
      shopee: this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_SHOPEE'),
      lazada: this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_LAZADA'),
      tiki: this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_TIKI'),
      tiktok_shop: this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_TIKTOK'),
      taobao: undefined,
      tmall: undefined,
      alibaba_1688: undefined,
    };

    return (
      keyByMerchant[merchant]?.trim() ??
      this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID')?.trim() ??
      null
    );
  }
}
