/**
 * Smoke-test Accesstrade API and print real response shapes.
 *
 * Examples:
 *   npm run test:at
 *   npm run test:at -- --url=https://shopee.vn/abc
 *   npm run test:at -- --campaign=123456
 */
import 'dotenv/config';
import * as https from 'https';

interface ParsedRes {
  status: number;
  body: unknown;
  raw: string;
}

function get(
  host: string,
  path: string,
  headers: Record<string, string>,
): Promise<ParsedRes> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(buf);
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function post(
  host: string,
  path: string,
  body: object,
  headers: Record<string, string>,
): Promise<ParsedRes> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: host,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(buf);
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getArg(name: string, defaultVal?: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (found) return found.split('=')[1];
  return defaultVal;
}

async function main() {
  const token = process.env.ACCESSTRADE_API_TOKEN;
  const pubId = process.env.ACCESSTRADE_PUB_ID;
  const campaignId =
    getArg('campaign') ?? process.env.ACCESSTRADE_CAMPAIGN_ID_SHOPEE;
  const testUrl = getArg('url', 'https://shopee.vn/sample-product');

  if (!token) {
    console.error('ACCESSTRADE_API_TOKEN is missing in .env');
    process.exit(1);
  }
  if (!pubId) {
    console.error('ACCESSTRADE_PUB_ID is missing in .env');
    process.exit(1);
  }

  const auth = `Token ${token}`;
  const host = 'api.accesstrade.vn';

  console.log('===========================================');
  console.log('  Accesstrade API Test');
  console.log('===========================================');
  console.log(`pub_id:   ${pubId}`);
  console.log(`token:    ${token.slice(0, 6)}...${token.slice(-4)}`);
  console.log(`campaign: ${campaignId ?? '(not set)'}`);
  console.log(`test url: ${testUrl}\n`);

  console.log('--- Test 1: verify token ---');
  for (const path of ['/v1/user/info', '/v1/me', '/v1/publisher/info']) {
    const res = await get(host, path, { Authorization: auth });
    console.log(`GET ${path} -> ${res.status}`);
    if (res.status === 200) {
      console.log('  Token looks valid. Response shape:');
      console.log(JSON.stringify(res.body, null, 2));
      break;
    }
    if (res.status === 401 || res.status === 403) {
      console.log(`  Auth failed: ${res.raw.slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log('');

  console.log('--- Test 2: create tracking link ---');
  if (!campaignId) {
    console.log(
      'Skip: no campaign id configured. Set ACCESSTRADE_CAMPAIGN_ID_SHOPEE or pass --campaign=<id>.',
    );
  } else {
    const res = await post(
      host,
      '/v1/product_link/create',
      {
        campaign_id: campaignId,
        urls: [testUrl],
        sub1: 'tg_smoketest',
        utm_source: 'tg_smoketest',
        url_enc: true,
      },
      { Authorization: auth },
    );
    console.log(`POST /v1/product_link/create -> ${res.status}`);
    console.log(res.raw.slice(0, 1000));
  }
  console.log('');

  console.log('--- Test 3: list campaigns ---');
  for (const path of ['/v1/campaigns', '/v1/offers', '/v1/publishers/campaigns']) {
    const res = await get(host, path, { Authorization: auth });
    console.log(`GET ${path} -> ${res.status}`);
    if (res.status === 200) {
      const body = res.body as { data?: unknown[]; results?: unknown[] };
      const list = body.data ?? body.results ?? [];
      console.log(`  Count: ${Array.isArray(list) ? list.length : '?'}`);
      if (Array.isArray(list) && list.length > 0) {
        console.log('  First item:');
        console.log(JSON.stringify(list[0], null, 2));
      }
      break;
    }
  }
  console.log('');

  console.log('--- Test 4: transaction history ---');
  for (const path of [
    '/v1/transactions',
    '/v1/conversions',
    '/v1/orders?since=' + Math.floor(Date.now() / 1000 - 30 * 86400),
  ]) {
    const res = await get(host, path, { Authorization: auth });
    console.log(`GET ${path} -> ${res.status}`);
    if (res.status === 200) {
      console.log(`  Preview: ${res.raw.slice(0, 300)}`);
      break;
    }
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
