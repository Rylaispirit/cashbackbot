import 'dotenv/config';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import { PrismaClient } from '@prisma/client';

interface HttpResult {
  status: number;
  body: string;
}

const DEFAULT_BASE_URL = 'https://cashbackbot-production.up.railway.app';
const TEST_ORDER_PREFIXES = ['CHOTDEAL', 'RAILWAY'];

function get(url: string): Promise<HttpResult> {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 20_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function requiredEnv(name: string): boolean {
  const ok = Boolean(process.env[name]?.trim());
  console.log(`${ok ? 'OK  ' : 'FAIL'} env ${name}`);
  return ok;
}

function warnEnv(name: string): void {
  const ok = Boolean(process.env[name]?.trim());
  console.log(`${ok ? 'OK  ' : 'WARN'} env ${name}${ok ? '' : ' is not set'}`);
}

function isTestOrder(orderId: string): boolean {
  return TEST_ORDER_PREFIXES.some((prefix) => orderId.startsWith(prefix));
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/health`;
  const res = await get(url);
  const ok = res.status === 200;
  console.log(`${ok ? 'OK  ' : 'FAIL'} production health ${url} -> ${res.status}`);
  if (!ok) console.log(res.body.slice(0, 300));
  return ok;
}

async function checkDatabase(): Promise<boolean> {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const [users, links, transactions, payouts, recentLinks, recentTx] =
      await Promise.all([
        prisma.user.count(),
        prisma.link.count(),
        prisma.transaction.count(),
        prisma.payout.count(),
        prisma.link.findMany({
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: {
            subId: true,
            merchant: true,
            affiliateUrl: true,
            createdAt: true,
          },
        }),
        prisma.transaction.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            orderId: true,
            status: true,
            userShare: true,
            createdAt: true,
          },
        }),
      ]);

    console.log('OK   database connected');
    console.log(`INFO users=${users} links=${links} transactions=${transactions} payouts=${payouts}`);

    for (const link of recentLinks) {
      const host = new URL(link.affiliateUrl).host;
      const shortEnough = host === 'shorten.asia' || host === 'go.isclix.com';
      console.log(
        `${shortEnough ? 'OK  ' : 'WARN'} link ${link.subId} ${link.merchant} host=${host}`,
      );
    }

    const realTx = recentTx.find((tx) => !isTestOrder(tx.orderId));
    if (realTx) {
      console.log(
        `OK   real transaction seen: ${realTx.orderId} ${realTx.status} userShare=${realTx.userShare}`,
      );
    } else {
      console.log('WARN launch gate not complete: no real Accesstrade transaction seen yet');
    }

    return true;
  } catch (err) {
    console.log(`FAIL database check: ${(err as Error).message}`);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const baseUrl = process.env.PUBLIC_BASE_URL || DEFAULT_BASE_URL;
  console.log('ChotDeal public launch readiness check');
  console.log(`Base URL: ${baseUrl}`);
  console.log('');

  const envOk = [
    requiredEnv('TELEGRAM_BOT_TOKEN'),
    requiredEnv('TELEGRAM_ADMIN_IDS'),
    requiredEnv('DATABASE_URL'),
    requiredEnv('DIRECT_URL'),
    requiredEnv('ACCESSTRADE_PUB_ID'),
    requiredEnv('ACCESSTRADE_API_TOKEN'),
    requiredEnv('ACCESSTRADE_POSTBACK_SECRET'),
  ].every(Boolean);
  warnEnv('TELEGRAM_UPDATES_MODE');
  warnEnv('PUBLIC_BASE_URL');
  warnEnv('TELEGRAM_WEBHOOK_PATH');
  warnEnv('TELEGRAM_WEBHOOK_SECRET_TOKEN');
  console.log('');

  const healthOk = await checkHealth(baseUrl);
  const dbOk = await checkDatabase();
  console.log('');

  if (envOk && healthOk && dbOk) {
    console.log('PASS soft-launch checks are green.');
    console.log('NEXT gate: place one real Accesstrade order and confirm postback/balance.');
    return;
  }

  console.log('FAIL launch readiness check failed. Fix the FAIL lines above.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
