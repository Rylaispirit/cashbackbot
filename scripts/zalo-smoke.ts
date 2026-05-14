/**
 * Zalo Bot Platform smoke test.
 *
 * Cách chạy:
 *   npm run zalo:smoke                              → chỉ getMe
 *   npm run zalo:smoke -- --chat=<chat_id> --text="hello"  → cũng test sendMessage
 */
import 'dotenv/config';
import * as https from 'https';

interface ZaloResponse<T = unknown> {
  ok: boolean;
  description?: string;
  result?: T;
  error_code: number;
}

function getArg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found?.split('=')[1];
}

function request<T>(
  method: 'GET' | 'POST',
  url: string,
  body?: object,
): Promise<{ status: number; data: T }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: buf as unknown as T });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const token = process.env.ZALO_BOT_TOKEN;
  const base = process.env.ZALO_BASE_URL ?? 'https://bot-api.zapps.me/bot';
  if (!token) {
    console.error('❌ ZALO_BOT_TOKEN chưa set trong .env');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log('  Zalo Bot Smoke Test');
  console.log('═══════════════════════════════════════════');
  console.log(`Token: ${token.slice(0, 6)}...${token.slice(-4)}\n`);

  // === Test 1: getMe ===
  console.log('🔍 Test 1: getMe');
  try {
    const res = await request<ZaloResponse<Record<string, unknown>>>(
      'GET',
      `${base}${token}/getMe`,
    );
    if (res.data.ok && res.data.result) {
      const info = res.data.result;
      console.log(`  ✅ Bot: ${info.display_name} (@${info.account_name})`);
      console.log(`     id=${info.id}`);
      console.log(`     account_type=${info.account_type}`);
      console.log(`     can_join_groups=${info.can_join_groups}`);
    } else {
      console.log(
        `  ❌ FAIL: ${res.data.description ?? 'unknown'} (code=${res.data.error_code})`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.log(`  ❌ Network error: ${(err as Error).message}`);
    process.exit(1);
  }

  // === Test 2: sendMessage (optional) ===
  const chatId = getArg('chat');
  const text = getArg('text') ?? 'ChotDeal smoke test ✅';
  if (chatId) {
    console.log(`\n🔍 Test 2: sendMessage to ${chatId}`);
    const res = await request<ZaloResponse>(
      'POST',
      `${base}${token}/sendMessage`,
      { chat_id: chatId, text },
    );
    if (res.data.ok) {
      console.log('  ✅ Sent. Check Zalo chat.');
    } else {
      console.log(
        `  ❌ FAIL: ${res.data.description} (code=${res.data.error_code})`,
      );
      if (res.data.error_code === 410) {
        console.log('     → chat_id sai. Mở bot trên Zalo, nhắn 1 tin rồi lấy chat_id từ webhook log.');
      }
    }
  } else {
    console.log(
      '\nℹ️  Skip sendMessage — pass --chat=<id> --text="..." để test gửi tin.',
    );
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Done. Token hoạt động OK.');
  console.log('═══════════════════════════════════════════');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
