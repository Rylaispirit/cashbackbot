import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContextOptions, Page } from 'playwright';

import { PrismaService } from '../prisma/prisma.service';

export type AliboOrder = {
  id: string;
  orderId: string;
  lineKey: string;
  platform: string | null;
  statusRaw: string;
  status: TransactionStatus;
  paidAt: Date | null;
  settledAt: Date | null;
  itemTitle: string | null;
  itemLink: string | null;
  itemImage: string | null;
  quantity: number;
  saleAmountCny: { toString(): string } | null;
  commissionCny: { toString(): string } | null;
  commissionVnd: number;
  saleAmountVnd: number;
  rawPayload: unknown;
  matchStatus: string;
  matchedSubId: string | null;
  matchedLinkId: string | null;
  transactionId: string | null;
  matchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type InlineStorageState = Exclude<
  NonNullable<BrowserContextOptions['storageState']>,
  string
>;

interface AliboRawOrder {
  trade_parent_id?: unknown;
  product_type?: unknown;
  tk_paid_time?: unknown;
  tk_create_time?: unknown;
  tk_status?: unknown;
  item_img?: unknown;
  item_title?: unknown;
  item_link?: unknown;
  item_num?: unknown;
  alipay_total_price?: unknown;
  guest_income?: unknown;
  [key: string]: unknown;
}

interface AliboSearchResponse {
  recordsTotal?: unknown;
  recordsFiltered?: unknown;
  total_guest_income?: unknown;
  data?: unknown;
}

interface NormalizedAliboOrder {
  orderId: string;
  lineKey: string;
  platform: string | null;
  statusRaw: string;
  status: TransactionStatus;
  paidAt: Date | null;
  settledAt: Date | null;
  itemTitle: string | null;
  itemLink: string | null;
  itemImage: string | null;
  quantity: number;
  saleAmountCny: string | null;
  commissionCny: string | null;
  commissionVnd: number;
  saleAmountVnd: number;
  rawPayload: unknown;
}

export interface AliboSyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  recordsTotal: number;
  orders: AliboOrder[];
}

export type AliboOrderListMode = 'unmatched' | 'matched' | 'all';

const DEFAULT_STORAGE_STATE_PATH = '.secrets/alibo-storage-state.json';
const DEFAULT_DAYS = 7;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CNY_TO_VND_RATE = 3600;

@Injectable()
export class AliboOrdersService {
  private readonly logger = new Logger(AliboOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async syncRecentOrders(input?: {
    days?: number;
    pageSize?: number;
  }): Promise<AliboSyncResult> {
    const days = clampInt(input?.days ?? DEFAULT_DAYS, 1, 365);
    const pageSize = clampInt(input?.pageSize ?? DEFAULT_PAGE_SIZE, 20, 200);
    const dateTo = startOfToday();
    const dateFrom = new Date(dateTo);
    dateFrom.setDate(dateTo.getDate() - days);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const context = await browser.newContext({
        storageState: this.loadStorageState(),
        ignoreHTTPSErrors: true,
      });
      context.setDefaultTimeout(45_000);
      const page = await context.newPage();

      await page.goto('https://alibo.vn/don-hang/', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await this.assertSessionIsValid(page);

      const rows: AliboRawOrder[] = [];
      let recordsTotal = 0;
      let start = 0;

      while (true) {
        const response = await this.fetchOrdersPage(page, {
          dateFrom,
          dateTo,
          start,
          length: pageSize,
        });
        const pageRows = Array.isArray(response.data)
          ? (response.data as AliboRawOrder[])
          : [];
        recordsTotal = numberValue(
          response.recordsFiltered ?? response.recordsTotal,
        );
        rows.push(...pageRows);

        if (pageRows.length === 0) break;
        start += pageRows.length;
        if (recordsTotal > 0 && start >= recordsTotal) break;
        if (start > 10_000) {
          this.logger.warn('Stopped Alibo sync after 10000 rows safety limit');
          break;
        }
      }

      await context.close();
      return this.upsertRows(rows, recordsTotal);
    } finally {
      await browser.close().catch((err: Error) => {
        this.logger.warn(`Could not close Alibo sync browser: ${err.message}`);
      });
    }
  }

  async listOrders(input?: {
    mode?: AliboOrderListMode;
    limit?: number;
  }): Promise<AliboOrder[]> {
    const mode = input?.mode ?? 'unmatched';
    const limit = clampInt(input?.limit ?? 10, 1, 50);
    return (this.prisma as any).aliboOrder.findMany({
      where:
        mode === 'matched'
          ? { matchStatus: 'MATCHED' }
          : mode === 'unmatched'
            ? { matchStatus: 'UNMATCHED' }
            : undefined,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  async findByIdOrPrefix(idOrPrefix: string): Promise<AliboOrder | null> {
    const key = idOrPrefix.trim();
    if (!key) return null;

    const exact = await (this.prisma as any).aliboOrder.findUnique({
      where: { id: key },
    });
    if (exact) return exact;

    return (this.prisma as any).aliboOrder.findFirst({
      where: {
        OR: [
          { id: { startsWith: key } },
          { lineKey: { startsWith: key } },
          { orderId: { startsWith: key } },
        ],
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  getCnyToVndRate(): number {
    const raw = this.config.get<string>('ALIBO_CNY_TO_VND_RATE');
    const parsed = raw ? Number.parseFloat(raw) : DEFAULT_CNY_TO_VND_RATE;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_CNY_TO_VND_RATE;
  }

  private async upsertRows(
    rawRows: AliboRawOrder[],
    recordsTotal: number,
  ): Promise<AliboSyncResult> {
    const rows = rawRows
      .map((row) => this.normalizeRow(row))
      .filter((row): row is NormalizedAliboOrder => row !== null);
    if (rows.length === 0) {
      return { fetched: rawRows.length, created: 0, updated: 0, skipped: 0, recordsTotal, orders: [] };
    }

    const existing: Array<{ lineKey: string }> = await (this.prisma as any).aliboOrder.findMany({
      where: { lineKey: { in: rows.map((row) => row.lineKey) } },
      select: { lineKey: true },
    });
    const existingKeys = new Set(existing.map((row) => row.lineKey));

    const orders: AliboOrder[] = [];
    for (const row of rows) {
      const order = await (this.prisma as any).aliboOrder.upsert({
        where: { lineKey: row.lineKey },
        create: {
          orderId: row.orderId,
          lineKey: row.lineKey,
          platform: row.platform,
          statusRaw: row.statusRaw,
          status: row.status,
          paidAt: row.paidAt,
          settledAt: row.settledAt,
          itemTitle: row.itemTitle,
          itemLink: row.itemLink,
          itemImage: row.itemImage,
          quantity: row.quantity,
          saleAmountCny: row.saleAmountCny,
          commissionCny: row.commissionCny,
          commissionVnd: row.commissionVnd,
          saleAmountVnd: row.saleAmountVnd,
          rawPayload: row.rawPayload,
        },
        update: {
          platform: row.platform,
          statusRaw: row.statusRaw,
          status: row.status,
          paidAt: row.paidAt,
          settledAt: row.settledAt,
          itemTitle: row.itemTitle,
          itemLink: row.itemLink,
          itemImage: row.itemImage,
          quantity: row.quantity,
          saleAmountCny: row.saleAmountCny,
          commissionCny: row.commissionCny,
          commissionVnd: row.commissionVnd,
          saleAmountVnd: row.saleAmountVnd,
          rawPayload: row.rawPayload,
        },
      });
      orders.push(order);
    }

    const created = rows.filter((row) => !existingKeys.has(row.lineKey)).length;
    return {
      fetched: rawRows.length,
      created,
      updated: rows.length - created,
      skipped: rawRows.length - rows.length,
      recordsTotal,
      orders,
    };
  }

  private normalizeRow(row: AliboRawOrder): NormalizedAliboOrder | null {
    const orderId = stringValue(row.trade_parent_id);
    if (!orderId) return null;

    const saleCny = decimalNumber(row.alipay_total_price);
    const commissionCny = decimalNumber(row.guest_income);
    const rate = this.getCnyToVndRate();
    const statusRaw = stringValue(row.tk_status) || 'Đã lên đơn';
    const itemLink = absoluteUrl(stringValue(row.item_link));
    const itemImage = absoluteUrl(stringValue(row.item_img));
    const platform = stringValue(row.product_type);
    const itemTitle = stringValue(row.item_title);

    return {
      orderId,
      lineKey: buildLineKey(orderId, row),
      platform,
      statusRaw,
      status: mapAliboStatus(statusRaw),
      paidAt: parseAliboDate(stringValue(row.tk_paid_time)),
      settledAt: parseAliboDate(stringValue(row.tk_create_time)),
      itemTitle,
      itemLink,
      itemImage,
      quantity: numberValue(row.item_num),
      saleAmountCny: saleCny === null ? null : saleCny.toFixed(2),
      commissionCny: commissionCny === null ? null : commissionCny.toFixed(2),
      commissionVnd:
        commissionCny === null ? 0 : Math.round(commissionCny * rate),
      saleAmountVnd: saleCny === null ? 0 : Math.round(saleCny * rate),
      rawPayload: toJson(row),
    };
  }

  private async fetchOrdersPage(
    page: Page,
    input: {
      dateFrom: Date;
      dateTo: Date;
      start: number;
      length: number;
    },
  ): Promise<AliboSearchResponse> {
    const result = await page.evaluate(
      async ({ dateFrom, dateTo, start, length }) => {
        const csrf =
          document.cookie
            .split('; ')
            .find((item) => item.startsWith('csrftoken='))
            ?.split('=')[1] ?? '';
        const body = new URLSearchParams({
          draw: String(Math.floor(start / length) + 1),
          'columns[0][data]': 'trade_parent_id',
          'columns[0][name]': '',
          'columns[0][searchable]': 'true',
          'columns[0][orderable]': 'false',
          'columns[0][search][value]': '',
          'columns[0][search][regex]': 'false',
          'columns[1][data]': 'product_type',
          'columns[1][name]': '',
          'columns[1][searchable]': 'true',
          'columns[1][orderable]': 'false',
          'columns[1][search][value]': '',
          'columns[1][search][regex]': 'false',
          start: String(start),
          length: String(length),
          'search[value]': '',
          'search[regex]': 'false',
          csrfmiddlewaretoken: csrf,
          time_from: dateFrom,
          time_to: dateTo,
          earning_time_from: dateFrom,
          fitler_earning_time: '1',
          platform_filter: '10',
          earning_time_to: dateTo,
          trade_id: '',
          page_index: String(Math.floor(start / length) + 1),
          search_default: '0',
          ref_name: '',
        });

        const res = await fetch('/search_transactions/', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRFToken': csrf,
          },
          body,
        });
        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          contentType: res.headers.get('content-type') ?? '',
          text,
        };
      },
      {
        dateFrom: formatAliboDate(input.dateFrom),
        dateTo: formatAliboDate(input.dateTo),
        start: input.start,
        length: input.length,
      },
    );

    if (!result.ok) {
      throw new Error(
        `Alibo search_transactions failed: status=${result.status}`,
      );
    }

    try {
      return JSON.parse(result.text) as AliboSearchResponse;
    } catch {
      throw new Error(
        `Alibo search_transactions returned non-JSON body: status=${result.status}`,
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
      throw new Error(
        'Alibo session expired. Chạy lại npm run alibo:capture-session rồi cập nhật session.',
      );
    }
  }

  private loadStorageState(): InlineStorageState {
    const rawBase64 = this.config
      .get<string>('ALIBO_STORAGE_STATE_BASE64')
      ?.trim();
    if (rawBase64) {
      return JSON.parse(
        Buffer.from(rawBase64, 'base64').toString('utf8'),
      ) as InlineStorageState;
    }

    const storageStatePath = resolve(
      process.cwd(),
      this.config.get<string>('ALIBO_STORAGE_STATE_PATH')?.trim() ||
        DEFAULT_STORAGE_STATE_PATH,
    );
    if (!existsSync(storageStatePath)) {
      throw new Error(
        'Thiếu ALIBO_STORAGE_STATE_BASE64 hoặc ALIBO_STORAGE_STATE_PATH.',
      );
    }

    return JSON.parse(readFileSync(storageStatePath, 'utf8')) as InlineStorageState;
  }
}

function buildLineKey(orderId: string, row: AliboRawOrder): string {
  const fingerprint = [
    orderId,
    stringValue(row.product_type),
    stringValue(row.item_link),
    stringValue(row.item_title),
    stringValue(row.alipay_total_price),
    stringValue(row.guest_income),
    stringValue(row.item_num),
  ].join('|');
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 16);
  return `${orderId}_${hash}`;
}

function mapAliboStatus(raw: string): TransactionStatus {
  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (normalized.includes('chot') || normalized.includes('approved')) {
    return TransactionStatus.APPROVED;
  }
  if (
    normalized.includes('huy') ||
    normalized.includes('cancel') ||
    normalized.includes('reject')
  ) {
    return TransactionStatus.REJECTED;
  }
  return TransactionStatus.PENDING;
}

function formatAliboDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

function parseAliboDate(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
  }
  const vi = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (vi) {
    return new Date(`${vi[3]}-${vi[2]}-${vi[1]}T00:00:00.000Z`);
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function absoluteUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('http')) return raw;
  return raw;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberValue(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(Math.max(parsed, min), max);
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
