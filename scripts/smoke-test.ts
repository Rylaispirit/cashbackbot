/**
 * Smoke test — chạy trước khi start bot lần đầu để confirm:
 *   1. TELEGRAM_BOT_TOKEN hoạt động (gọi getMe)
 *   2. DATABASE_URL connect được
 *   3. ACCESSTRADE_PUB_ID đã set
 *
 * Chạy:
 *   npx ts-node -T scripts/smoke-test.ts
 */
import 'dotenv/config';
import * as https from 'https';

interface TelegramMe {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
    can_join_groups: boolean;
    can_read_all_group_messages: boolean;
  };
  description?: string;
  error_code?: number;
}

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(buf));
      })
      .on('error', reject);
  });
}

async function checkTelegram(token: string): Promise<boolean> {
  console.log('🔍 Test Telegram bot token...');
  try {
    const raw = await get(`https://api.telegram.org/bot${token}/getMe`);
    const data = JSON.parse(raw) as TelegramMe;
    if (!data.ok || !data.result) {
      console.log(`  ❌ FAIL: ${data.description ?? 'unknown error'}`);
      return false;
    }
    const me = data.result;
    console.log(`  ✅ OK: @${me.username} (${me.first_name}, id=${me.id})`);
    console.log(`     can_join_groups=${me.can_join_groups} privacy=${me.can_read_all_group_messages ? 'disabled' : 'enabled'}`);
    return true;
  } catch (err) {
    console.log(`  ❌ FAIL: ${(err as Error).message}`);
    return false;
  }
}

async function checkDatabase(): Promise<boolean> {
  console.log('🔍 Test DATABASE_URL...');
  if (!process.env.DATABASE_URL) {
    console.log('  ⚠️  Bỏ qua: DATABASE_URL chưa set (sẽ check sau khi setup Supabase)');
    return true;
  }
  try {
    // Lazy import Prisma — chỉ load khi DB url có
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$connect();
    const result = await prisma.$queryRaw`SELECT 1 as ok`;
    await prisma.$disconnect();
    console.log(`  ✅ OK: connected, query returns ${JSON.stringify(result)}`);
    return true;
  } catch (err) {
    console.log(`  ❌ FAIL: ${(err as Error).message}`);
    console.log('     Hint: chạy "npm run prisma:generate" trước rồi check lại DATABASE_URL.');
    return false;
  }
}

function checkEnv(): boolean {
  console.log('🔍 Test env vars...');
  const required = ['TELEGRAM_BOT_TOKEN', 'ACCESSTRADE_PUB_ID'];
  const optional = [
    'DATABASE_URL',
    'DIRECT_URL',
    'ACCESSTRADE_POSTBACK_SECRET',
    'TELEGRAM_ADMIN_IDS',
    'USER_COMMISSION_RATE',
    'MIN_PAYOUT_AMOUNT',
  ];
  let ok = true;
  for (const k of required) {
    if (!process.env[k]) {
      console.log(`  ❌ ${k}: thiếu (BẮT BUỘC)`);
      ok = false;
    } else {
      console.log(`  ✅ ${k}: có (${maskValue(process.env[k]!)})`);
    }
  }
  for (const k of optional) {
    const v = process.env[k];
    console.log(`  ${v ? '✅' : '⚠️ '} ${k}: ${v ? maskValue(v) : 'chưa set (optional)'}`);
  }
  return ok;
}

function maskValue(v: string): string {
  if (v.length <= 8) return '***';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  ChotDeal Bot — Smoke Test');
  console.log('═══════════════════════════════════════════\n');

  const envOk = checkEnv();
  console.log('');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const tgOk = token ? await checkTelegram(token) : false;
  console.log('');

  const dbOk = await checkDatabase();
  console.log('');

  console.log('═══════════════════════════════════════════');
  if (envOk && tgOk && dbOk) {
    console.log('  ✅ TẤT CẢ PASS — sẵn sàng chạy bot');
    console.log('  Tiếp theo: npm run start:dev');
  } else {
    console.log('  ❌ CÓ LỖI — đọc log ở trên để fix');
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
