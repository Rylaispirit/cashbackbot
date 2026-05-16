/**
 * Product metadata helpers for Alibo auto-match.
 *
 * Three signals captured at link creation:
 *   1. canonicalUrl    — resolved Taobao URL (follows e.tb.cn / tb.cn redirects)
 *   2. canonicalItemId — numeric itemId extracted from canonical
 *   3. aliboEncodedId  — encoded `id` from alibo's response (uland.taobao.com/item/edetail?id=XXX)
 *
 * These power the 3-tier match strategy in AliboOrdersService.evaluateMatch:
 *   - HIGH-1: aliboEncodedId exact match (zero ambiguity)
 *   - HIGH-2: canonicalItemId numeric match (works when alibo's itemLink is canonical too)
 *   - HIGH-3: fuzzy title match (productTitle vs alibo's itemTitle)
 */

import { extractAlibabaItemId } from './url-detector';

const SHORT_URL_HOSTS = new Set(['e.tb.cn', 'tb.cn', 'm.tb.cn', 's.click.taobao.com']);

/**
 * Follow short-URL redirects to canonical form. Best-effort: returns input on any failure.
 * Uses fetch with `redirect: 'follow'` plus a fallback meta-refresh / JS-redirect parser
 * because Taobao's short URLs often respond 200 OK with an HTML redirect.
 *
 * Timeout: 5s — never block link creation more than that.
 */
export async function resolveCanonicalUrl(
  rawUrl: string,
  timeoutMs = 5000,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // If already canonical (item.taobao.com / detail.tmall.com / 1688.com with numeric id), pass through
  if (extractAlibabaItemId(url.toString())) return url.toString();

  // Only attempt resolution for known short-URL hosts
  if (!SHORT_URL_HOSTS.has(url.hostname.toLowerCase())) return url.toString();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile',
      },
    });
    // If fetch followed redirects → res.url is final
    if (res.url && res.url !== url.toString() && extractAlibabaItemId(res.url)) {
      return res.url;
    }
    // Otherwise parse body for meta-refresh / location.replace
    const text = await res.text();
    const metaRefresh = text.match(
      /<meta[^>]+http-equiv=['"]refresh['"][^>]+content=['"][^;]+;\s*url=([^'"]+)['"]/i,
    );
    if (metaRefresh?.[1]) {
      const resolved = new URL(metaRefresh[1], res.url).toString();
      if (extractAlibabaItemId(resolved)) return resolved;
    }
    const jsLoc = text.match(
      /(?:location\.(?:href|replace)\s*=\s*|window\.location\s*=\s*)['"]([^'"]+)['"]/,
    );
    if (jsLoc?.[1]) {
      const resolved = new URL(jsLoc[1], res.url).toString();
      if (extractAlibabaItemId(resolved)) return resolved;
    }
    // og:url meta as last resort
    const ogUrl = text.match(/<meta[^>]+property=['"]og:url['"][^>]+content=['"]([^'"]+)['"]/i);
    if (ogUrl?.[1] && extractAlibabaItemId(ogUrl[1])) return ogUrl[1];
    return res.url || url.toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract encoded `id` from alibo's uland.taobao.com/item/edetail?id=XXX response URL.
 * Returns null if URL doesn't match the pattern.
 */
export function extractAliboEncodedId(affiliateUrl: string): string | null {
  if (!affiliateUrl) return null;
  try {
    const u = new URL(affiliateUrl);
    // Direct: uland.taobao.com/item/edetail?id=xyz
    if (u.hostname.endsWith('uland.taobao.com') || u.hostname.endsWith('taobao.com')) {
      const id = u.searchParams.get('id') ?? u.searchParams.get('itemId');
      if (id && !/^\d+$/.test(id)) {
        // Encoded id (non-numeric)
        return id;
      }
    }
    // Some alibo deeplinks wrap the uland URL as a redirect param
    for (const key of ['url', 'redirect', 'target', 'sourceUrl']) {
      const wrapped = u.searchParams.get(key);
      if (wrapped) {
        const inner = extractAliboEncodedId(wrapped);
        if (inner) return inner;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a product title for fuzzy comparison:
 *   - Lowercase
 *   - Strip Vietnamese diacritics
 *   - Remove non-alphanumeric (keeps CJK)
 *   - Collapse whitespace
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard similarity over normalized tokens. Returns 0..1.
 * Words shorter than 2 chars are dropped (noise reduction).
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  const setA = new Set(na.split(/\s+/).filter((t) => t.length >= 2));
  const setB = new Set(nb.split(/\s+/).filter((t) => t.length >= 2));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
