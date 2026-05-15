import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { UsersService } from '../users/users.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import {
  extractFirstSupportedUrl,
  labelMerchant,
  type Merchant,
  networkOf,
} from '../affiliate/url-detector';
import { RateLimitService } from '../telegram/rate-limit.service';
import { ZaloService } from './zalo.service';
import { ZaloUpdate } from './zalo.types';
import { buildZaloLinkFormUrl } from './zalo-link-form';

const WELCOME_MESSAGE = `🎯 Chào mừng bạn đến với ChotDeal!

Bot hoàn tiền cashback cho đơn Shopee, Lazada, Tiki, TikTok Shop, Taobao, 1688, Tmall.

📌 Cách gửi link:
1. Copy nguyên link sản phẩm từ Shopee/Lazada/Taobao
2. Dán vào chat này hoặc gõ /link để mở trang dán link
3. Bot trả link cashback — mở link đó để mua
4. Đơn được duyệt → tiền tự về ví trong bot

Nếu Zalo không cho bot đọc link trực tiếp, ChotDeal sẽ gửi trang dán link riêng. Bạn chỉ cần dán nguyên link vừa copy, không cần sửa hay bỏ https://.

🎮 Lệnh hữu ích:
/balance — xem số dư
/history — lịch sử giao dịch
/link — mở trang dán link khi Zalo không gửi link trong chat
/setbank — cài tài khoản nhận tiền (tạm thời qua Telegram)
/withdraw — yêu cầu rút tiền (tạm thời qua Telegram)
/help — xem lại hướng dẫn`;

@Controller('webhook/zalo')
export class ZaloController {
  private readonly logger = new Logger(ZaloController.name);
  private readonly secretToken: string | undefined;

  constructor(
    private readonly zalo: ZaloService,
    private readonly users: UsersService,
    private readonly affiliate: AffiliateService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {
    this.secretToken = this.config.get<string>('ZALO_SECRET_TOKEN');
    if (!this.secretToken) {
      this.logger.warn(
        'ZALO_SECRET_TOKEN trống — webhook KHÔNG được verify (CHỈ DÙNG DEV)',
      );
    }
  }

  @Post()
  @HttpCode(200)
  async handle(
    @Body() update: ZaloUpdate,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, string>,
    @Req() req: Request,
  ) {
    // Log raw payload + headers để debug shape thật (xoá sau khi verified)
    this.logger.log(
      `Zalo update: headers=${JSON.stringify(this.relevantHeaders(headers))} body=${JSON.stringify(update).slice(0, 400)}`,
    );

    // Verify secret token nếu config có
    if (this.secretToken) {
      const received = this.extractSecret(headers, query, update);
      if (received !== this.secretToken) {
        this.logger.warn(
          `Zalo webhook: secret mismatch (got=${received ? received.slice(0, 4) + '...' : 'null'})`,
        );
        throw new UnauthorizedException('Invalid secret token');
      }
    }

    const isUnsupportedMessage =
      update.event_name === 'message.unsupported.received';
    if (isUnsupportedMessage) {
      this.logger.warn(
        `[ZALO UNSUPPORTED] payload=${JSON.stringify(update).slice(0, 2000)}`,
      );
    }

    const message = update?.message;
    if (!message?.from?.id || !message.chat?.id) {
      return { ok: true };
    }

    const chatId = String(message.chat.id);
    const zaloUserId = String(message.from.id);
    const text = this.extractMessageText(update);

    // Rate limit
    if (!this.rateLimit.check(this.hashUserId(zaloUserId))) {
      await this.zalo.sendMessage({
        chatId,
        text: '⏳ Bạn đang thao tác quá nhanh. Đợi vài giây rồi thử lại.',
      });
      return { ok: true };
    }

    const user = await this.users.upsertZaloUser({
      zaloUserId,
      displayName: message.from.display_name,
    });

    if (!text) {
      await this.sendLinkFormInstruction({ chatId, zaloUserId, fromUnsupported: true });
      return { ok: true };
    }

    if (text.startsWith('/')) {
      return this.handleCommand(text, chatId, user.id, zaloUserId);
    }

    if (this.isLinkFormRequest(text)) {
      await this.sendLinkFormInstruction({ chatId, zaloUserId });
      return { ok: true };
    }

    const detected = extractFirstSupportedUrl(text);
    if (!detected) {
      await this.zalo.sendMessage({
        chatId,
        text: 'Mình không tìm thấy link sản phẩm hợp lệ. ChotDeal đang hỗ trợ: Shopee, Lazada, Tiki, TikTok Shop, Taobao, Tmall, 1688.',
      });
      return { ok: true };
    }

    await this.zalo.sendMessage({
      chatId,
      text: [
        `⏳ Đang tạo link cashback ${labelMerchant(detected.merchant)} cho bạn...`,
        networkOf(detected.merchant) === 'alibo'
          ? 'Quá trình này có thể mất 10-30 giây. Bot sẽ gửi link ngay khi tạo xong.'
          : 'Nếu hệ thống đối tác phản hồi chậm, bot vẫn sẽ gửi link sau khi tạo xong.',
      ].join('\n'),
    });

    void this.createAndSendAffiliateLink({
      chatId,
      originalUrl: detected.url,
      merchant: detected.merchant,
      userId: user.id,
    });

    return { ok: true };
  }

  private async createAndSendAffiliateLink(input: {
    chatId: string;
    originalUrl: string;
    merchant: Merchant;
    userId: string;
  }): Promise<void> {
    const isAliboLink = networkOf(input.merchant) === 'alibo';

    try {
      const result = await this.affiliate.createAffiliateLink({
        userId: input.userId,
        originalUrl: input.originalUrl,
        channel: 'zalo',
      });
      const cashbackUrl = isAliboLink
        ? this.buildAliboOpenAppUrl(result.link.subId) ?? result.link.affiliateUrl
        : this.buildOpenLinkUrl(result.link.subId) ?? result.link.affiliateUrl;
      const lines = [
        `🛒 Sàn: ${labelMerchant(input.merchant)}`,
        '',
        isAliboLink ? '📱 Link cashback mở app Taobao:' : '🔗 Link cashback của bạn:',
        cashbackUrl,
        '',
        isAliboLink
          ? 'Bấm link trên rồi chọn "Mở app Taobao". Hãy mua trong phiên đó để hệ thống tracking cashback.'
          : '⚠️ Mở link trên rồi mua hàng để bot tracking được.',
      ];
      if (result.notice) lines.push('', result.notice);
      const sent = await this.zalo.sendMessage({
        chatId: input.chatId,
        text: lines.join('\n'),
      });
      this.logger.log(
        `Zalo createAffiliateLink ok merchant=${input.merchant} subId=${result.link.subId} sent=${sent}`,
      );
    } catch (err) {
      this.logger.error(
        `Zalo createAffiliateLink failed: ${(err as Error).message}`,
      );
      await this.zalo.sendMessage({
        chatId: input.chatId,
        text: `❌ ${(err as Error).message}`,
      });
    }
  }

  private buildOpenLinkUrl(subId: string): string | null {
    const publicBaseUrl =
      this.config.get<string>('ZALO_PUBLIC_BASE_URL')?.trim() ||
      this.config.get<string>('TAOBAO_OPEN_BASE_URL')?.trim() ||
      this.config.get<string>('PUBLIC_BASE_URL')?.trim() ||
      'https://go.1688vn.com';

    try {
      const base = new URL(publicBaseUrl);
      base.pathname = `/api/open/link/${encodeURIComponent(subId)}`;
      base.search = '';
      base.hash = '';
      return base.toString();
    } catch {
      return null;
    }
  }

  private buildAliboOpenAppUrl(subId: string): string | null {
    const publicBaseUrl =
      this.config.get<string>('TAOBAO_OPEN_BASE_URL')?.trim() ||
      this.config.get<string>('PUBLIC_BASE_URL')?.trim() ||
      'https://go.1688vn.com';

    try {
      const base = new URL(publicBaseUrl);
      base.pathname = `/api/open/taobao/${encodeURIComponent(subId)}`;
      base.search = '';
      base.hash = '';
      return base.toString();
    } catch {
      return null;
    }
  }

  private async handleCommand(
    text: string,
    chatId: string,
    userId: string,
    zaloUserId: string,
  ): Promise<{ ok: true }> {
    const cmd = text.split(/\s+/)[0]?.toLowerCase();

    if (cmd === '/start' || cmd === '/help') {
      await this.zalo.sendMessage({ chatId, text: WELCOME_MESSAGE });
    } else if (cmd === '/link') {
      await this.sendLinkFormInstruction({ chatId, zaloUserId });
    } else if (cmd === '/balance') {
      const balance = await this.users.getBalanceSummary(userId);
      await this.zalo.sendMessage({
        chatId,
        text: [
          '💰 Số dư cashback của bạn',
          '',
          `✅ Có thể rút: ${formatVnd(balance.available)}`,
          `⏳ Đang chờ duyệt: ${formatVnd(balance.pending)}`,
          `📤 Đã rút: ${formatVnd(balance.totalPaidOut)}`,
        ].join('\n'),
      });
    } else if (cmd === '/setbank' || cmd === '/withdraw') {
      await this.zalo.sendMessage({
        chatId,
        text: 'Hiện tại /setbank và /withdraw chỉ chạy trên Telegram (@chotdeal_bot). Sắp ra mắt trên Zalo.',
      });
    } else if (cmd === '/history') {
      const transactions = await this.users.getTransactionHistory(userId, 5);
      if (transactions.length === 0) {
        await this.zalo.sendMessage({
          chatId,
          text: '📜 Chưa có giao dịch nào.',
        });
      } else {
        const lines = ['📜 Lịch sử 5 giao dịch gần nhất:', ''];
        for (const tx of transactions) {
          const merchant = tx.link?.merchant ?? '?';
          lines.push(
            `• ${tx.status} | ${merchant} | ${formatVnd(tx.userShare)} | ${tx.orderId}`,
          );
        }
        await this.zalo.sendMessage({ chatId, text: lines.join('\n') });
      }
    } else {
      await this.zalo.sendMessage({
        chatId,
        text: `Lệnh "${cmd}" chưa hỗ trợ. Gõ /help để xem danh sách lệnh.`,
      });
    }

    return { ok: true };
  }

  private async sendLinkFormInstruction(input: {
    chatId: string;
    zaloUserId: string;
    fromUnsupported?: boolean;
  }): Promise<void> {
    const formUrl = buildZaloLinkFormUrl(this.config, {
      chatId: input.chatId,
      zaloUserId: input.zaloUserId,
    });

    const lines = input.fromUnsupported
      ? [
          'Zalo không gửi nội dung link trực tiếp cho bot.',
          '',
          'Bấm trang dưới đây, dán nguyên link bạn vừa copy từ Shopee/Lazada/Taobao. Không cần bỏ https://.',
        ]
      : [
          'Bấm trang dưới đây để dán nguyên link sản phẩm.',
          'Bạn copy sao thì dán vậy, ChotDeal sẽ tự tạo link cashback.',
        ];

    if (formUrl) {
      lines.push(formUrl);
    } else {
      lines.push(
        '',
        'Hiện chưa tạo được trang dán link. Bạn thử gửi lại nguyên link sản phẩm một lần nữa.',
      );
    }

    await this.zalo.sendMessage({
      chatId: input.chatId,
      text: lines.join('\n'),
    });
  }

  private isLinkFormRequest(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return [
      'link',
      'tao link',
      'tạo link',
      'lay link',
      'lấy link',
      'dan link',
      'dán link',
    ].includes(normalized);
  }

  /**
   * Tìm secret token trong nhiều chỗ vì Zalo chưa public docs.
   * Đoán: có thể ở header, query, hoặc field trong body.
   */
  private extractSecret(
    headers: Record<string, string>,
    query: Record<string, string>,
    body: ZaloUpdate,
  ): string | null {
    return (
      headers['x-zalo-secret-token'] ??
      headers['x-bot-api-secret-token'] ??
      headers['x-secret-token'] ??
      headers['x-bot-secret'] ??
      headers['zalo-secret-token'] ??
      query.secret ??
      query.token ??
      (body as Record<string, unknown>).secret as string ??
      (body as Record<string, unknown>).secret_token as string ??
      null
    );
  }

  /**
   * Zalo co the gui link trong nhieu field khac nhau tuy loai message.
   * Neu user bam Share truc tiep, payload co the khong co text nao ca.
   */
  private extractMessageText(update: ZaloUpdate): string {
    const message = update.message as Record<string, unknown> | undefined;
    const payload = message?.payload as Record<string, unknown> | undefined;
    const candidates = [
      message?.text,
      message?.content,
      message?.caption,
      message?.description,
      payload?.text,
      payload?.url,
      (update as Record<string, unknown>).text,
      (update as Record<string, unknown>).content,
    ];

    candidates.push(...this.extractAttachmentTexts(message?.attachments));

    const text =
      candidates
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .find((value) => value.length > 0) ?? '';
    if (text) return text;

    return this.tryExtractEmbeddedUrl(update) ?? '';
  }

  private tryExtractEmbeddedUrl(update: ZaloUpdate): string | null {
    const raw = JSON.stringify(update);
    const match = raw.match(/https?:\/\/[^\s"'<>\\)]+/i);
    return match?.[0]?.replace(/[.,;:!?)\]]+$/, '') ?? null;
  }

  private extractAttachmentTexts(attachments: unknown): string[] {
    if (!Array.isArray(attachments)) return [];

    const texts: string[] = [];
    for (const item of attachments) {
      if (!item || typeof item !== 'object') continue;
      const attachment = item as Record<string, unknown>;
      const payload = attachment.payload as Record<string, unknown> | undefined;
      for (const value of [
        attachment.url,
        attachment.href,
        attachment.title,
        attachment.description,
        payload?.url,
        payload?.href,
        payload?.text,
        payload?.title,
        payload?.description,
      ]) {
        if (typeof value === 'string' && value.trim()) {
          texts.push(value.trim());
        }
      }
    }
    return texts;
  }

  /**
   * Filter relevant headers để log gọn (tránh spam). Mọi header bắt đầu bằng
   * x-, zalo-, hoặc liên quan auth.
   */
  private relevantHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (
        lower.startsWith('x-') ||
        lower.startsWith('zalo-') ||
        lower === 'authorization' ||
        lower === 'user-agent'
      ) {
        out[lower] = this.redactHeader(lower, v);
      }
    }
    return out;
  }

  private redactHeader(name: string, value: unknown): string {
    const text = typeof value === 'string' ? value : String(value);
    if (/secret|token|authorization/i.test(name)) {
      return text ? `${text.slice(0, 4)}...redacted` : '';
    }
    return text.slice(0, 80);
  }

  private hashUserId(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h << 5) - h + id.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }
}

function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')}đ`;
}
