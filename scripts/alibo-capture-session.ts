import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

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
    'https://alibo.vn/dang-nhap/';
  const out = resolve(
    process.cwd(),
    argValue('out') ?? '.secrets/alibo-storage-state.json',
  );

  mkdirSync(dirname(out), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('\nAlibo session capture');
  console.log('1. Login Alibo trong browser vừa mở.');
  console.log('2. Vào đúng trang tạo link chiết khấu nếu chưa ở đó.');
  console.log('3. Khi thấy trang đã login OK, quay lại terminal và nhấn Enter.\n');

  const rl = createInterface({ input, output });
  await rl.question('Nhấn Enter để export session...');
  rl.close();

  const state = await context.storageState({ path: out });
  const base64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');

  writeFileSync(out, JSON.stringify(state, null, 2), 'utf8');
  await browser.close();

  console.log(`\nSaved local session file: ${out}`);
  console.log('Copy dòng dưới vào Railway Variables:');
  console.log(`ALIBO_STORAGE_STATE_BASE64=${base64}`);
  console.log('\nKhông commit file session local. File này đã được .gitignore bảo vệ.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
