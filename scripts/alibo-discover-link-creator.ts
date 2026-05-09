import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import type { BrowserContextOptions } from 'playwright';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const url =
    argValue('url') ??
    process.env.ALIBO_LINK_CREATOR_URL ??
    process.env.ALIBO_LOGIN_URL ??
    'https://alibo.vn/';
  const storageState = parseStorageState(
    argValue('storage-state-base64') ?? process.env.ALIBO_STORAGE_STATE_BASE64,
  );

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 950 },
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('\nAlibo creator URL discovery');
  console.log('1. Login Alibo trong browser vừa mở.');
  console.log('2. Tự bấm quanh dashboard nếu thấy menu Công cụ / Tạo link / Taobao.');
  console.log('3. Khi đang ở trang nghi là tạo link, quay lại terminal và nhấn Enter.\n');

  const rl = createInterface({ input, output });
  await rl.question('Nhấn Enter để quét trang hiện tại...');
  rl.close();

  const candidates = await page.evaluate(() => {
    const words =
      /tạo|tao|link|chiết|chiet|khấu|khau|taobao|tmall|1688|affiliate|campaign|quảng|quang|cáo|cao/i;

    const items = Array.from(
      document.querySelectorAll('a[href], button, [role="button"]'),
    )
      .map((el) => {
        const anchor = el as HTMLAnchorElement;
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const href = anchor.href || el.getAttribute('href') || '';
        return { text, href };
      })
      .filter((item) => words.test(`${item.text} ${item.href}`))
      .slice(0, 80);

    const inputs = Array.from(
      document.querySelectorAll('input, textarea, [contenteditable="true"]'),
    ).map((el) => {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      return {
        tag: el.tagName.toLowerCase(),
        placeholder: inputEl.placeholder ?? '',
        name: inputEl.name ?? '',
        id: inputEl.id ?? '',
        aria: el.getAttribute('aria-label') ?? '',
      };
    });

    return {
      currentUrl: window.location.href,
      title: document.title,
      linksAndButtons: items,
      inputs,
    };
  });

  console.log('\nCurrent page:');
  console.log(candidates.currentUrl);
  console.log(candidates.title);

  console.log('\nCandidate links/buttons:');
  for (const item of candidates.linksAndButtons) {
    console.log(`- ${item.text || '(no text)'} ${item.href ? `=> ${item.href}` : ''}`);
  }

  console.log('\nInputs found on current page:');
  for (const item of candidates.inputs) {
    console.log(
      `- <${item.tag}> placeholder="${item.placeholder}" name="${item.name}" id="${item.id}" aria="${item.aria}"`,
    );
  }

  console.log('\nNếu thấy input/link đúng, copy Current page hoặc candidate URL làm ALIBO_LINK_CREATOR_URL.');
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function parseStorageState(
  rawBase64: string | undefined,
): Exclude<NonNullable<BrowserContextOptions['storageState']>, string> | undefined {
  if (!rawBase64) return undefined;

  try {
    return JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
  } catch {
    console.warn(
      'ALIBO_STORAGE_STATE_BASE64 khong parse duoc, bo qua session va mo browser trang.',
    );
    return undefined;
  }
}
