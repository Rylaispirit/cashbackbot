/**
 * Detect merchant from URL.
 * Trả về null nếu không phải URL ecommerce mà bot hỗ trợ.
 */
export type Merchant = 'shopee' | 'lazada' | 'tiki' | 'tiktok_shop';

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
    patterns: [/(^|\.)tiktok\.com\/.*\/product/i, /(^|\.)vt\.tiktok\.com/i],
  },
];

/**
 * Tìm URL đầu tiên trong text mà có thể nhận diện được merchant.
 * Telegram thường gửi link kèm message text nên mình phải scan toàn message.
 */
export function extractFirstSupportedUrl(text: string): { url: string; merchant: Merchant } | null {
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const matches = text.match(urlRegex);
  if (!matches) return null;

  for (const raw of matches) {
    // Trim trailing punctuation thường thấy trong tin nhắn
    const url = raw.replace(/[.,;:!?)\]]+$/, '');
    const merchant = detectMerchant(url);
    if (merchant) return { url, merchant };
  }
  return null;
}

export function detectMerchant(url: string): Merchant | null {
  let host: string;
  try {
    host = new URL(url).hostname;
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
