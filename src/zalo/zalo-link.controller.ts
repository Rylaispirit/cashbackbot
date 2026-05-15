import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { AffiliateService } from '../affiliate/affiliate.service';
import {
  extractFirstSupportedUrl,
  labelMerchant,
  networkOf,
} from '../affiliate/url-detector';
import { UsersService } from '../users/users.service';
import { ZaloService } from './zalo.service';
import { verifyZaloLinkFormToken } from './zalo-link-form';

@Controller('zalo/link')
export class ZaloLinkController {
  private readonly logger = new Logger(ZaloLinkController.name);

  constructor(
    private readonly affiliate: AffiliateService,
    private readonly users: UsersService,
    private readonly zalo: ZaloService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async form(
    @Query('c') chatId: string,
    @Query('u') zaloUserId: string,
    @Query('t') timestamp: string,
    @Query('s') signature: string,
    @Res() res: Response,
  ) {
    this.assertValidToken({ chatId, zaloUserId, timestamp, signature });
    res.type('html').send(
      renderZaloLinkForm({
        chatId,
        zaloUserId,
        timestamp,
        signature,
      }),
    );
  }

  @Post()
  @HttpCode(200)
  async submit(
    @Body('url') rawUrl: string,
    @Body('c') chatId: string,
    @Body('u') zaloUserId: string,
    @Body('t') timestamp: string,
    @Body('s') signature: string,
    @Res() res: Response,
  ) {
    this.assertValidToken({ chatId, zaloUserId, timestamp, signature });

    const detected = extractFirstSupportedUrl(String(rawUrl ?? '').trim());
    if (!detected) {
      res.status(400).type('html').send(
        renderZaloLinkForm({
          chatId,
          zaloUserId,
          timestamp,
          signature,
          error:
            'Mình chưa nhận ra link này. Hãy dán link Shopee, Lazada, Tiki, TikTok Shop, Taobao, Tmall hoặc 1688.',
          value: rawUrl ?? '',
        }),
      );
      return;
    }

    try {
      const user = await this.users.upsertZaloUser({ zaloUserId });
      const result = await this.affiliate.createAffiliateLink({
        userId: user.id,
        originalUrl: detected.url,
        channel: 'zalo',
      });
      const isAliboLink = networkOf(detected.merchant) === 'alibo';
      const cashbackUrl = isAliboLink
        ? this.buildAliboOpenAppUrl(result.link.subId) ?? result.link.affiliateUrl
        : this.buildOpenLinkUrl(result.link.subId) ?? result.link.affiliateUrl;
      const message = [
        `🛒 Sàn: ${labelMerchant(detected.merchant)}`,
        '',
        isAliboLink ? '📱 Link cashback mở app Taobao:' : '🔗 Link cashback của bạn:',
        cashbackUrl,
        '',
        isAliboLink
          ? 'Bấm link trên rồi chọn "Mở app Taobao". Hãy mua trong phiên đó để hệ thống tracking cashback.'
          : '⚠️ Mở link trên rồi mua hàng để bot tracking được cashback.',
        result.notice ? `\n${result.notice}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const sent = await this.zalo.sendMessage({ chatId, text: message });
      this.logger.log(
        `Zalo link form created merchant=${detected.merchant} subId=${result.link.subId} sent=${sent}`,
      );
      if (!sent) {
        this.logger.warn(`Zalo form created link but send failed chat=${chatId}`);
      }

      res.type('html').send(
        renderZaloLinkSuccess({
          merchant: labelMerchant(detected.merchant),
          cashbackUrl,
          sent,
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Zalo link form failed: ${message}`);
      await this.zalo
        .sendMessage({ chatId, text: `❌ ${message}` })
        .catch(() => undefined);
      res.status(500).type('html').send(
        renderZaloLinkForm({
          chatId,
          zaloUserId,
          timestamp,
          signature,
          error: message,
          value: rawUrl ?? '',
        }),
      );
    }
  }

  private assertValidToken(input: {
    chatId?: string;
    zaloUserId?: string;
    timestamp?: string;
    signature?: string;
  }): void {
    const chatId = input.chatId?.trim();
    const zaloUserId = input.zaloUserId?.trim();
    const timestamp = input.timestamp?.trim();
    const signature = input.signature?.trim();
    if (!chatId || !zaloUserId || !timestamp || !signature) {
      throw new UnauthorizedException('Invalid Zalo link form token');
    }
    const ok = verifyZaloLinkFormToken(this.config, {
      chatId,
      zaloUserId,
      timestamp,
      signature,
    });
    if (!ok) throw new UnauthorizedException('Invalid Zalo link form token');
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
}

function renderZaloLinkForm(input: {
  chatId: string;
  zaloUserId: string;
  timestamp: string;
  signature: string;
  error?: string;
  value?: string;
}): string {
  const error = input.error
    ? `<div class="error">${escapeHtml(input.error)}</div>`
    : '';
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dán link cashback | ChotDeal</title>
  ${renderStyle()}
</head>
<body>
  <main>
    <div class="pill">ChotDeal x Zalo</div>
    <h1>Dán link để lấy cashback</h1>
    <p>Dán nguyên link bạn vừa copy từ Shopee/Lazada/Taobao. Không cần sửa link hay bỏ https://, ChotDeal sẽ tự tạo link cashback và gửi kết quả về lại Zalo.</p>
    ${error}
    <form method="post" action="/api/zalo/link">
      <input type="hidden" name="c" value="${escapeAttr(input.chatId)}">
      <input type="hidden" name="u" value="${escapeAttr(input.zaloUserId)}">
      <input type="hidden" name="t" value="${escapeAttr(input.timestamp)}">
      <input type="hidden" name="s" value="${escapeAttr(input.signature)}">
      <label for="url">Link sản phẩm</label>
      <textarea id="url" name="url" rows="5" autofocus placeholder="Dán nguyên link ở đây, ví dụ: https://vn.shp.ee/...">${escapeHtml(input.value ?? '')}</textarea>
      <button type="submit">Tạo link cashback</button>
    </form>
    <small>Hỗ trợ Shopee, Lazada, Tiki, TikTok Shop, Taobao, Tmall và 1688.</small>
  </main>
</body>
</html>`;
}

function renderZaloLinkSuccess(input: {
  merchant: string;
  cashbackUrl: string;
  sent: boolean;
}): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Đã tạo link | ChotDeal</title>
  ${renderStyle()}
</head>
<body>
  <main>
    <div class="pill">Hoàn tất</div>
    <h1>Link cashback đã sẵn sàng</h1>
    <p>Sàn: <b>${escapeHtml(input.merchant)}</b></p>
    <p>${input.sent ? 'Mình đã gửi link về Zalo cho bạn.' : 'Mình tạo được link nhưng chưa gửi được về Zalo, bạn có thể mở link bên dưới.'}</p>
    <a class="button" href="${escapeAttr(input.cashbackUrl)}">Mở link cashback</a>
    <small>Hãy mua trong phiên vừa mở để hệ thống tracking cashback đúng.</small>
  </main>
</body>
</html>`;
}

function renderStyle(): string {
  return `<style>
    :root { --bg:#fff7ed; --card:#fff; --ink:#1f1308; --muted:#765b48; --accent:#f97316; --dark:#9a3412; --line:#fed7aa; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:22px; font-family:"Segoe UI",Arial,sans-serif; color:var(--ink); background:radial-gradient(circle at 20% 10%,#fde68a 0,transparent 28%),linear-gradient(145deg,var(--bg),#fff); }
    main { width:min(100%,460px); padding:26px; border:1px solid var(--line); border-radius:28px; background:rgba(255,255,255,.96); box-shadow:0 24px 70px rgba(154,52,18,.16); }
    .pill { display:inline-flex; padding:8px 12px; border-radius:999px; background:#ffedd5; color:var(--dark); font-size:13px; font-weight:800; }
    h1 { margin:18px 0 10px; font-size:32px; line-height:1.02; letter-spacing:-.04em; }
    p, small { color:var(--muted); line-height:1.55; }
    label { display:block; margin:18px 0 8px; font-weight:750; }
    textarea { width:100%; padding:14px; border:1px solid var(--line); border-radius:18px; font:inherit; resize:vertical; outline:none; }
    textarea:focus { border-color:var(--accent); box-shadow:0 0 0 4px rgba(249,115,22,.14); }
    button, .button { display:block; width:100%; margin-top:14px; padding:15px 18px; border:0; border-radius:18px; color:#fff; background:linear-gradient(135deg,var(--accent),var(--dark)); font:inherit; font-weight:800; text-align:center; text-decoration:none; cursor:pointer; }
    .error { margin:16px 0 0; padding:12px 14px; border-radius:16px; background:#fee2e2; color:#991b1b; line-height:1.45; }
    small { display:block; margin-top:16px; }
  </style>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
