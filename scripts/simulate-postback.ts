/**
 * Postback simulator — gửi POST tới /api/postback/accesstrade với payload giả.
 *
 * Cách dùng:
 *   npx ts-node scripts/simulate-postback.ts \
 *     --sub=tg<sub_id_thực_tế_từ_bot> \
 *     --order=ORDER123 \
 *     --commission=20000 \
 *     --status=pending
 *
 * Để test luồng pending → approved, chạy 2 lần với cùng order, status khác nhau.
 *
 * Ghi chú: chữ ký HMAC tính theo công thức trong `postback.service.ts`.
 * Nếu bạn đổi công thức bên service thì cũng phải đổi ở đây cho khớp.
 */
import { createHmac } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

interface Args {
  sub: string;
  order: string;
  transactionId: string;
  commission: string;
  saleAmount: string;
  status: string;
  isConfirmed: string;
  endpoint: string;
  secret?: string;
  subField: 'utm_source' | 'aff_sub' | 'sub_id' | 'sub1';
}

function parseArgs(): Args {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k && v !== undefined) args[k] = v;
  }
  return {
    sub: args.sub ?? args.subId ?? 'tgtest123abc',
    order: args.order ?? args.orderId ?? `ORDER-${Date.now()}`,
    transactionId:
      args.tx ?? args.transactionId ?? args['transaction_id'] ?? `SIM-${Date.now()}`,
    commission: args.commission ?? '20000',
    saleAmount: args.saleAmount ?? args['sale_amount'] ?? '200000',
    status: args.status ?? 'pending',
    isConfirmed: args.isConfirmed ?? args['is_confirmed'] ?? '0',
    endpoint: args.endpoint ?? 'http://localhost:3000/api/postback/accesstrade',
    secret: args.secret ?? process.env.ACCESSTRADE_POSTBACK_SECRET,
    subField: (args.subField ?? 'utm_source') as Args['subField'],
  };
}

function sign(orderId: string, subId: string, status: string, secret: string): string {
  return createHmac('sha256', secret).update(`${orderId}${subId}${status}`).digest('hex');
}

async function postJson(endpoint: string, body: object): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint);
  const lib = url.protocol === 'https:' ? https : http;
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = parseArgs();
  const payload: Record<string, string> = {
    order_id: args.order,
    transaction_id: args.transactionId,
    reward: args.commission,
    product_price: args.saleAmount,
    status: args.status,
    is_confirmed: args.isConfirmed,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  payload[args.subField] = args.sub;

  if (args.secret) {
    payload.signature = sign(args.order, args.sub, args.status, args.secret);
  } else {
    console.warn('⚠️  Không có secret — payload sẽ không có signature. Đảm bảo bot bật dev-mode.');
  }

  console.log('→ POST', args.endpoint);
  console.log(payload);
  const res = await postJson(args.endpoint, payload);
  console.log('← status:', res.status);
  console.log('← body:', res.body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
