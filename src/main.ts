import type { NextFunction, Request, Response } from 'express';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getBotToken } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';

import { AppModule } from './app.module';

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

  const bot = app.get<Telegraf<Context>>(getBotToken());
  const updatesMode = resolveTelegramUpdatesMode(
    process.env.TELEGRAM_UPDATES_MODE,
    process.env.NODE_ENV,
  );
  const port = parsePort(process.env.PORT);

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
      webhookHandler = await bot.createWebhook({
        domain: publicBaseUrl,
        path: webhookPath,
        secret_token: webhookSecretToken,
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

function parsePort(rawPort: string | undefined): number {
  const port = rawPort ? parseInt(rawPort, 10) : 3000;
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

bootstrap().catch((err) => {
  console.error('Failed to bootstrap', err);
  process.exit(1);
});
