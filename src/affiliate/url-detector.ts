/**
 * Detect merchant từ URL.
 * Trả null nếu không phải URL ecommerce mà bot hỗ trợ.
 *
 * Mapping merchant → network:
 *   - shopee, lazada, tiki, tiktok_shop  → Accesstrade
 *   - taobao, tmall, alibaba_1688        → Alibo.vn
 */
export type Merchant =
  | 'shopee'
  | 'lazada'
  | 'tiki'
  | 'tiktok_shop'
  | 'taobao'
  | 'tmall'
  | 'alibaba_1688';

export type Network = 'accesstrade' | 'alibo';

const MERCHANT_PATTERNS: Array<{ merchant: Merchant; patterns: RegExp[] }> = [
  {
    merchant: 'shopee',
    patterns: [/(^|\.)shopee\.vn/i, /(^|\.)shopee\.com/i, /(^|\.)shp\.ee/i],
  },
  {
    merchant: 'lazada',
    patterns: [/(^|\.)lazada\.vn/i, /(^|\.)lzd\.co/i],
  },
  {
    merchant: 'tiki',
    patterns: [/(^|\.)tiki\.vn/i],
  },
  {
    merchant: 'tiktok_shop',
    patterns: [
      /(^|\.)tiktok\.com\/.*\/product/i,
      /(^|\.)shop\.tiktok\.com\/.*\/product/i,
      /(^|\.)vt\.tiktok\.com/i,
    ],
  },
  // === Trung Quốc — qua alibo.vn ===
  {
    merchant: 'taobao',
    patterns: [
      /(^|\.)taobao\.com/i,
      /(^|\.)tb\.cn/i,
      /(^|\.)m\.taobao\.com/i,
      /(^|\.)world\.taobao\.com/i,
    ],
  },
  {
    merchant: 'tmall',
    patterns: [/(^|\.)tmall\.com/i, /(^|\.)tmall\.hk/i, /(^|\.)detail\.tmall/i],
  },
  {
    merchant: 'alibaba_1688',
    patterns: [/(^|\.)1688\.com/i, /(^|\.)m\.1688\.com/i],
  },
];

const SUPPORTED_BARE_HOSTS = [
  'shopee.vn',
  'shopee.com',
  'shp.ee',
  'vn.shp.ee',
  'lazada.vn',
  'lzd.co',
  'tiki.vn',
  'tiktok.com',
  'shop.tiktok.com',
  'vt.tiktok.com',
  'taobao.com',
  'tb.cn',
  'm.taobao.com',
  'world.taobao.com',
  'tmall.com',
  'tmall.hk',
  'detail.tmall.com',
  '1688.com',
  'm.1688.com',
];

/**
 * Map merchant → network để route sang affiliate service phù hợp.
 */
export function networkOf(m: Merchant): Network {
  switch (m) {
    case 'taobao':
    case 'tmall':
    case 'alibaba_1688':
      return 'alibo';
    default:
      return 'accesstrade';
  }
}

/**
 * Tìm URL đầu tiên trong text mà có thể nhận diện được merchant.
 */
export function extractFirstSupportedUrl(
  text: string,
): { url: string; merchant: Merchant } | null {
  const matches = extractUrlCandidates(text);

  for (const raw of matches) {
    // Trim trailing punctuation thường gặp
    const url = normalizeUrlCandidate(raw.replace(/[.,;:!?)\]]+$/, ''));
    const merchant = detectMerchant(url);
    if (merchant) return { url, merchant };
  }
  return null;
}

export function detectMerchant(url: string): Merchant | null {
  let host: string;
  try {
    host = new URL(normalizeUrlCandidate(url)).hostname;
  } catch {
    return null;
  }
  for (const { merchant, patterns } of MERCHANT_PATTERNS) {
    if (patterns.some((p) => p.test(host) || p.test(url))) {
      return merchant;
    }
  }
  return null;
}

function extractUrlCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const cleaned = value?.trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    candidates.push(cleaned);
  };

  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    push(match[0]);
  }

  const escapedHosts = SUPPORTED_BARE_HOSTS.map(escapeRegExp).join('|');
  const bareRegex = new RegExp(
    `(^|[\\s(])((?:www\\.)?(?:${escapedHosts})[^\\s<>"']*)`,
    'gi',
  );
  for (const match of text.matchAll(bareRegex)) {
    push(match[2]);
  }

  return candidates;
}

function normalizeUrlCandidate(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract product/item id từ URL Taobao/Tmall/1688 — dùng cho reconciliation.
 * Trả null nếu không tìm thấy.
 */
export function extractAlibabaItemId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Taobao: ?id=12345 hoặc /item/12345.html
    const idParam = parsed.searchParams.get('id') ?? parsed.searchParams.get('itemId');
    if (idParam && /^\d{6,}$/.test(idParam)) return idParam;
    const pathMatch = parsed.pathname.match(/(?:item|offer|detail)[\/=](\d{6,})/);
    if (pathMatch) return pathMatch[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Label tiếng Việt cho merchant — hiển thị trong message.
 */
export function labelMerchant(m: Merchant | string): string {
  switch (m) {
    case 'shopee':
      return 'Shopee';
    case 'lazada':
      return 'Lazada';
    case 'tiki':
      return 'Tiki';
    case 'tiktok_shop':
      return 'TikTok Shop';
    case 'taobao':
      return 'Taobao';
    case 'tmall':
      return 'Tmall';
    case 'alibaba_1688':
      return '1688';
    default:
      return String(m);
  }
}
