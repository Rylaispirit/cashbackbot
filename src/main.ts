import type { NextFunction, Request, Response } from 'express';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getBotToken } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';

import { AppModule } from './app.module';
import {
  labelMerchant,
  renderOpenTaobaoPage,
  toTaobaoDeepLink,
} from './affiliate/alibo-open.controller';
import { PrismaService } from './prisma/prisma.service';

type TelegramUpdatesMode = 'polling' | 'webhook';
type TelegramWebhookHandler = (
  req: Request,
  res: Response,
  next?: NextFunction,
) => Promise<void>;

const BOOTSTRAP_LOGGER = 'Bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });

  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Postback from Accesstrade may hit "/" without a trailing slash.
  app.setGlobalPrefix('api', { exclude: ['/'] });
  registerTaobaoOpenBridge(app.getHttpAdapter().getInstance(), app.get(PrismaService));

  const bot = app.get<Telegraf<Context>>(getBotToken());
  const updatesMode = resolveTelegramUpdatesMode(
    process.env.TELEGRAM_UPDATES_MODE,
    process.env.NODE_ENV,
  );
  const port = parsePort(process.env.PORT, updatesMode);

  let afterListen: (() => Promise<void>) | null = null;

  if (updatesMode === 'webhook') {
    const publicBaseUrl = normalizePublicBaseUrl(
      requireEnv('PUBLIC_BASE_URL', updatesMode),
    );
    const webhookPath = normalizeWebhookPath(
      requireEnv('TELEGRAM_WEBHOOK_PATH', updatesMode),
    );
    const webhookSecretToken = requireEnv(
      'TELEGRAM_WEBHOOK_SECRET_TOKEN',
      updatesMode,
    );
    const webhookUrl = `${publicBaseUrl}${webhookPath}`;
    const postbackUrl = `${publicBaseUrl}/api/postback/accesstrade`;

    let webhookHandler: TelegramWebhookHandler | null = null;

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path !== webhookPath) {
        next();
        return;
      }

      if (
        isAdminMenuShortcutUpdate(req.body) &&
        isValidTelegramSecret(req, webhookSecretToken)
      ) {
        void handleAdminMenuShortcut(req.body, {
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          adminIdsRaw: process.env.TELEGRAM_ADMIN_IDS,
        })
          .then(() => res.status(200).json({ ok: true, shortcut: 'admin_menu' }))
          .catch(next);
        return;
      }

      if (!webhookHandler) {
        res.status(503).json({ ok: false, error: 'telegram_webhook_not_ready' });
        return;
      }

      void Promise.resolve(webhookHandler(req, res, next)).catch(next);
    });

    Logger.log(`Telegram updates mode: ${updatesMode}`, BOOTSTRAP_LOGGER);
    Logger.log(`Telegram webhook URL: ${webhookUrl}`, BOOTSTRAP_LOGGER);
    Logger.log(`Accesstrade postback URL: ${postbackUrl}`, BOOTSTRAP_LOGGER);

    afterListen = async () => {
      webhookHandler = await createTelegramWebhookWithRetry(bot, {
        domain: publicBaseUrl,
        path: webhookPath,
        secretToken: webhookSecretToken,
      });
      Logger.log('Telegram webhook is active', BOOTSTRAP_LOGGER);
    };
  }

  Logger.log(`Starting HTTP server on 0.0.0.0:${port}`, BOOTSTRAP_LOGGER);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Cashback bot listening on 0.0.0.0:${port}`, BOOTSTRAP_LOGGER);

  if (afterListen) {
    void afterListen().catch((err) => {
      Logger.error(
        `Telegram webhook setup failed: ${(err as Error).message}`,
        (err as Error).stack,
        BOOTSTRAP_LOGGER,
      );
    });
    return;
  }

  await bot.launch();
  registerPollingShutdown(bot);
  Logger.log(`Telegram updates mode: ${updatesMode}`, BOOTSTRAP_LOGGER);
  Logger.log('Telegram polling is active', BOOTSTRAP_LOGGER);
}

async function createTelegramWebhookWithRetry(
  bot: Telegraf<Context>,
  options: { domain: string; path: string; secretToken: string },
): Promise<TelegramWebhookHandler> {
  const maxAttempts = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await bot.createWebhook({
        domain: options.domain,
        path: options.path,
        secret_token: options.secretToken,
      });
    } catch (err) {
      lastError = err;
      const retryAfterSeconds = getTelegramRetryAfterSeconds(err);
      const delayMs = retryAfterSeconds
        ? (retryAfterSeconds + 1) * 1000
        : attempt * 1000;

      if (attempt >= maxAttempts) break;

      Logger.warn(
        `Telegram webhook setup attempt ${attempt}/${maxAttempts} failed: ${
          (err as Error).message
        }. Retrying in ${delayMs}ms`,
        BOOTSTRAP_LOGGER,
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Telegram webhook setup failed');
}

function getTelegramRetryAfterSeconds(err: unknown): number | null {
  const maybe = err as {
    parameters?: { retry_after?: number };
    response?: { parameters?: { retry_after?: number } };
    message?: string;
  };
  const fromParameters =
    maybe.parameters?.retry_after ?? maybe.response?.parameters?.retry_after;
  if (typeof fromParameters === 'number' && Number.isFinite(fromParameters)) {
    return fromParameters;
  }

  const match = maybe.message?.match(/retry after (\d+)/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTelegramUpdatesMode(
  rawMode: string | undefined,
  nodeEnv: string | undefined,
): TelegramUpdatesMode {
  const mode = rawMode?.trim().toLowerCase();
  if (!mode) {
    return nodeEnv === 'production' ? 'webhook' : 'polling';
  }
  if (mode === 'polling' || mode === 'webhook') {
    return mode;
  }
  throw new Error(
    `TELEGRAM_UPDATES_MODE must be "polling" or "webhook", received "${rawMode}"`,
  );
}

function parsePort(rawPort: string | undefined, updatesMode: TelegramUpdatesMode): number {
  const defaultPort = updatesMode === 'webhook' ? 8080 : 3000;
  const port = rawPort ? parseInt(rawPort, 10) : defaultPort;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return port;
}

function requireEnv(
  name: string,
  updatesMode: TelegramUpdatesMode,
): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when TELEGRAM_UPDATES_MODE=${updatesMode}`);
  }
  return value;
}

function normalizePublicBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be a valid absolute URL, received "${rawUrl}"`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `PUBLIC_BASE_URL must start with http:// or https://, received "${rawUrl}"`,
    );
  }

  return rawUrl.replace(/\/+$/, '');
}

function normalizeWebhookPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(
      `TELEGRAM_WEBHOOK_PATH must start with "/", received "${rawPath}"`,
    );
  }

  return trimmed;
}

function registerPollingShutdown(bot: Telegraf<Context>): void {
  const stopBot = (reason: string) => {
    try {
      bot.stop(reason);
      Logger.log(`Telegram polling stopped (${reason})`, BOOTSTRAP_LOGGER);
    } catch (err) {
      Logger.warn(
        `Telegram polling stop skipped (${reason}): ${(err as Error).message}`,
        BOOTSTRAP_LOGGER,
      );
    }
  };

  process.once('SIGINT', () => stopBot('SIGINT'));
  process.once('SIGTERM', () => stopBot('SIGTERM'));
}

function registerTaobaoOpenBridge(expressApp: {
  get: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void;
}, prisma: PrismaService): void {
  expressApp.get(
    '/api/open/taobao/:subId',
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const subId = String(req.params.subId ?? '').trim();
        const link = await prisma.link.findUnique({
          where: { subId },
          select: {
            affiliateUrl: true,
            merchant: true,
            network: true,
          },
        });

        if (!link || link.network !== 'alibo') {
          res.status(404).json({
            message: 'Link cashback không tồn tại',
            error: 'Not Found',
            statusCode: 404,
          });
          return;
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
      })().catch(next);
    },
  );
  Logger.log('Taobao open bridge route mounted at /api/open/taobao/:subId', BOOTSTRAP_LOGGER);
}

function isValidTelegramSecret(req: Request, expected: string): boolean {
  const received = req.headers['x-telegram-bot-api-secret-token'];
  return typeof received === 'string' && received === expected;
}

function isAdminMenuShortcutUpdate(update: unknown): boolean {
  const message = (update as {
    message?: {
      text?: string;
    };
  })?.message;
  const command = message?.text
    ?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i)?.[1]
    ?.toLowerCase();
  return command === 'admin';
}

async function handleAdminMenuShortcut(
  update: unknown,
  options: {
    botToken: string | undefined;
    adminIdsRaw: string | undefined;
  },
): Promise<void> {
  const message = (update as {
    message?: {
      chat?: { id?: string | number };
      from?: { id?: string | number };
    };
  })?.message;

  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (!chatId || !fromId || !options.botToken) return;

  const adminIds = new Set(
    (options.adminIdsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const text = adminIds.has(String(fromId))
    ? buildAdminMenuMessage()
    : [
        'Bạn chưa có quyền dùng lệnh admin trên Telegram.',
        'Nếu đây là tài khoản admin, hãy kiểm tra TELEGRAM_ADMIN_IDS.',
      ].join('\n');

  await sendTelegramMessage(options.botToken, chatId, text);
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string | number,
  text: string,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }
}

function buildAdminMenuMessage(): string {
  return [
    'Admin commands:',
    '/admin_stats - tổng quan',
    '/admin_links - 10 link mới nhất',
    '/admin_link <sub_id> - chi tiết 1 link',
    '/admin_recent - 10 đơn gần nhất',
    '/admin_payouts - list payout pending',
    '/admin_paid <id> - mark payout đã chuyển',
    '/admin_cancel <id> - huỷ payout',
    '/admin_user <telegram_id>',
    '/admin_block <telegram_id>',
    '/admin_unblock <telegram_id>',
    '/admin_broadcast_test <nội dung> - gửi thử cho admin',
    '/admin_broadcast <nội dung> - gửi thông báo tới toàn bộ user',
    '/admin_deal_test <url> | <tiêu đề> | <mô tả> - gửi thử deal cho admin',
    '/admin_deal <url> | <tiêu đề> | <mô tả> - gửi deal tới subscriber',
    '/admin_deal_send <deal_id> - gửi deal đã tạo từ bản test',
    '/admin_deals - 10 deal gần nhất',
    '/admin_deal_subscribers - số người đang bật nhận deal',
    '/admin_scan_deals [limit] - quét deal Shopee từ Accesstrade',
    '',
    'Alibo sync:',
    '/admin_alibo_auto_match [days] [dry|apply] - auto-match HIGH-confidence orders',
    '/admin_alibo_sync [days] - sync đơn từ trang Alibo',
    '/admin_alibo_orders [unmatched|matched|all] - xem đơn Alibo đã sync',
    '/admin_alibo_order <id> - chi tiết 1 đơn Alibo',
    '/admin_alibo_match_order <order_prefix> <subId_prefix> [status] [commission_vnd] - match đơn sync vào user',
    '',
    'Reconcile alibo:',
    '/admin_alibo_pending - link Taobao chưa có đơn',
    '/admin_alibo_match <subId_prefix> <orderId> <commission_report> [sale] [status] - tạo đơn manual',
  ].join('\n');
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap', err);
  process.exit(1);
});
