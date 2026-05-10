import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service';

@Controller('open')
export class AliboOpenController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('taobao/:subId')
  async openTaobao(@Param('subId') subId: string, @Res() res: Response) {
    const link = await this.prisma.link.findUnique({
      where: { subId },
      select: {
        affiliateUrl: true,
        merchant: true,
        network: true,
      },
    });

    if (!link || link.network !== 'alibo') {
      throw new NotFoundException('Link cashback không tồn tại');
    }

    const deepLink = toTaobaoDeepLink(link.affiliateUrl);
    if (!deepLink) {
      res.redirect(302, link.affiliateUrl);
      return;
    }

    res
      .type('html')
      .send(renderOpenTaobaoPage({
        deepLink,
        fallbackUrl: link.affiliateUrl,
        merchant: labelMerchant(link.merchant),
      }));
  }
}

export function toTaobaoDeepLink(affiliateUrl: string): string | null {
  try {
    const parsed = new URL(affiliateUrl);
    if (!isTaobaoFamilyHost(parsed.hostname)) return null;

    // The Alibo API may return either s.click.taobao.com or uland.taobao.com.
    // Use Taobao's H5 bridge so coupon/detail URLs open in the Taobao app
    // instead of letting the mobile browser guess a handler.
    return `tbopen://m.taobao.com/tbopen/index.html?action=ali.open.nav&module=h5&bootImage=0&source=chotdeal&h5Url=${encodeURIComponent(
      parsed.toString(),
    )}`;
  } catch {
    return null;
  }
}

function isTaobaoFamilyHost(hostname: string): boolean {
  return (
    /(^|\.)taobao\.com$/i.test(hostname) ||
    /(^|\.)tmall\.com$/i.test(hostname) ||
    /(^|\.)1688\.com$/i.test(hostname) ||
    /(^|\.)tb\.cn$/i.test(hostname)
  );
}

export function renderOpenTaobaoPage(input: {
  deepLink: string;
  fallbackUrl: string;
  merchant: string;
}): string {
  const deepLink = escapeAttr(input.deepLink);
  const fallbackUrl = escapeAttr(input.fallbackUrl);
  const merchant = escapeHtml(input.merchant);

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mở app ${merchant} | ChotDeal</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff8ed;
      --card: #ffffff;
      --ink: #20130a;
      --muted: #745c4a;
      --accent: #f97316;
      --accent-dark: #b93808;
      --gold: #facc15;
      --cream: #fff3d8;
      --line: #fed7aa;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 22px;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background:
        radial-gradient(circle at 18% 12%, rgba(250, 204, 21, 0.42) 0, transparent 26%),
        radial-gradient(circle at 84% 10%, rgba(249, 115, 22, 0.24) 0, transparent 26%),
        linear-gradient(145deg, var(--bg), #fffdf4 52%, #ffedd5);
      color: var(--ink);
    }
    main {
      width: min(100%, 440px);
      position: relative;
      overflow: hidden;
      padding: 26px;
      border: 1px solid var(--line);
      border-radius: 30px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,250,240,0.96)),
        var(--card);
      box-shadow: 0 26px 90px rgba(185, 56, 8, 0.18);
    }
    main::before {
      content: "";
      position: absolute;
      width: 190px;
      height: 190px;
      right: -80px;
      top: -78px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(249, 115, 22, 0.24), transparent 68%);
      pointer-events: none;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--accent-dark);
      background: rgba(255, 247, 237, 0.86);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .hero {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 18px;
      align-items: center;
      margin: 20px 0 18px;
    }
    .icon {
      width: 86px;
      height: 86px;
      display: grid;
      place-items: center;
      border-radius: 26px;
      background:
        linear-gradient(145deg, #ffedd5, #fdba74);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 18px 38px rgba(249, 115, 22, 0.28);
      font-size: 42px;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 8vw, 40px);
      line-height: 0.98;
      letter-spacing: -0.05em;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.55;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 18px 0;
    }
    .step {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 12px;
      border: 1px solid #fed7aa;
      border-radius: 18px;
      background: rgba(255, 247, 237, 0.72);
      color: #4b3423;
      font-size: 14px;
      line-height: 1.45;
    }
    .step b {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      color: white;
      background: var(--accent);
      font-size: 13px;
    }
    a.button, button {
      display: block;
      width: 100%;
      margin-top: 12px;
      padding: 16px 18px;
      border: 0;
      border-radius: 18px;
      font: inherit;
      font-weight: 750;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      transition: transform 150ms ease, box-shadow 150ms ease;
    }
    a.button:active, button:active {
      transform: translateY(1px) scale(0.99);
    }
    a.primary {
      color: white;
      background: linear-gradient(135deg, var(--accent), var(--accent-dark));
      box-shadow: 0 16px 34px rgba(249, 115, 22, 0.34);
    }
    a.secondary, button {
      color: var(--accent-dark);
      background: var(--cream);
    }
    small {
      display: block;
      margin-top: 18px;
      color: var(--muted);
      line-height: 1.45;
    }
    .trust {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 16px;
      background: #fff7ed;
      color: #7c4a1f;
      font-size: 13px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">ChotDeal Cashback</div>
    <section class="hero">
      <h1>Mở app ${merchant}</h1>
      <div class="icon" aria-hidden="true">🛍️</div>
    </section>
    <p>ChotDeal đang chuyển bạn sang ${merchant}. Hãy mua trong phiên vừa mở để hệ thống giữ tracking cashback.</p>
    <a class="button primary" id="open-app" href="${deepLink}">Mở app ${merchant}</a>
    <a class="button secondary" href="${fallbackUrl}">Mở bằng trình duyệt</a>
    <button id="copy-link" type="button">Copy link mở app</button>
    <div class="steps">
      <div class="step"><b>1</b><span>Nếu điện thoại hỏi xác nhận, chọn <strong>Mở</strong> hoặc <strong>Open</strong>.</span></div>
      <div class="step"><b>2</b><span>Nếu app chưa bật, bấm lại nút <strong>Mở app ${merchant}</strong>.</span></div>
      <div class="step"><b>3</b><span>Không đóng phiên giữa chừng trước khi đặt hàng để tránh mất cashback.</span></div>
    </div>
    <div class="trust">Đơn có thể mất vài phút đến 72h mới được hệ thống Cashback ghi nhận trong lịch sử.</div>
    <small id="hint">Telegram đôi khi chặn mở app tự động. Thao tác bấm nút trực tiếp thường ổn định hơn.</small>
  </main>
  <script>
    const deepLink = ${JSON.stringify(input.deepLink)};
    const fallbackUrl = ${JSON.stringify(input.fallbackUrl)};
    const copyButton = document.getElementById('copy-link');

    copyButton?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(deepLink);
        copyButton.textContent = 'Đã copy - hãy mở app Taobao';
      } catch {
        copyButton.textContent = 'Không copy được, hãy bấm Mở app';
      }
    });

    setTimeout(() => {
      window.location.href = deepLink;
    }, 300);

    setTimeout(() => {
      const hint = document.getElementById('hint');
      if (hint) {
        hint.textContent = 'Nếu app chưa mở, bấm "Mở app" hoặc copy link rồi mở app Taobao.';
      }
    }, 1800);
  </script>
</body>
</html>`;
}

export function labelMerchant(merchant: string): string {
  switch (merchant) {
    case 'tmall':
      return 'Tmall';
    case 'alibaba_1688':
      return '1688';
    default:
      return 'Taobao';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
