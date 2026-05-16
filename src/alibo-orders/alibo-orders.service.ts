import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContextOptions, Page } from 'playwright';

import { PrismaService } from '../prisma/prisma.service';
import { extractAlibabaItemId } from '../affiliate/url-detector';
import { extractAliboEncodedId, titleSimilarity } from '../affiliate/product-metadata';

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

export type AliboMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AliboMatchCandidate {
  order: AliboOrder;
  itemId: string | null;
  confidence: AliboMatchConfidence;
  reason: string;
  link?: AliboMatchLink;
  alternatives?: number;
}

export interface AliboAutoMatchResult {
  scanned: number;
  high: AliboMatchCandidate[];
  medium: AliboMatchCandidate[];
  low: AliboMatchCandidate[];
  applied: {
    matched: number;
    statusUpdated: number;
    skipped: number;
    errors: number;
    notifications: Array<{ transactionId: string; status: TransactionStatus }>;
  };
  dryRun: boolean;
}

type AliboMatchLink = {
  id: string;
  subId: string;
  userId: string;
  createdAt: Date;
  originalUrl: string;
};

type AliboMatchApplyResult = {
  action: 'matched' | 'status_updated' | 'skipped';
  transactionId?: string;
  status?: TransactionStatus;
};


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

    const orders: AliboOrder[] = [];
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const existingByKey = await (this.prisma as any).aliboOrder.findUnique({
        where: { lineKey: row.lineKey },
        select: { id: true, lineKey: true },
      });
      const existingByStableFields =
        existingByKey ??
        (await (this.prisma as any).aliboOrder.findFirst({
          where: {
            orderId: row.orderId,
            platform: row.platform,
            itemLink: row.itemLink,
            itemTitle: row.itemTitle,
            quantity: row.quantity,
          },
          select: { id: true, lineKey: true },
          orderBy: { updatedAt: 'desc' },
        }));

      const data = {
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
      };

      const order = existingByStableFields
        ? await (this.prisma as any).aliboOrder.update({
            where: { id: existingByStableFields.id },
            data,
          })
        : await (this.prisma as any).aliboOrder.create({ data });

      if (existingByStableFields) updated++;
      else created++;
      orders.push(order);
    }


    return {
      fetched: rawRows.length,
      created,
      updated,
      skipped: rawRows.length - rows.length,
      recordsTotal,
      orders,
    };
  }

  /**
   * Scan recent UNMATCHED Alibo orders and propose Link matches with confidence.
   * - HIGH: 1 candidate, link.createdAt strictly < order.paidAt, within window
   * - MEDIUM: 1 candidate but link.createdAt > paidAt by < 1h (timezone slack)
   * - LOW: missing itemId / paidAt / commission, or 0 / multiple candidates
   *
   * Only HIGH cases auto-apply when {apply: true}. MEDIUM/LOW always require admin review.
   * Already MATCHED orders are reconciled only in apply mode, so sync/dry never mutates balances.
   */
  async autoMatchOrders(input?: {
    days?: number;
    apply?: boolean;
  }): Promise<AliboAutoMatchResult> {
    const days = clampInt(input?.days ?? 7, 1, 365);
    const apply = input?.apply === true;
    const windowHours = clampInt(
      parseInt(this.config.get<string>('ALIBO_MATCH_WINDOW_HOURS') ?? '48', 10) || 48,
      1,
      720,
    );
    const toleranceMinutes = clampInt(
      parseInt(this.config.get<string>('ALIBO_MATCH_TIMEZONE_TOLERANCE_MINUTES') ?? '60', 10) || 60,
      0,
      720,
    );

    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - days * 24 * 3600_000);
    const recentWhere = {
      OR: [
        { paidAt: { gte: dateFrom, lte: dateTo } },
        { paidAt: null, createdAt: { gte: dateFrom, lte: dateTo } },
      ],
    };

    const unmatchedOrders: AliboOrder[] = await (this.prisma as any).aliboOrder.findMany({
      where: {
        matchStatus: 'UNMATCHED',
        ...recentWhere,
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });

    const matchedOrders: AliboOrder[] = apply
      ? await (this.prisma as any).aliboOrder.findMany({
          where: {
            matchStatus: 'MATCHED',
            ...recentWhere,
          },
          orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
          take: 500,
        })
      : [];

    const result: AliboAutoMatchResult = {
      scanned: unmatchedOrders.length + matchedOrders.length,
      high: [],
      medium: [],
      low: [],
      applied: {
        matched: 0,
        statusUpdated: 0,
        skipped: 0,
        errors: 0,
        notifications: [],
      },
      dryRun: !apply,
    };

    for (const order of unmatchedOrders) {
      const proposal = await this.evaluateMatch(order, windowHours, toleranceMinutes);
      if (proposal.confidence === 'HIGH') result.high.push(proposal);
      else if (proposal.confidence === 'MEDIUM') result.medium.push(proposal);
      else result.low.push(proposal);
    }

    if (!apply) return result;

    for (const proposal of result.high) {
      if (!proposal.link) continue;
      try {
        const applied = await this.applyMatch(proposal.order, proposal.link);
        this.recordApplyResult(result, applied);
      } catch (err) {
        result.applied.errors++;
        this.logger.warn(
          `[alibo-automatch:apply] order=${proposal.order.orderId} failed: ${(err as Error).message}`,
        );
      }
    }

    for (const order of matchedOrders) {
      try {
        const link = await this.resolveMatchedLink(order);
        if (!link) {
          result.applied.skipped++;
          this.logger.warn(
            `[alibo-automatch:reconcile] order=${order.orderId} skipped: matched link missing`,
          );
          continue;
        }
        const applied = await this.applyMatch(order, link);
        this.recordApplyResult(result, applied);
      } catch (err) {
        result.applied.errors++;
        this.logger.warn(
          `[alibo-automatch:reconcile] order=${order.orderId} failed: ${(err as Error).message}`,
        );
      }
    }

    return result;
  }

  private recordApplyResult(
    result: AliboAutoMatchResult,
    applied: AliboMatchApplyResult,
  ): void {
    if (applied.action === 'matched') result.applied.matched++;
    else if (applied.action === 'status_updated') result.applied.statusUpdated++;
    else result.applied.skipped++;

    if (applied.transactionId && applied.status) {
      result.applied.notifications.push({
        transactionId: applied.transactionId,
        status: applied.status,
      });
    }
  }

  private async resolveMatchedLink(
    order: AliboOrder,
  ): Promise<AliboMatchLink | null> {
    let linkId = order.matchedLinkId;
    let subId = order.matchedSubId;

    if ((!linkId || !subId) && order.transactionId) {
      const transaction = await this.prisma.transaction.findUnique({
        where: { id: order.transactionId },
        select: { linkId: true, subId: true },
      });
      linkId = linkId ?? transaction?.linkId ?? null;
      subId = subId ?? transaction?.subId ?? null;
    }

    const link = await this.prisma.link.findFirst({
      where: {
        network: 'alibo',
        ...(linkId ? { id: linkId } : subId ? { subId } : { id: '__missing__' }),
      },
      select: {
        id: true,
        subId: true,
        userId: true,
        createdAt: true,
        originalUrl: true,
      },
    });

    return link ?? null;
  }

  /**
   * Safe matcher used by /admin_alibo_auto_match.
   * It creates a transaction for a new HIGH-confidence order, or reconciles an
   * already matched order when Alibo later changes status or commission amount.
   */
  private async applyMatch(
    order: AliboOrder,
    link: AliboMatchLink,
  ): Promise<AliboMatchApplyResult> {
    const externalTxId = `alibo_${order.lineKey}`;

    return this.prisma.$transaction(async (tx) => {
      const existingByLineKey = await tx.transaction.findUnique({
        where: { externalTxId },
      });
      const existing = existingByLineKey
        ? existingByLineKey
        : order.transactionId
          ? await tx.transaction.findUnique({ where: { id: order.transactionId } })
          : null;
      const isRejectedLike =
        order.status === TransactionStatus.REJECTED ||
        order.status === TransactionStatus.CANCELLED;

      if (!existing && (!Number.isFinite(order.commissionVnd) || order.commissionVnd <= 0)) {
        return { action: 'skipped' as const };
      }
      if (
        existing &&
        (!Number.isFinite(order.commissionVnd) || order.commissionVnd <= 0) &&
        !isRejectedLike
      ) {
        return { action: 'skipped' as const };
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: link.userId },
      });
      const defaultRate = clampInt(
        parseInt(this.config.get<string>('ALIBO_DEFAULT_USER_RATE') ?? '60', 10) || 60,
        0,
        100,
      );
      const rate = user.commissionRate ?? defaultRate;
      const grossCommission = isRejectedLike
        ? Math.max(0, order.commissionVnd)
        : order.commissionVnd;
      const userShare = Math.floor((grossCommission * rate) / 100);
      const ownerShare = grossCommission - userShare;

      if (existing) {
        if (
          existing.subId !== link.subId ||
          existing.linkId !== link.id ||
          existing.userId !== link.userId
        ) {
          throw new Error(
            `externalTxId ${externalTxId} belongs to another link/user: txSub=${existing.subId}, linkSub=${link.subId}`,
          );
        }

        const externalTxChanged = existing.externalTxId !== externalTxId;
        const existingRaw = toRecord(existing.rawPayload);
        const migratedRaw = externalTxChanged
          ? {
              ...existingRaw,
              previousExternalTxId: existing.externalTxId,
              lineKeyMigratedAt: new Date().toISOString(),
            }
          : existingRaw;
        const amountChanged =
          existing.grossCommission !== grossCommission ||
          existing.saleAmount !== order.saleAmountVnd;
        const statusChanged = existing.status !== order.status;

        await (tx as any).aliboOrder.update({
          where: { id: order.id },
          data: {
            matchStatus: 'MATCHED',
            matchedSubId: link.subId,
            matchedLinkId: link.id,
            transactionId: existing.id,
            matchedAt: order.matchedAt ?? new Date(),
          },
        });

        if (externalTxChanged) {
          await tx.transaction.update({
            where: { id: existing.id },
            data: {
              externalTxId,
              rawPayload: migratedRaw as any,
            },
          });
        }

        if (!statusChanged && !amountChanged) {
          return { action: 'skipped' as const };
        }

        if (existing.status === TransactionStatus.PENDING) {
          await tx.user.update({
            where: { id: existing.userId },
            data: { balancePending: { decrement: existing.userShare } },
          });
        } else if (existing.status === TransactionStatus.APPROVED) {
          await tx.user.update({
            where: { id: existing.userId },
            data: { balanceAvail: { decrement: existing.userShare } },
          });
        }

        if (order.status === TransactionStatus.PENDING) {
          await tx.user.update({
            where: { id: link.userId },
            data: { balancePending: { increment: userShare } },
          });
        } else if (order.status === TransactionStatus.APPROVED) {
          await tx.user.update({
            where: { id: link.userId },
            data: { balanceAvail: { increment: userShare } },
          });
        }

        const updated = await tx.transaction.update({
          where: { id: existing.id },
          data: {
            externalTxId,
            status: order.status,
            grossCommission,
            userShare,
            ownerShare,
            saleAmount: order.saleAmountVnd,
            approvedAt:
              order.status === TransactionStatus.APPROVED
                ? existing.approvedAt ?? new Date()
                : null,
            rawPayload: {
              ...migratedRaw,
              updateSource: 'alibo_automatch_reconcile',
              aliboOrderId: order.id,
              lineKey: order.lineKey,
              statusRaw: order.statusRaw,
              previousStatus: existing.status,
              previousGrossCommission: existing.grossCommission,
              previousSaleAmount: existing.saleAmount,
              previousUserShare: existing.userShare,
              reconciledAt: new Date().toISOString(),
            },
          },
        });
        return {
          action: 'status_updated' as const,
          transactionId: updated.id,
          status: updated.status,
        };
      }

      const newTx = await tx.transaction.create({
        data: {
          externalTxId,
          orderId: order.orderId,
          subId: link.subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount: order.saleAmountVnd,
          grossCommission,
          userShare,
          ownerShare,
          status: order.status,
          rawPayload: {
            source: 'alibo_automatch_strategy_b',
            aliboOrderId: order.id,
            lineKey: order.lineKey,
            statusRaw: order.statusRaw,
          },
          approvedAt:
            order.status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (order.status === TransactionStatus.PENDING) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (order.status === TransactionStatus.APPROVED) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      await (tx as any).aliboOrder.update({
        where: { id: order.id },
        data: {
          matchStatus: 'MATCHED',
          matchedSubId: link.subId,
          matchedLinkId: link.id,
          transactionId: newTx.id,
          matchedAt: new Date(),
        },
      });

      return {
        action: 'matched' as const,
        transactionId: newTx.id,
        status: newTx.status,
      };
    });
  }

  /**
   * Evaluate a single order — returns proposal with confidence + chosen link (if any).
   */
  private async evaluateMatch(
    order: AliboOrder,
    windowHours: number,
    toleranceMinutes: number,
  ): Promise<AliboMatchCandidate> {
    if (!order.itemLink) {
      return { order, itemId: null, confidence: 'LOW', reason: 'no itemLink' };
    }
    if (!order.paidAt) {
      return { order, itemId: null, confidence: 'LOW', reason: 'no paidAt — cannot direction-check' };
    }
    if (!Number.isFinite(order.commissionVnd) || order.commissionVnd <= 0) {
      return { order, itemId: null, confidence: 'LOW', reason: `commission=${order.commissionVnd} — wait for settled commission` };
    }

    const orderItemId = extractAlibabaItemId(order.itemLink); // numeric (or null if encoded)
    const orderAliboEncodedId = extractAliboEncodedId(order.itemLink);

    const since = new Date(order.paidAt.getTime() - windowHours * 3600_000);
    const tolerance = toleranceMinutes * 60_000;
    const upper = new Date(order.paidAt.getTime() + tolerance);

    const linkSummary = (link: any) => ({
      id: link.id,
      subId: link.subId,
      userId: link.userId,
      createdAt: link.createdAt,
      originalUrl: link.originalUrl,
    });

    // === Tier 3 — alibo encoded id exact match (zero ambiguity) ===
    if (orderAliboEncodedId) {
      const byEncoded: any[] = await (this.prisma as any).link.findMany({
        where: {
          network: 'alibo',
          aliboEncodedId: orderAliboEncodedId,
          createdAt: { gte: since, lte: upper },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (byEncoded.length === 1) {
        return {
          order,
          itemId: orderItemId,
          confidence: 'HIGH',
          reason: `Tier 3: aliboEncodedId exact match (${orderAliboEncodedId})`,
          link: linkSummary(byEncoded[0]),
        };
      }
      if (byEncoded.length > 1) {
        return {
          order,
          itemId: orderItemId,
          confidence: 'LOW',
          reason: `Tier 3 ambiguous: ${byEncoded.length} Links share encoded id`,
          alternatives: byEncoded.length,
        };
      }
    }

    // === Tier 1 — numeric itemId match (canonicalItemId OR originalUrl contains) ===
    if (orderItemId) {
      const byItemId: any[] = await (this.prisma as any).link.findMany({
        where: {
          network: 'alibo',
          OR: [
            { canonicalItemId: orderItemId },
            { originalUrl: { contains: orderItemId } },
          ],
          createdAt: { gte: since, lte: upper },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (byItemId.length === 1) {
        const link = byItemId[0];
        const strict = link.createdAt.getTime() <= order.paidAt.getTime();
        return {
          order,
          itemId: orderItemId,
          confidence: strict ? 'HIGH' : 'MEDIUM',
          reason: strict
            ? `Tier 1: itemId match, link.createdAt <= paidAt`
            : `Tier 1: itemId match but link.createdAt > paidAt by ${Math.round((link.createdAt.getTime() - order.paidAt.getTime()) / 60_000)}min (timezone slack)`,
          link: linkSummary(link),
        };
      }
      if (byItemId.length > 1) {
        return {
          order,
          itemId: orderItemId,
          confidence: 'LOW',
          reason: `Tier 1 ambiguous: ${byItemId.length} Links with itemId=${orderItemId} in window`,
          alternatives: byItemId.length,
        };
      }
    }

    // === Tier 2 — fuzzy title match (alibo's itemTitle vs Link.productTitle) ===
    if (order.itemTitle) {
      const titleCandidates: any[] = await (this.prisma as any).link.findMany({
        where: {
          network: 'alibo',
          productTitle: { not: null },
          createdAt: { gte: since, lte: upper },
        },
        orderBy: { createdAt: 'desc' },
        take: 50, // wider net for fuzzy scoring
      });
      const scored = titleCandidates
        .map((link) => ({
          link,
          score: titleSimilarity(order.itemTitle ?? '', link.productTitle ?? ''),
        }))
        .filter((c) => c.score >= 0.7)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 1 || (scored.length > 1 && scored[0].score >= scored[1].score + 0.15)) {
        const best = scored[0];
        const strict = best.link.createdAt.getTime() <= order.paidAt.getTime();
        // Title-only match never auto-applies — protect against SKU/name collisions.
        // Admin must review via /admin_alibo_orders unmatched.
        const conf: AliboMatchConfidence = 'MEDIUM';
        return {
          order,
          itemId: orderItemId,
          confidence: conf,
          reason: `Tier 2: title similarity ${(best.score * 100).toFixed(0)}% — MEDIUM only (review required, never auto-credit)`,
          link: linkSummary(best.link),
        };
      }
      if (scored.length > 1) {
        return {
          order,
          itemId: orderItemId,
          confidence: 'LOW',
          reason: `Tier 2 ambiguous: top ${scored.length} title scores ${scored
            .slice(0, 3)
            .map((c) => (c.score * 100).toFixed(0) + '%')
            .join(',')}`,
          alternatives: scored.length,
        };
      }
    }

    return {
      order,
      itemId: orderItemId,
      confidence: 'LOW',
      reason: 'no match across Tier 1/2/3 (no canonical itemId, no title match, no alibo encoded id)',
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
  const itemLink = absoluteUrl(stringValue(row.item_link));
  const itemId = itemLink ? extractAlibabaItemId(itemLink) : null;
  const fingerprint = [
    orderId,
    stringValue(row.product_type),
    itemId ? `item:${itemId}` : normalizeStableItemUrl(itemLink),
    stringValue(row.item_title),
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
  const iso = trimmed.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (iso) {
    return localDate(
      numberValue(iso[1]),
      numberValue(iso[2]),
      numberValue(iso[3]),
      numberValue(iso[4]),
      numberValue(iso[5]),
      numberValue(iso[6]),
    );
  }
  const vi = trimmed.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (vi) {
    return localDate(
      numberValue(vi[3]),
      numberValue(vi[2]),
      numberValue(vi[1]),
      numberValue(vi[4]),
      numberValue(vi[5]),
      numberValue(vi[6]),
    );
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | null {
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeStableItemUrl(raw: string | null): string {
  if (!raw) return '';
  const withoutHash = raw.trim().split('#')[0] ?? '';
  try {
    const url = new URL(withoutHash);
    const params = [...url.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const search = params.length
      ? `?${params.map(([key, value]) => `${key}=${value}`).join('&')}`
      : '';
    return `${url.hostname}${url.pathname}${search}`.toLowerCase();
  } catch {
    return withoutHash
      .replace(/^https?:\/\//i, '')
      .replace(/^\/\//, '')
      .toLowerCase();
  }
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

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
