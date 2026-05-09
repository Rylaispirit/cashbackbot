import 'dotenv/config';

import { ConfigService } from '@nestjs/config';

import {
  AliboBrowserAutomationError,
  AliboBrowserService,
} from '../src/affiliate/alibo-browser.service';
import { detectMerchant, networkOf } from '../src/affiliate/url-detector';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const url = argValue('url');
  if (!url) {
    throw new Error(
      'Thiếu URL test. Ví dụ: npm run alibo:test-browser -- --url=https://item.taobao.com/item.htm?id=123456',
    );
  }

  const merchant = detectMerchant(url);
  if (!merchant || networkOf(merchant) !== 'alibo') {
    throw new Error('URL test phải là link Taobao, Tmall hoặc 1688.');
  }

  const service = new AliboBrowserService(new ConfigService());
  if (!service.isConfigured()) {
    throw new Error(
      'Thiếu ALIBO_LINK_CREATOR_URL hoặc ALIBO_STORAGE_STATE_BASE64 trong .env.',
    );
  }

  try {
    const result = await service.createDiscountLink({
      originalUrl: url,
      subId: `test${Date.now()}`,
      merchant,
    });

    console.log('Alibo discount link created:');
    console.log(result.affiliateUrl);
    if (result.mobileDeepLink) {
      console.log('');
      console.log('Taobao app deep link:');
      console.log(result.mobileDeepLink);
    }
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  if (err instanceof AliboBrowserAutomationError) {
    console.error(`Alibo browser failed: ${err.code} - ${err.message}`);
    if (err.code === 'no_discount') {
      console.error('Link test này không có chiết khấu. Hãy thử một link Taobao/Tmall/1688 thật khác.');
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
