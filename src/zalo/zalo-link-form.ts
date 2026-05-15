import { createHmac, timingSafeEqual } from 'crypto';

import { ConfigService } from '@nestjs/config';

const LINK_FORM_PATH = '/api/zalo/link';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface ZaloLinkFormToken {
  chatId: string;
  zaloUserId: string;
  timestamp: string;
  signature: string;
}

export function buildZaloLinkFormUrl(
  config: ConfigService,
  input: { chatId: string; zaloUserId: string },
): string | null {
  const secret = getZaloLinkFormSecret(config);
  if (!secret) return null;

  const timestamp = String(Date.now());
  const signature = signZaloLinkForm(secret, {
    chatId: input.chatId,
    zaloUserId: input.zaloUserId,
    timestamp,
  });
  const base = resolveZaloPublicBaseUrl(config);
  const url = new URL(LINK_FORM_PATH, base);
  url.searchParams.set('c', input.chatId);
  url.searchParams.set('u', input.zaloUserId);
  url.searchParams.set('t', timestamp);
  url.searchParams.set('s', signature);
  return url.toString();
}

export function verifyZaloLinkFormToken(
  config: ConfigService,
  input: ZaloLinkFormToken,
): boolean {
  const secret = getZaloLinkFormSecret(config);
  if (!secret) return false;

  const timestamp = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > TOKEN_TTL_MS) return false;

  const expected = signZaloLinkForm(secret, input);
  return safeEqual(expected, input.signature);
}

function getZaloLinkFormSecret(config: ConfigService): string | null {
  return (
    config.get<string>('ZALO_LINK_FORM_SECRET')?.trim() ||
    config.get<string>('ZALO_SECRET_TOKEN')?.trim() ||
    null
  );
}

function resolveZaloPublicBaseUrl(config: ConfigService): string {
  return (
    config.get<string>('ZALO_PUBLIC_BASE_URL')?.trim() ||
    config.get<string>('TAOBAO_OPEN_BASE_URL')?.trim() ||
    config.get<string>('PUBLIC_BASE_URL')?.trim() ||
    'https://go.1688vn.com'
  ).replace(/\/+$/, '');
}

function signZaloLinkForm(
  secret: string,
  input: Pick<ZaloLinkFormToken, 'chatId' | 'zaloUserId' | 'timestamp'>,
): string {
  return createHmac('sha256', secret)
    .update(`${input.chatId}:${input.zaloUserId}:${input.timestamp}`)
    .digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
