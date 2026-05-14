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

const WELCOME_MESSAGE = `🎯 Chào mừng bạn đến với ChotDeal!

Bot hoàn tiền cashback cho đơn Shopee, Lazada, Tiki, TikTok Shop, Taobao, 1688, Tmall.

📌 Cách dùng:
1. Copy link sản phẩm bất kỳ
2. Paste vào đây cho bot
3. Bot trả link cashback — mở link đó để mua
4. Đơn được duyệt → tiền tự về ví trong bot

🎮 Lệnh hữu ích:
/balance — xem số dư
/history — lịch sử giao dịch
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

    const message = update?.message;
    if (!message?.text || !message.from?.id || !message.chat?.id) {
      return { ok: true };
    }

    const chatId = String(message.chat.id);
    const zaloUserId = String(message.from.id);
    const text = String(message.text).trim();

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

    if (text.startsWith('/')) {
      return this.handleCommand(text, chatId, user.id);
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
      });
      const cashbackUrl = isAliboLink
        ? this.buildAliboOpenAppUrl(result.link.subId) ?? result.link.affiliateUrl
        : result.link.affiliateUrl;
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
      await this.zalo.sendMessage({ chatId: input.chatId, text: lines.join('\n') });
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
  ): Promise<{ ok: true }> {
    const cmd = text.split(/\s+/)[0]?.toLowerCase();

    if (cmd === '/start' || cmd === '/help') {
      await this.zalo.sendMessage({ chatId, text: WELCOME_MESSAGE });
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
