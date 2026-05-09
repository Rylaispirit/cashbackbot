import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type {
  Browser,
  BrowserContextOptions,
  BrowserContext,
  Locator,
  Page,
  Response,
} from 'playwright';

import { Merchant, labelMerchant } from './url-detector';

export type AliboBrowserErrorCode =
  | 'missing_config'
  | 'session_expired'
  | 'input_not_found'
  | 'generate_not_found'
  | 'result_not_found'
  | 'no_discount'
  | 'browser_failed';

export class AliboBrowserAutomationError extends Error {
  constructor(
    message: string,
    readonly code: AliboBrowserErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AliboBrowserAutomationError';
  }
}

interface CreateAliboLinkInput {
  originalUrl: string;
  subId: string;
  merchant: Merchant;
}

export interface AliboBrowserLinkResult {
  affiliateUrl: string;
  mobileDeepLink?: string;
}

interface FillTarget {
  index: number;
  score: number;
}

type InlineStorageState = Exclude<
  NonNullable<BrowserContextOptions['storageState']>,
  string
>;

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RESTART_EVERY = 100;
const DEFAULT_STORAGE_STATE_PATH = '.secrets/alibo-storage-state.json';
const INPUT_SELECTOR = [
  '#input_home_org_link',
  'input[name="input_prod_link"]',
  'textarea',
  'input[type="url"]',
  'input[type="text"]',
  'input[type="search"]',
  'input:not([type])',
  '[contenteditable="true"]',
].join(',');

const RESULT_HOST_PRIORITIES = [
  { pattern: /(^|\.)s\.click\.taobao\.com$/i, score: 100 },
  { pattern: /(^|\.)m\.tb\.cn$/i, score: 95 },
  { pattern: /(^|\.)uland\.taobao\.com$/i, score: 90 },
  { pattern: /(^|\.)click\.tmall\.com$/i, score: 85 },
  { pattern: /(^|\.)tb\.cn$/i, score: 80 },
  { pattern: /(^|\.)shorten\.asia$/i, score: 60 },
];

@Injectable()
export class AliboBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(AliboBrowserService.name);
  private browserPromise: Promise<Browser> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private requestCount = 0;
  private readonly sentAdminAlertKeys = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('ALIBO_LINK_CREATOR_URL')?.trim() &&
        this.hasStorageState(),
    );
  }

  async createDiscountLink(
    input: CreateAliboLinkInput,
  ): Promise<AliboBrowserLinkResult> {
    const queuedAt = Date.now();
    const run = this.queue.then(
      () => this.createDiscountLinkNow(input, queuedAt),
      () => this.createDiscountLinkNow(input, queuedAt),
    );

    // Keep browser automation strictly serial to avoid Railway Hobby OOM.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async close(): Promise<void> {
    await this.closeBrowser('manual close');
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser('Nest shutdown');
  }

  private async createDiscountLinkNow(
    input: CreateAliboLinkInput,
    queuedAt: number,
  ): Promise<AliboBrowserLinkResult> {
    const startedAt = Date.now();
    const queueMs = startedAt - queuedAt;
    const creatorUrl = this.config
      .get<string>('ALIBO_LINK_CREATOR_URL')
      ?.trim();

    if (!creatorUrl || !this.hasStorageState()) {
      throw new AliboBrowserAutomationError(
        'Missing ALIBO_LINK_CREATOR_URL or Alibo storage state',
        'missing_config',
      );
    }

    const timeoutMs = this.getTimeoutMs();
    const storageState = this.loadStorageState();
    const browser = await this.getBrowser();
    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext({
        storageState,
        ignoreHTTPSErrors: true,
      });
      context.setDefaultTimeout(timeoutMs);
      context.setDefaultNavigationTimeout(timeoutMs);

      const page = await context.newPage();
      await page.goto(creatorUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      await this.assertSessionIsValid(page);

      const beforeUrls = await this.collectCandidateUrls(page);
      await this.selectDiscountModeIfPossible(page);
      const inputLocator = await this.fillOriginalUrl(page, input.originalUrl);
      const couponResponsePromise = this.waitForCouponResponse(page, timeoutMs);
      await this.clickGenerate(page, inputLocator);

      const couponResult =
        await this.extractCouponResponseResult(couponResponsePromise);
      if (couponResult) {
        this.logger.log(
          `alibo browser createLink: result=ok merchant=${input.merchant} subId=${input.subId} ms=${
            Date.now() - startedAt
          } queueMs=${queueMs}`,
        );
        return couponResult;
      }

      const result = await this.waitForResultUrl({
        page,
        originalUrl: input.originalUrl,
        beforeUrls,
        timeoutMs,
      });
      this.logger.log(
        `alibo browser createLink: result=ok merchant=${input.merchant} subId=${input.subId} ms=${
          Date.now() - startedAt
        } queueMs=${queueMs}`,
      );
      return { affiliateUrl: result };
    } catch (err) {
      if (err instanceof AliboBrowserAutomationError) {
        this.logger.warn(
          `alibo browser createLink: result=fail code=${err.code} merchant=${input.merchant} subId=${input.subId} ms=${
            Date.now() - startedAt
          } queueMs=${queueMs}`,
        );
        await this.alertAdminIfNeeded(err, input);
        throw err;
      }

      this.logger.warn(
        `Alibo browser automation failed for ${labelMerchant(input.merchant)} subId=${input.subId}: ${
          (err as Error).message
        }`,
      );
      throw new AliboBrowserAutomationError(
        'Alibo browser automation failed',
        'browser_failed',
        err,
      );
    } finally {
      await context?.close().catch((err: Error) => {
        this.logger.warn(`Could not close Alibo browser context: ${err.message}`);
      });
      await this.restartBrowserIfNeeded();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        })
        .catch((err) => {
          this.browserPromise = null;
          throw err;
        });
    }

    return this.browserPromise;
  }

  private async restartBrowserIfNeeded(): Promise<void> {
    this.requestCount += 1;
    const maxRequests = this.getRestartEvery();
    if (this.requestCount < maxRequests) return;

    this.requestCount = 0;
    await this.closeBrowser(`restart after ${maxRequests} Alibo requests`);
  }

  private async closeBrowser(reason: string): Promise<void> {
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    if (!browserPromise) return;

    const browser = await browserPromise.catch(() => null);
    if (!browser) return;

    await browser.close().catch((err: Error) => {
      this.logger.warn(`Could not close Alibo browser (${reason}): ${err.message}`);
    });
    this.logger.log(`Alibo browser closed: ${reason}`);
  }

  private getTimeoutMs(): number {
    const raw = this.config.get<string>('ALIBO_BROWSER_TIMEOUT_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TIMEOUT_MS;
    return Number.isFinite(parsed) && parsed >= 10_000
      ? parsed
      : DEFAULT_TIMEOUT_MS;
  }

  private getRestartEvery(): number {
    const raw = this.config.get<string>('ALIBO_BROWSER_RESTART_EVERY');
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_RESTART_EVERY;
    return Number.isFinite(parsed) && parsed >= 1
      ? parsed
      : DEFAULT_RESTART_EVERY;
  }

  private hasStorageState(): boolean {
    if (this.config.get<string>('ALIBO_STORAGE_STATE_BASE64')?.trim()) {
      return true;
    }
    return existsSync(this.getStorageStatePath());
  }

  private getStorageStatePath(): string {
    const configuredPath = this.config
      .get<string>('ALIBO_STORAGE_STATE_PATH')
      ?.trim();
    return resolve(process.cwd(), configuredPath || DEFAULT_STORAGE_STATE_PATH);
  }

  private loadStorageState(): InlineStorageState {
    const rawBase64 = this.config
      .get<string>('ALIBO_STORAGE_STATE_BASE64')
      ?.trim();
    if (rawBase64) return this.parseStorageState(rawBase64);

    const storageStatePath = this.getStorageStatePath();
    try {
      return JSON.parse(readFileSync(storageStatePath, 'utf8')) as InlineStorageState;
    } catch (err) {
      throw new AliboBrowserAutomationError(
        `Could not load Alibo storage state from ${storageStatePath}`,
        'missing_config',
        err,
      );
    }
  }

  private parseStorageState(rawBase64: string): InlineStorageState {
    try {
      const json = Buffer.from(rawBase64, 'base64').toString('utf8');
      return JSON.parse(json) as InlineStorageState;
    } catch (err) {
      throw new AliboBrowserAutomationError(
        'ALIBO_STORAGE_STATE_BASE64 is not valid Playwright storage state',
        'missing_config',
        err,
      );
    }
  }

  private async assertSessionIsValid(page: Page): Promise<void> {
    const hasVisiblePassword = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    const currentUrl = page.url().toLowerCase();

    if (
      hasVisiblePassword ||
      currentUrl.includes('/login') ||
      currentUrl.includes('/dang-nhap') ||
      currentUrl.includes('/signin')
    ) {
      throw new AliboBrowserAutomationError(
        'Alibo session expired or not logged in',
        'session_expired',
      );
    }
  }

  private async selectDiscountModeIfPossible(page: Page): Promise<void> {
    const linkType =
      this.config.get<string>('ALIBO_LINK_TYPE')?.toLowerCase().trim() ??
      'discount';
    if (linkType !== 'discount') return;

    // Alibo homepage already has the discount creator input. Do not click
    // generic "discount" links here because one of them opens the Chrome extension.
    const hasHomeCreator = await page
      .locator('#input_home_org_link, input[name="input_prod_link"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasHomeCreator) return;

    const candidates = [
      page.getByRole('button', { name: /chiết\s*khấu|discount|rebate/i }),
      page.getByRole('link', { name: /chiết\s*khấu|discount|rebate/i }),
      page.getByText(/link\s*chiết\s*khấu|chiết\s*khấu/i).first(),
      page
        .locator('button,a,[role="button"],label')
        .filter({ hasText: /chiết\s*khấu|discount|rebate/i })
        .first(),
    ];

    for (const candidate of candidates) {
      if (await this.clickIfVisible(candidate)) return;
    }
  }

  private async fillOriginalUrl(
    page: Page,
    originalUrl: string,
  ): Promise<Locator> {
    const homeCreator = page
      .locator('#input_home_org_link, input[name="input_prod_link"]')
      .first();
    if (await homeCreator.isVisible().catch(() => false)) {
      await homeCreator.fill(originalUrl);
      return homeCreator;
    }

    const targets = await page.locator(INPUT_SELECTOR).evaluateAll((nodes) => {
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 10 &&
          box.height > 10
        );
      }

      function textFor(el: Element): string {
        const htmlEl = el as HTMLInputElement | HTMLTextAreaElement;
        const parentText = el.parentElement?.textContent ?? '';
        return [
          htmlEl.placeholder,
          htmlEl.name,
          htmlEl.id,
          htmlEl.getAttribute('aria-label'),
          parentText.slice(0, 300),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
      }

      return nodes
        .map((node, index) => {
          const text = textFor(node);
          let score = 0;
          if (/link|url|taobao|tmall|1688|sản phẩm|san pham|product/.test(text)) {
            score += 20;
          }
          if (/chiết khấu|chiet khau|discount|rebate/.test(text)) {
            score += 10;
          }
          if (/search|tìm kiếm|tim kiem/.test(text)) {
            score -= 5;
          }
          return { index, score, visible: isVisible(node) };
        })
        .filter((target) => target.visible)
        .sort((a, b) => b.score - a.score);
    });

    const target = (targets as FillTarget[])[0];
    if (!target) {
      throw new AliboBrowserAutomationError(
        'Could not find Alibo link input',
        'input_not_found',
      );
    }

    const locator = page.locator(INPUT_SELECTOR).nth(target.index);
    await locator.fill(originalUrl);
    return locator;
  }

  private async clickGenerate(
    page: Page,
    inputLocator: Locator,
  ): Promise<void> {
    const homeClicked = await this.clickAliboHomeGenerateButton(page);
    if (homeClicked) return;

    const candidates = [
      page.getByRole('button', {
        name: /tạo.*link|lấy.*link|rút gọn|chuyển đổi|generate|convert|create/i,
      }),
      page
        .locator('button,input[type="submit"],a[role="button"],[role="button"]')
        .filter({
          hasText:
            /tạo.*link|lấy.*link|rút gọn|chuyển đổi|generate|convert|create/i,
        })
        .first(),
    ];

    for (const candidate of candidates) {
      if (await this.clickIfVisible(candidate)) return;
    }

    await inputLocator.press('Enter').catch(() => {
      throw new AliboBrowserAutomationError(
        'Could not find Alibo generate button',
        'generate_not_found',
      );
    });
  }

  private async clickAliboHomeGenerateButton(page: Page): Promise<boolean> {
    const selectors = [
      '#BUTTON39',
      '#BUTTON_TEXT39',
      '#btn_home_get_link',
      '#btn_get_link',
      '#home_get_link',
      'button[onclick*="input_home_org_link"]',
      'a[onclick*="input_home_org_link"]',
    ];

    for (const selector of selectors) {
      if (await this.clickIfVisible(page.locator(selector))) return true;
    }

    return page.evaluate(() => {
      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 10 &&
          box.height > 10
        );
      }

      const elements = Array.from(
        document.querySelectorAll(
          'button,a,[role="button"],input[type="button"],input[type="submit"]',
        ),
      );
      const candidates = elements
        .map((el) => {
          const input = el as HTMLInputElement;
          const text = [
            el.textContent,
            input.value,
            el.id,
            el.className,
            el.getAttribute('aria-label'),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          let score = 0;
          if (/nh.n|chi.t|kh.u|discount|rebate/.test(text)) score += 20;
          if (/t.o|tao|link|submit|create|generate|convert/.test(text)) {
            score += 10;
          }
          if (/chrome|extension|c.ng c.|cong cu/.test(text)) score -= 40;
          return { el, score };
        })
        .filter((item) => item.score > 0 && isVisible(item.el))
        .sort((a, b) => b.score - a.score);

      const best = candidates[0]?.el as HTMLElement | undefined;
      if (!best) return false;
      best.click();
      return true;
    });
  }

  private waitForCouponResponse(
    page: Page,
    timeoutMs: number,
  ): Promise<Response | null> {
    return page
      .waitForResponse((response) => response.url().includes('/coupon/'), {
        timeout: Math.min(timeoutMs, 15_000),
      })
      .catch(() => null);
  }

  private async extractCouponResponseResult(
    responsePromise: Promise<Response | null>,
  ): Promise<AliboBrowserLinkResult | null> {
    const response = await responsePromise;
    if (!response || !response.ok()) return null;

    const text = await response.text().catch(() => '');
    const mobileDeepLink = this.extractMobileDeepLink(text);
    const affiliateUrl = this.extractAffiliateUrl(text);
    if (affiliateUrl) {
      return {
        affiliateUrl,
        mobileDeepLink: mobileDeepLink ?? undefined,
      };
    }

    const urls = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    for (const url of urls) {
      const normalized = this.normalizeUrl(url);
      if (normalized && this.scoreResultUrl(normalized) > 0) {
        return {
          affiliateUrl: normalized,
          mobileDeepLink: mobileDeepLink ?? undefined,
        };
      }
    }

    const resultMatch = text.match(/['"]result['"]\s*:\s*['"]([^'"]+)['"]/);
    if (resultMatch?.[1]?.toLowerCase() === 'false') {
      throw new AliboBrowserAutomationError(
        'Alibo returned no discount for this product',
        'no_discount',
      );
    }

    return null;
  }

  private extractAffiliateUrl(text: string): string | null {
    const candidateFields = ['coupon_link', 'link_chinese_mobile'];
    for (const field of candidateFields) {
      const normalized = this.normalizeUrl(this.extractQuotedField(text, field));
      if (normalized && this.scoreResultUrl(normalized) > 0) {
        return normalized;
      }
    }
    return null;
  }

  private extractMobileDeepLink(text: string): string | null {
    const candidateFields = [
      'coupon_tpwd',
      'mobile_coupon_tpwd',
      'mobile_coupon_tpwd_open_app',
      'link_chinese_mobile',
    ];
    for (const field of candidateFields) {
      const normalized = this.normalizeMobileDeepLink(
        this.extractQuotedField(text, field),
      );
      if (normalized) return normalized;
    }

    const [deepLink] =
      text.match(/(?:taobao|tbopen):\/\/[^\s"'<>]+/gi) ?? [];
    return this.normalizeMobileDeepLink(deepLink);
  }

  private extractQuotedField(text: string, field: string): string | null {
    const match = text.match(
      new RegExp(`['"]${field}['"]\\s*:\\s*['"]([^'"]*)['"]`),
    );
    if (!match?.[1]) return null;
    return match[1].replaceAll('\\/', '/').replaceAll('&amp;', '&');
  }

  private async waitForResultUrl(input: {
    page: Page;
    originalUrl: string;
    beforeUrls: Set<string>;
    timeoutMs: number;
  }): Promise<string> {
    const deadline = Date.now() + input.timeoutMs;
    const original = this.normalizeUrl(input.originalUrl);
    let bestUrl: string | null = null;

    while (Date.now() < deadline) {
      await input.page.waitForTimeout(1_000);
      const urls = await this.collectCandidateUrls(input.page);
      bestUrl = this.pickBestResultUrl({
        urls,
        originalUrl: original,
        beforeUrls: input.beforeUrls,
      });

      if (bestUrl) return bestUrl;
    }

    throw new AliboBrowserAutomationError(
      'Alibo did not return a discount link before timeout',
      'result_not_found',
    );
  }

  private async collectCandidateUrls(page: Page): Promise<Set<string>> {
    const rawUrls = await page.evaluate(() => {
      const values: string[] = [];
      const urlRegex = /https?:\/\/[^\s"'<>]+/g;

      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        values.push((anchor as HTMLAnchorElement).href);
      }

      const valueSelector = [
        'input',
        'textarea',
        '[data-clipboard-text]',
        '[data-url]',
        '[href]',
      ].join(',');
      for (const element of Array.from(document.querySelectorAll(valueSelector))) {
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        values.push(input.value ?? '');
        values.push(element.getAttribute('data-clipboard-text') ?? '');
        values.push(element.getAttribute('data-url') ?? '');
        values.push(element.getAttribute('href') ?? '');
      }

      const bodyText = document.body?.innerText ?? '';
      values.push(...(bodyText.match(urlRegex) ?? []));

      return values;
    });

    const urls = new Set<string>();
    for (const raw of rawUrls) {
      const normalized = this.normalizeUrl(raw);
      if (normalized) urls.add(normalized);
    }
    return urls;
  }

  private pickBestResultUrl(input: {
    urls: Set<string>;
    originalUrl: string | null;
    beforeUrls: Set<string>;
  }): string | null {
    const ranked = Array.from(input.urls)
      .filter((url) => url !== input.originalUrl)
      .filter((url) => !input.beforeUrls.has(url))
      .map((url) => ({ url, score: this.scoreResultUrl(url) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.url ?? null;
  }

  private scoreResultUrl(rawUrl: string): number {
    try {
      const parsed = new URL(rawUrl);
      if (/login|logout/i.test(parsed.pathname)) return 0;
      for (const item of RESULT_HOST_PRIORITIES) {
        if (item.pattern.test(parsed.hostname)) return item.score;
      }
      return /taobao|tmall|1688/i.test(parsed.hostname) ? 20 : 0;
    } catch {
      return 0;
    }
  }

  private normalizeUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw
      .trim()
      .replaceAll('&amp;', '&')
      .replace(/[)\].,;'"<>]+$/, '');
    if (!cleaned.startsWith('http')) return null;

    try {
      return new URL(cleaned).toString();
    } catch {
      return null;
    }
  }

  private normalizeMobileDeepLink(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw
      .trim()
      .replaceAll('\\/', '/')
      .replaceAll('&amp;', '&')
      .replace(/[)\].,;'"<>]+$/, '');

    if (/^(taobao|tbopen):\/\//i.test(cleaned)) return cleaned;
    return null;
  }

  private async clickIfVisible(locator: Locator): Promise<boolean> {
    const count = await locator.count().catch(() => 0);
    if (count === 0) return false;

    for (let index = 0; index < Math.min(count, 5); index += 1) {
      const current = locator.nth(index);
      const visible = await current.isVisible().catch(() => false);
      if (!visible) continue;

      try {
        await current.click({ timeout: 2_000 });
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private async alertAdminIfNeeded(
    err: AliboBrowserAutomationError,
    input: CreateAliboLinkInput,
  ): Promise<void> {
    if (err.code !== 'session_expired' && err.code !== 'missing_config') return;

    const alertKey = `${err.code}:${input.merchant}`;
    if (this.sentAdminAlertKeys.has(alertKey)) return;
    this.sentAdminAlertKeys.add(alertKey);

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim();
    const adminId = this.config
      .get<string>('TELEGRAM_ADMIN_IDS')
      ?.split(',')
      .map((id) => id.trim())
      .find(Boolean);
    if (!token || !adminId) return;

    const text = [
      '🚨 Alibo browser automation cần kiểm tra',
      '',
      `Lỗi: ${err.code}`,
      `Sàn: ${labelMerchant(input.merchant)}`,
      `Sub ID: ${input.subId}`,
      '',
      err.code === 'session_expired'
        ? 'Session Alibo có thể đã hết hạn. Chạy lại npm run alibo:capture-session rồi cập nhật ALIBO_STORAGE_STATE_BASE64 trên Railway.'
        : 'Thiếu ALIBO_LINK_CREATOR_URL hoặc ALIBO_STORAGE_STATE_BASE64 trên môi trường đang chạy.',
    ].join('\n');

    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminId,
          text,
          link_preview_options: { is_disabled: true },
        }),
      });
    } catch (alertErr) {
      this.logger.warn(
        `Could not send Alibo admin alert: ${(alertErr as Error).message}`,
      );
    }
  }
}
