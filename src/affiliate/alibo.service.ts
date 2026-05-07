import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Merchant, extractAlibabaItemId } from './url-detector';

/**
 * AliboService — wrap Taobao/Tmall/1688 link qua master account alibo.vn.
 *
 * Vì alibo.vn không có public API, có 2 chế độ:
 *
 *   Chế độ 1 (default) — TEMPLATE-BASED:
 *     Dùng URL template trong env ALIBO_LINK_TEMPLATE.
 *     Bot wrap link Taobao bằng template, sub_id để tracking local.
 *     User mua → alibo trả commission về master account → admin reconcile thủ công.
 *
 *   Chế độ 2 (planned) — PUPPETEER-BASED:
 *     Bot login alibo headless, tạo "link quảng cáo" qua web UI.
 *     Chậm hơn, fragile hơn, làm sau khi cần.
 *
 * Flow reconciliation:
 *   1. User click → Link row được tạo với network='alibo', alibaba_item_id, sub_id
 *   2. User mua → alibo dashboard hiển thị order
 *   3. Admin export report alibo → match theo (item_id, click time) → /admin_alibo_match
 *   4. Bot tạo Transaction → cộng pending balance cho user
 *
 * Quan trọng: phải verify ToS alibo trước khi go-live.
 */
@Injectable()
export class AliboService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('ALIBO_MASTER_REF')?.trim() &&
        this.config.get<string>('ALIBO_LINK_TEMPLATE')?.trim(),
    );
  }

  /**
   * Build link cashback wrap qua alibo master account.
   *
   * Template hỗ trợ placeholders:
   *   {master_ref}  — tài khoản master alibo.vn của bot
   *   {url}         — original Taobao/Tmall/1688 URL (đã encode)
   *   {sub_id}      — tracking id local của bot
   *   {item_id}     — Taobao item id (nếu detect được)
   *   {merchant}    — taobao | tmall | alibaba_1688
   *
   * Ví dụ template (bạn sẽ verify với alibo dashboard):
   *   https://alibo.vn/r/{master_ref}?u={url}&s={sub_id}
   *   https://alibo.vn/go?aff={master_ref}&item={item_id}&utm={sub_id}
   */
  buildLink(originalUrl: string, subId: string, merchant: Merchant): string {
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

  /**
   * Tỷ lệ chia % cho user khi cashback từ alibo.
   * Alibo cắt phần trước khi đến bot, nên rate có thể khác Accesstrade.
   * Default 60% (giảm so với 70% AT vì alibo ăn margin).
   */
  getUserRate(): number {
    return parseInt(
      this.config.get<string>('ALIBO_DEFAULT_USER_RATE', '60'),
      10,
    );
  }

  /**
   * Cảnh báo extra cho user khi mua qua Taobao/1688.
   * Hiển thị kèm link cashback.
   */
  getUserNotice(): string {
    return [
      '⚠️ Lưu ý hàng Trung Quốc:',
      '• Cashback Taobao/1688 cần đối soát thủ công, mất 7-30 ngày sau khi đơn giao thành công.',
      '• Cần đặt qua dịch vụ vận chuyển/order hộ. ChotDeal không vận chuyển hộ.',
      '• Bạn cần lưu mã đơn dịch vụ để hỗ trợ tra cứu khi cần.',
    ].join('\n');
  }
}
