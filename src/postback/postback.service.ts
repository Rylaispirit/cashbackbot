import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccesstradePostbackDto } from './dto';

/**
 * Postback handler for Accesstrade.
 *
 * REAL AT payload shape (verified from production data):
 *   - transaction_id   ← UNIQUE per row (idempotency key)
 *   - order_id         ← merchant order, có thể repeat (main + brand bonus)
 *   - utm_source       ← bot's sub_id (e.g. "tgcmorj4xg7bb647")
 *   - reward           ← commission VND (NOT 'commission' field!)
 *   - product_price    ← sale amount (NOT 'sale_amount'!)
 *   - status           ← integer (0=pending, 1=approved, 2=rejected, ...)
 *   - is_confirmed     ← 0 or 1 — true confirmation flag
 *   - confirmed_date   ← timestamp when AT marked confirmed
 *   - product_id, product_category, click_time, sales_time, browser, ip, ...
 *
 * NOTE: AT does NOT send a `signature` field. Signature verify is disabled
 * unless ACCESSTRADE_POSTBACK_SECRET is set AND payload contains signature
 * (legacy paths). For production, rely on AT's IP whitelist or a token-in-URL.
 */
@Injectable()
export class PostbackService {
  private readonly logger = new Logger(PostbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Verify chữ ký AT — chỉ enforce khi env có set secret VÀ payload có field signature.
   * AT default không gửi signature nên function này thường return true.
   */
  verifySignature(payload: AccesstradePostbackDto, _req: Request): boolean {
    const secret = this.config.get<string>('ACCESSTRADE_POSTBACK_SECRET');
    const signature = this.toText(payload.signature);
    if (!secret || !signature) {
      // Default mode: AT không sign. Tin tưởng IP whitelist hoặc URL token.
      return true;
    }

    const orderId = this.toText(payload.order_id) ?? '';
    const subId = this.pickSubId(payload) ?? '';
    const status = this.toText(payload.status) ?? '';
    const expected = createHmac('sha256', secret)
      .update(`${orderId}${subId}${status}`)
      .digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  async processPostback(payload: AccesstradePostbackDto) {
    const orderId = this.toText(payload.order_id);
    const subId = this.pickSubId(payload);
    const externalTxId = this.toText(payload.transaction_id);

    // Log raw mọi postback để debug
    this.logger.log(
      `Postback in: tx=${externalTxId ?? '-'} order=${orderId ?? '-'} sub=${subId ?? '-'} reward=${payload.reward ?? payload.commission}`,
    );

    if (!orderId) {
      this.logger.warn(
        `Postback missing order_id. Raw: ${JSON.stringify(payload).slice(0, 500)}`,
      );
      return;
    }

    if (!externalTxId) {
      this.logger.warn(
        `Postback missing transaction_id; skipped to avoid unsafe orderId idempotency. order=${orderId} sub=${subId ?? '-'}`,
      );
      return;
    }

    if (!subId) {
      this.logger.warn(
        `Postback missing sub_id (utm_source/aff_sub/sub_id all empty). Raw: ${JSON.stringify(payload).slice(0, 500)}`,
      );
      return;
    }

    const link = await this.prisma.link.findUnique({
      where: { subId },
      include: { user: true },
    });
    if (!link) {
      this.logger.warn(`Link not found for sub_id=${subId} order=${orderId} tx=${externalTxId}`);
      return;
    }

    const grossCommission = this.parseAmount(payload.reward ?? payload.commission);
    const saleAmount = this.parseAmount(
      payload.product_price ?? payload.sale_amount,
    );
    const status = this.mapStatus(payload);

    const userRate =
      link.user.commissionRate ??
      parseInt(this.config.get<string>('USER_COMMISSION_RATE', '70'), 10);
    const userShare = Math.floor((grossCommission * userRate) / 100);
    const ownerShare = grossCommission - userShare;

    // AT transaction_id is the only safe idempotency key; order_id can repeat.
    const existing = await this.prisma.transaction.findUnique({
      where: { externalTxId },
    });

    if (existing) {
      const result = await this.handleStatusTransition(
        existing.id,
        existing.status,
        status,
      );
      if (result.updated && result.shouldNotify) {
        await this.notifyTransition(existing.id, status);
      }
      return;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const newTx = await tx.transaction.create({
        data: {
          externalTxId,
          orderId,
          subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount,
          grossCommission,
          userShare,
          ownerShare,
          status,
          rawPayload: payload as unknown as object,
          approvedAt: status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (status === TransactionStatus.PENDING) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (status === TransactionStatus.APPROVED) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      const sameOrderStatusCount = await tx.transaction.count({
        where: {
          userId: link.userId,
          orderId,
          status: { in: this.statusesForNotification(status) },
          NOT: { id: newTx.id },
        },
      });

      return {
        transaction: newTx,
        shouldNotify: sameOrderStatusCount === 0,
      };
    });

    this.logger.log(
      `Transaction created: tx=${externalTxId} order=${orderId} user=${link.userId} status=${status} userShare=${userShare}`,
    );

    if (created.shouldNotify) {
      await this.notifyTransition(created.transaction.id, status);
    }
  }

  /** Pick sub_id from various AT field names. utm_source là default chính. */
  private pickSubId(payload: AccesstradePostbackDto): string | null {
    return (
      this.toText(payload.utm_source) ??
      this.toText(payload.aff_sub) ??
      this.toText(payload.sub_id) ??
      this.toText(payload.sub1) ??
      null
    );
  }

  /**
   * Parse số tiền — AT gửi dạng "104720.0" (string với decimal). Round về int VND.
   */
  private parseAmount(raw: unknown): number {
    if (raw === null || raw === undefined || raw === '') return 0;
    const n = parseFloat(String(raw));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  /**
   * Map status từ AT về TransactionStatus.
   *
   * Pattern thấy được:
   *   status: 0 + is_confirmed: 0  → PENDING (mới track)
   *   status: 1 + is_confirmed: 1  → APPROVED (đã duyệt cuối cùng)
   *   status: 2                    → REJECTED
   *   status: 3                    → CANCELLED
   *
   * Fallback: nếu status là string ('pending', 'approved'), dùng string match.
   */
  private mapStatus(payload: AccesstradePostbackDto): TransactionStatus {
    // String form (legacy hoặc test simulator)
    const raw = String(payload.status ?? '').trim().toLowerCase();
    if (raw === 'approved' || raw === 'success' || raw === 'confirmed') {
      return TransactionStatus.APPROVED;
    }
    if (raw === 'rejected') return TransactionStatus.REJECTED;
    if (raw === 'cancelled' || raw === 'canceled') {
      return TransactionStatus.CANCELLED;
    }

    // Integer form từ AT thật
    const intStatus = parseInt(raw, 10);
    const isConfirmed = parseInt(String(payload.is_confirmed ?? '0'), 10);

    if (intStatus === 1 || isConfirmed === 1) return TransactionStatus.APPROVED;
    if (intStatus === 2) return TransactionStatus.REJECTED;
    if (intStatus === 3) return TransactionStatus.CANCELLED;

    return TransactionStatus.PENDING;
  }

  private async handleStatusTransition(
    transactionId: string,
    from: TransactionStatus,
    to: TransactionStatus,
  ): Promise<{ updated: boolean; shouldNotify: boolean }> {
    if (from === to) return { updated: false, shouldNotify: false };

    const tx = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    const userShare = tx.userShare;

    const shouldNotify = await this.prisma.$transaction(async (db) => {
      if (from === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { decrement: userShare } },
        });
      } else if (from === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { decrement: userShare } },
        });
      }

      if (to === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (to === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      await db.transaction.update({
        where: { id: transactionId },
        data: {
          status: to,
          approvedAt: to === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (this.notificationKind(from) === this.notificationKind(to)) {
        return false;
      }

      const sameOrderStatusCount = await db.transaction.count({
        where: {
          userId: tx.userId,
          orderId: tx.orderId,
          status: { in: this.statusesForNotification(to) },
          NOT: { id: transactionId },
        },
      });

      return sameOrderStatusCount === 0;
    });

    this.logger.log(`Transaction ${transactionId} status: ${from} → ${to}`);
    return { updated: true, shouldNotify };
  }

  private async notifyTransition(transactionId: string, to: TransactionStatus) {
    if (to === TransactionStatus.PENDING) {
      await this.notifications.notifyTransactionPending(transactionId);
    } else if (to === TransactionStatus.APPROVED) {
      await this.notifications.notifyTransactionApproved(transactionId);
    } else if (
      to === TransactionStatus.REJECTED ||
      to === TransactionStatus.CANCELLED
    ) {
      await this.notifications.notifyTransactionRejected(transactionId);
    }
  }

  private statusesForNotification(status: TransactionStatus): TransactionStatus[] {
    if (
      status === TransactionStatus.REJECTED ||
      status === TransactionStatus.CANCELLED
    ) {
      return [TransactionStatus.REJECTED, TransactionStatus.CANCELLED];
    }
    return [status];
  }

  private notificationKind(status: TransactionStatus): string {
    return this.statusesForNotification(status).join('|');
  }

  private toText(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    return text.length > 0 ? text : null;
  }
}
