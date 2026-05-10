import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Merchant, extractAlibabaItemId } from './url-detector';
import {
  AliboBrowserAutomationError,
  AliboBrowserService,
  type AliboVoucherInfo,
} from './alibo-browser.service';

export interface AliboLinkResult {
  affiliateUrl: string;
  mobileDeepLink?: string;
  voucherInfo?: AliboVoucherInfo;
}

export type { AliboVoucherInfo };

@Injectable()
export class AliboService {
  private readonly logger = new Logger(AliboService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly browser: AliboBrowserService,
  ) {}

  isConfigured(): boolean {
    if (this.isBrowserMode()) {
      return this.browser.isConfigured();
    }

    return Boolean(
      this.config.get<string>('ALIBO_MASTER_REF')?.trim() &&
        this.config.get<string>('ALIBO_LINK_TEMPLATE')?.trim(),
    );
  }

  async createLink(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
  ): Promise<AliboLinkResult> {
    if (this.isBrowserMode()) {
      if (!this.browser.isConfigured()) {
        throw new BadRequestException(
          'Cashback Taobao/Tmall/1688 chưa mở public. Admin đang cấu hình hệ thống tạo link chiết khấu.',
        );
      }

      try {
        return await this.browser.createDiscountLink({
          originalUrl,
          subId,
          merchant,
        });
      } catch (err) {
        if (err instanceof AliboBrowserAutomationError) {
          this.logger.warn(
            `Alibo browser failed (${err.code}) for subId=${subId}: ${err.message}`,
          );
          if (err.code === 'no_discount') {
            throw new BadRequestException(
              'Sản phẩm này hiện không có chiết khấu trên hệ thống Cashback. Bạn thử link sản phẩm khác nhé.',
            );
          }
        }
        throw err;
      }
    }

    return {
      affiliateUrl: this.buildTemplateLink(originalUrl, subId, merchant),
    };
  }

  getUserRate(): number {
    return parseInt(
      this.config.get<string>('ALIBO_DEFAULT_USER_RATE', '60'),
      10,
    );
  }

  getUserNotice(): string {
    return [
      '⚠️ Lưu ý hàng Trung Quốc:',
      '• Cashback Taobao/Tmall/1688 cần đối soát thủ công, thường mất 7-30 ngày sau khi đơn giao thành công.',
      '• Bạn cần đặt qua dịch vụ vận chuyển/order hộ. ChotDeal không vận chuyển hộ.',
      '• Hãy lưu mã đơn dịch vụ và ảnh đơn hàng để hỗ trợ tra cứu khi cần.',
    ].join('\n');
  }

  private isBrowserMode(): boolean {
    return (
      this.config.get<string>('ALIBO_AUTOMATION_MODE')?.toLowerCase().trim() ===
      'browser'
    );
  }

  private buildTemplateLink(
    originalUrl: string,
    subId: string,
    merchant: Merchant,
  ): string {
    const masterRef = this.config.get<string>('ALIBO_MASTER_REF');
    const template = this.config.get<string>('ALIBO_LINK_TEMPLATE');
    if (!masterRef || !template) {
      throw new BadRequestException(
        'Cashback Taobao/1688 chưa cấu hình xong. Liên hệ admin.',
      );
    }

    const itemId = extractAlibabaItemId(originalUrl) ?? '';

    return template
      .replaceAll('{master_ref}', encodeURIComponent(masterRef))
      .replaceAll('{url}', encodeURIComponent(originalUrl))
      .replaceAll('{sub_id}', encodeURIComponent(subId))
      .replaceAll('{item_id}', encodeURIComponent(itemId))
      .replaceAll('{merchant}', encodeURIComponent(merchant));
  }
}
