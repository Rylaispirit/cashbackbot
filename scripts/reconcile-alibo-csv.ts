/**
 * Reconcile alibo CSV report — batch import từ file CSV export trên dashboard alibo.vn
 *
 * Cách dùng:
 *   npm run reconcile:alibo -- --file=data/alibo-report.csv [--status=pending|approved|rejected] [--dry]
 *
 * Flow:
 *   1. Đọc CSV (delimiter auto detect: tab/comma/semicolon)
 *   2. Với mỗi row, parse: order_id, item_id, commission_vnd, sale_vnd, click_time, status_alibo, sub_id (nếu có)
 *   3. Match với Link table:
 *      a) Nếu CSV có sub_id → match exact subId
 *      b) Nếu không, match theo item_id + click_time window ±48h
 *   4. Tạo Transaction (idempotent theo orderId)
 *   5. In report
 *
 * Lưu ý format CSV alibo:
 *   Headers thường gặp (alibo có thể đổi):
 *     orderID, itemId, commission, payAmount, clickTime, status, subId
 *     "Mã đơn", "Item ID", "Hoa hồng", "Tổng tiền", "Thời gian click", "Trạng thái", "Sub ID"
 *
 *   Script tự fuzzy-match header — nếu fail thì dùng cờ --map=... để override.
 *   Vd: --map="orderID:order_id,itemId:item_id,commission:commission,..."
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, Transaction, TransactionStatus } from '@prisma/client';

interface Args {
  file: string;
  status: TransactionStatus;
  dry: boolean;
  windowHours: number;
  map?: Record<string, string>;
}

function parseArgs(): Args {
  const get = (name: string, def?: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;
  const flag = (name: string): boolean => process.argv.includes(`--${name}`);

  const statusRaw = (get('status', 'pending') ?? 'pending').toLowerCase();
  const status =
    statusRaw === 'approved'
      ? TransactionStatus.APPROVED
      : statusRaw === 'rejected'
        ? TransactionStatus.REJECTED
        : statusRaw === 'cancelled' || statusRaw === 'canceled'
          ? TransactionStatus.CANCELLED
          : TransactionStatus.PENDING;

  const file = get('file');
  if (!file) throw new Error('Missing --file=path/to/csv');

  const mapRaw = get('map');
  const map = mapRaw
    ? mapRaw.split(',').reduce<Record<string, string>>((acc, kv) => {
        const [k, v] = kv.split(':');
        const key = k?.trim();
        const value = v?.trim();
        if (key && value) {
          acc[key] = value;
          acc[fuzzyHeader(key)] = value;
        }
        return acc;
      }, {})
    : undefined;

  return {
    file,
    status,
    dry: flag('dry'),
    windowHours: parseInt(get('window', '48') ?? '48', 10),
    map,
  };
}

function detectDelimiter(line: string): string {
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const c of line) {
    if (c in counts) counts[c as keyof typeof counts]++;
  }
  return Object.entries(counts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? ',';
}

function parseCsvLine(line: string, delim: string): string[] {
  // Simple parser — không support escaped quotes nested
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === delim && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/^"|"$/g, ''));
}

interface Row {
  orderId: string;
  itemId: string;
  commissionVnd: number;
  saleVnd: number;
  clickTime?: Date;
  subIdRaw?: string;
  raw: Record<string, string>;
}

function fuzzyHeader(header: string): string {
  const noAccent = header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  return header
    ? noAccent
    .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
      .replace(/^id$/, 'orderid')
    : '';
}

const HEADER_ALIASES: Record<string, string> = {
  // orderId
  orderid: 'orderId',
  order_id: 'orderId',
  madon: 'orderId',
  madonhang: 'orderId',
  ordercode: 'orderId',
  ordernumber: 'orderId',
  donhang: 'orderId',
  订单号: 'orderId',
  订单编号: 'orderId',
  // itemId
  itemid: 'itemId',
  item_id: 'itemId',
  productid: 'itemId',
  goodsid: 'itemId',
  masanpham: 'itemId',
  masp: 'itemId',
  商品id: 'itemId',
  商品编号: 'itemId',
  // commission
  commission: 'commissionVnd',
  commissionvnd: 'commissionVnd',
  commission_vnd: 'commissionVnd',
  hoahong: 'commissionVnd',
  hoanchietkhau: 'commissionVnd',
  tienhoahong: 'commissionVnd',
  rebate: 'commissionVnd',
  cashback: 'commissionVnd',
  佣金: 'commissionVnd',
  预估佣金: 'commissionVnd',
  // saleAmount
  payamount: 'saleVnd',
  totalamount: 'saleVnd',
  saleamount: 'saleVnd',
  sale_vnd: 'saleVnd',
  totalprice: 'saleVnd',
  giadon: 'saleVnd',
  tongtien: 'saleVnd',
  giatridon: 'saleVnd',
  成交金额: 'saleVnd',
  付款金额: 'saleVnd',
  // clickTime
  clicktime: 'clickTime',
  click_time: 'clickTime',
  thoigianclick: 'clickTime',
  thoigian: 'clickTime',
  createtime: 'clickTime',
  createdat: 'clickTime',
  点击时间: 'clickTime',
  创建时间: 'clickTime',
  // sub_id
  subid: 'subIdRaw',
  sub_id: 'subIdRaw',
  utmsource: 'subIdRaw',
  utm_source: 'subIdRaw',
  affsub: 'subIdRaw',
  aff_sub: 'subIdRaw',
  customparam: 'subIdRaw',
  自定义参数: 'subIdRaw',
};

function canonicalField(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return HEADER_ALIASES[fuzzyHeader(raw)] ?? raw;
}

function mapHeaders(
  headers: string[],
  override: Record<string, string> | undefined,
): Map<string, number> {
  const m = new Map<string, number>();
  headers.forEach((h, idx) => {
    const fz = fuzzyHeader(h);
    let canonical = HEADER_ALIASES[fz];
    if (override && (override[h] || override[fz])) {
      canonical = canonicalField(override[h] ?? override[fz]);
    }
    if (canonical) m.set(canonical, idx);
  });
  return m;
}

function parseAmountVnd(raw: string): number {
  if (!raw) return 0;
  // Loại bỏ non-numeric (chỉ giữ số, dấu phẩy, dấu chấm)
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  const normalizeSingleSeparator = (value: string, sep: ',' | '.'): string => {
    const parts = value.split(sep);
    const last = parts.at(-1) ?? '';
    const allGroupsLookLikeThousands =
      parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    if (allGroupsLookLikeThousands || last.length > 2) {
      return value.replaceAll(sep, '');
    }
    return value.replace(sep, '.');
  };

  let n = 0;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    n =
      lastDot > lastComma
        ? parseFloat(cleaned.replace(/,/g, ''))
        : parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    n = parseFloat(normalizeSingleSeparator(cleaned, ','));
  } else if (cleaned.includes('.') && !cleaned.includes(',')) {
    n = parseFloat(normalizeSingleSeparator(cleaned, '.'));
  } else {
    n = parseFloat(cleaned);
  }
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseDate(raw: string): Date | undefined {
  if (!raw) return undefined;
  // Try DD/MM/YYYY HH:mm:ss first. JS Date otherwise treats 06/05 as MM/DD.
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && m[1] && m[2] && m[3]) {
    const [, dd, mm, yy, hh = '0', mi = '0', ss = '0'] = m;
    const d2 = new Date(
      parseInt(yy, 10),
      parseInt(mm, 10) - 1,
      parseInt(dd, 10),
      parseInt(hh, 10),
      parseInt(mi, 10),
      parseInt(ss, 10),
    );
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;
  return undefined;
}

async function transitionTransactionStatus(
  prisma: PrismaClient,
  existing: Transaction,
  to: TransactionStatus,
  raw: Record<string, string>,
): Promise<Transaction> {
  return prisma.$transaction(async (db) => {
    if (existing.status === TransactionStatus.PENDING) {
      await db.user.update({
        where: { id: existing.userId },
        data: { balancePending: { decrement: existing.userShare } },
      });
    } else if (existing.status === TransactionStatus.APPROVED) {
      await db.user.update({
        where: { id: existing.userId },
        data: { balanceAvail: { decrement: existing.userShare } },
      });
    }

    if (to === TransactionStatus.PENDING) {
      await db.user.update({
        where: { id: existing.userId },
        data: { balancePending: { increment: existing.userShare } },
      });
    } else if (to === TransactionStatus.APPROVED) {
      await db.user.update({
        where: { id: existing.userId },
        data: { balanceAvail: { increment: existing.userShare } },
      });
    }

    return db.transaction.update({
      where: { id: existing.id },
      data: {
        status: to,
        approvedAt: to === TransactionStatus.APPROVED ? new Date() : null,
        rawPayload: {
          source: 'csv_reconcile_status_update',
          previousStatus: existing.status,
          csv: raw,
        },
      },
    });
  });
}

async function main() {
  const args = parseArgs();
  const filepath = path.resolve(args.file);
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV phải có ít nhất 1 header + 1 row');

  const headerLine = lines[0]!;
  const delim = detectDelimiter(headerLine);
  const headers = parseCsvLine(headerLine, delim);
  const headerMap = mapHeaders(headers, args.map);

  console.log('═══════════════════════════════════════════');
  console.log('  Alibo CSV Reconcile');
  console.log('═══════════════════════════════════════════');
  console.log(`File:        ${filepath}`);
  console.log(`Rows:        ${lines.length - 1}`);
  console.log(`Delimiter:   ${JSON.stringify(delim)}`);
  console.log(`Status:      ${args.status}`);
  console.log(`Dry run:     ${args.dry}`);
  console.log(`Window:      ±${args.windowHours}h`);
  console.log(`Headers:     ${headers.join(', ')}`);
  console.log(`Mapped:      ${[...headerMap.entries()].map(([k, v]) => `${k}=col${v}`).join(', ') || '(none — paste --map=...)'}`);
  console.log('');

  if (!headerMap.has('orderId')) {
    throw new Error(
      'Không detect được cột orderId. Dùng --map="header_thực:orderId,..." để override.',
    );
  }

  const prisma = new PrismaClient();
  const userRate = parseInt(process.env.ALIBO_DEFAULT_USER_RATE ?? '60', 10);

  const stats = {
    created: 0,
    updated: 0,
    skippedNoChange: 0,
    unmatched: 0,
    errors: 0,
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!, delim);
    const get = (key: string): string => {
      const idx = headerMap.get(key);
      return idx === undefined ? '' : cols[idx] ?? '';
    };

    const row: Row = {
      orderId: get('orderId'),
      itemId: get('itemId'),
      commissionVnd: parseAmountVnd(get('commissionVnd')),
      saleVnd: parseAmountVnd(get('saleVnd')),
      clickTime: parseDate(get('clickTime')),
      subIdRaw: get('subIdRaw') || undefined,
      raw: Object.fromEntries(headers.map((h, idx) => [h, cols[idx] ?? ''])),
    };

    if (!row.orderId) {
      stats.errors++;
      console.log(`row ${i}: SKIP (no orderId)`);
      continue;
    }

    // Try match
    let link;
    if (row.subIdRaw && row.subIdRaw.startsWith('tg')) {
      link = await prisma.link.findUnique({ where: { subId: row.subIdRaw } });
    }
    if (!link && row.itemId && row.clickTime) {
      const since = new Date(row.clickTime.getTime() - args.windowHours * 3600_000);
      const until = new Date(row.clickTime.getTime() + args.windowHours * 3600_000);
      link = await prisma.link.findFirst({
        where: {
          network: 'alibo',
          originalUrl: { contains: row.itemId },
          createdAt: { gte: since, lte: until },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!link) {
      stats.unmatched++;
      console.log(`row ${i}: ✗ UNMATCHED order=${row.orderId} item=${row.itemId} click=${row.clickTime?.toISOString() ?? '-'}`);
      continue;
    }

    // Idempotent
    const existing = await prisma.transaction.findUnique({
      where: { orderId: row.orderId },
    });
    if (existing) {
      if (existing.status === args.status) {
        stats.skippedNoChange++;
        console.log(`row ${i}: ⊘ SKIP existing order=${row.orderId} status=${existing.status}`);
        continue;
      }

      if (args.dry) {
        stats.updated++;
        console.log(
          `row ${i}: → WOULD UPDATE order=${row.orderId} ${existing.status} -> ${args.status}`,
        );
        continue;
      }

      const updated = await transitionTransactionStatus(
        prisma,
        existing,
        args.status,
        row.raw,
      );
      stats.updated++;
      console.log(
        `row ${i}: ✓ UPDATED order=${row.orderId} ${existing.status} -> ${updated.status}`,
      );
      continue;
    }

    if (args.dry) {
      console.log(
        `row ${i}: → MATCH order=${row.orderId} → subId=${link.subId} commission=${row.commissionVnd}đ`,
      );
      stats.created++;
      continue;
    }

    // Create transaction
    const userInfo = await prisma.user.findUnique({ where: { id: link.userId } });
    const rate = userInfo?.commissionRate ?? userRate;
    const userShare = Math.floor((row.commissionVnd * rate) / 100);
    const ownerShare = row.commissionVnd - userShare;

    await prisma.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          orderId: row.orderId,
          subId: link.subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount: row.saleVnd,
          grossCommission: row.commissionVnd,
          userShare,
          ownerShare,
          status: args.status,
          rawPayload: { source: 'csv_reconcile', csv: row.raw },
          approvedAt: args.status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (args.status === TransactionStatus.PENDING) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (args.status === TransactionStatus.APPROVED) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }
    });

    stats.created++;
    console.log(
      `row ${i}: ✓ CREATED order=${row.orderId} subId=${link.subId} commission=${row.commissionVnd}đ userShare=${userShare}đ`,
    );
  }

  await prisma.$disconnect();

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`  Created:             ${stats.created}${args.dry ? ' (dry)' : ''}`);
  console.log(`  Updated status:      ${stats.updated}${args.dry ? ' (dry)' : ''}`);
  console.log(`  Skipped no change:   ${stats.skippedNoChange}`);
  console.log(`  Unmatched (no link): ${stats.unmatched}`);
  console.log(`  Errors:              ${stats.errors}`);
  console.log('═══════════════════════════════════════════');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
