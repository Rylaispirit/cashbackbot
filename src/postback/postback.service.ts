import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccesstradePostbackDto } from './dto';

interface NormalizedAccesstradePostback {
  orderId: string;
  displayOrderId: string;
  subId: string;
  status: TransactionStatus;
  grossCommission: number;
  saleAmount: number;
  rawStatus: string;
}

@Injectable()
export class PostbackService {
  private readonly logger = new Logger(PostbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Verify signature của AT.
   * Default: HMAC-SHA256(order_id + sub_id + status, secret) hex
   * Đổi cho khớp template AT cấu hình thực tế nếu khác.
   */
  verifySignature(payload: AccesstradePostbackDto, _req: Request): boolean {
    const secret = this.config.get<string>('ACCESSTRADE_POSTBACK_SECRET');
    if (!secret) {
      this.logger.warn(
        'ACCESSTRADE_POSTBACK_SECRET trống — postback không được verify (CHỈ DÙNG DEV)',
      );
      return true;
    }
    if (!payload.signature) {
      return this.isTrustedUnsignedAccesstradePayload(payload);
    }

    const subId = getPostbackSubId(payload) ?? '';
    const orderId = getPostbackOrderId(payload) ?? '';
    const status = getPostbackStatusRaw(payload);
    const expected = createHmac('sha256', secret)
      .update(`${orderId}${subId}${status}`)
      .digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(payload.signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  async processPostback(payload: AccesstradePostbackDto) {
    const normalized = normalizePostback(payload);
    if (!normalized) {
      this.logger.warn(
        `Postback missing required fields: order=${getPostbackOrderId(payload) ?? '-'} sub=${getPostbackSubId(payload) ?? '-'}`,
      );
      return;
    }

    const link = await this.prisma.link.findUnique({
      where: { subId: normalized.subId },
      include: { user: true },
    });
    if (!link) {
      this.logger.warn(
        `Link not found for sub_id=${normalized.subId} order=${normalized.orderId}`,
      );
      return;
    }

    const userRate =
      link.user.commissionRate ??
      parseInt(this.config.get<string>('USER_COMMISSION_RATE', '70'), 10);
    const userShare = Math.floor((normalized.grossCommission * userRate) / 100);
    const ownerShare = normalized.grossCommission - userShare;

    const existingAggregate =
      normalized.displayOrderId !== normalized.orderId
        ? await this.prisma.transaction.findUnique({
            where: { orderId: normalized.displayOrderId },
          })
        : null;

    if (existingAggregate) {
      const updated = await this.handleStatusTransition(
        existingAggregate.id,
        existingAggregate.status,
        normalized.status,
      );
      if (updated) await this.notifyTransition(existingAggregate.id, normalized.status);
      return;
    }

    const existing = await this.prisma.transaction.findUnique({
      where: { orderId: normalized.orderId },
    });

    if (existing) {
      const updated = await this.handleStatusTransition(
        existing.id,
        existing.status,
        normalized.status,
      );
      // Notify user only when Accesstrade changes the tracked order status.
      if (updated) await this.notifyTransition(existing.id, normalized.status);
      return;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const newTx = await tx.transaction.create({
        data: {
          orderId: normalized.orderId,
          subId: normalized.subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount: normalized.saleAmount,
          grossCommission: normalized.grossCommission,
          userShare,
          ownerShare,
          status: normalized.status,
          rawPayload: payload as unknown as object,
          approvedAt:
            normalized.status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (normalized.status === TransactionStatus.PENDING) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (normalized.status === TransactionStatus.APPROVED) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      return newTx;
    });

    this.logger.log(
      `Transaction created: order=${normalized.orderId} user=${link.userId} status=${normalized.status} userShare=${userShare}`,
    );

    // Notify the first time Accesstrade sends this order to our system.
    if (normalized.status === TransactionStatus.PENDING) {
      this.notifications.notifyTransactionPending(created.id).catch(() => {});
    } else if (normalized.status === TransactionStatus.APPROVED) {
      this.notifications.notifyTransactionApproved(created.id).catch(() => {});
    } else if (
      normalized.status === TransactionStatus.REJECTED ||
      normalized.status === TransactionStatus.CANCELLED
    ) {
      this.notifications.notifyTransactionRejected(created.id).catch(() => {});
    }
  }

  private isTrustedUnsignedAccesstradePayload(
    payload: AccesstradePostbackDto,
  ): boolean {
    const allowUnsigned = this.config.get<string>(
      'ACCESSTRADE_ALLOW_UNSIGNED_POSTBACK',
      'true',
    );
    if (allowUnsigned.toLowerCase() === 'false') return false;

    const normalized = normalizePostback(payload);
    if (!normalized) return false;
    if (!payload.transaction_id || !payload.campaign_id) return false;

    const allowedCampaignIds = [
      this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_SHOPEE'),
      this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_LAZADA'),
      this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_TIKI'),
      this.config.get<string>('ACCESSTRADE_CAMPAIGN_ID_TIKTOK'),
      // Verified Shopee Smartlink fallback used by production.
      '4751584435713464237',
    ].filter(Boolean);

    const campaignOk = allowedCampaignIds.includes(payload.campaign_id);
    if (!campaignOk) {
      this.logger.warn(
        `Unsigned postback rejected: unknown campaign_id=${payload.campaign_id}`,
      );
    }
    return campaignOk;
  }

  /**
   * Trả về true nếu thực sự có chuyển status (không phải no-op).
   */
  private async handleStatusTransition(
    transactionId: string,
    from: TransactionStatus,
    to: TransactionStatus,
  ): Promise<boolean> {
    if (from === to) return false;

    const tx = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });
    const userShare = tx.userShare;

    await this.prisma.$transaction(async (db) => {
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
    });

    this.logger.log(`Transaction ${transactionId} status: ${from} → ${to}`);
    return true;
  }

  private async notifyTransition(transactionId: string, to: TransactionStatus) {
    if (to === TransactionStatus.PENDING) {
      this.notifications.notifyTransactionPending(transactionId).catch(() => {});
    } else if (to === TransactionStatus.APPROVED) {
      this.notifications.notifyTransactionApproved(transactionId).catch(() => {});
    } else if (
      to === TransactionStatus.REJECTED ||
      to === TransactionStatus.CANCELLED
    ) {
      this.notifications.notifyTransactionRejected(transactionId).catch(() => {});
    }
  }
}

function mapStatus(raw: string): TransactionStatus {
  const s = raw.toLowerCase();
  if (s === '1') return TransactionStatus.APPROVED;
  if (s === '2') return TransactionStatus.REJECTED;
  if (s === '0') return TransactionStatus.PENDING;
  if (s.includes('approve') || s === 'success' || s === 'confirmed')
    return TransactionStatus.APPROVED;
  if (s.includes('new') || s.includes('pending')) return TransactionStatus.PENDING;
  if (s.includes('reject')) return TransactionStatus.REJECTED;
  if (s.includes('cancel')) return TransactionStatus.CANCELLED;
  return TransactionStatus.PENDING;
}

function getPostbackSubId(payload: AccesstradePostbackDto): string | undefined {
  return payload.aff_sub ?? payload.sub_id ?? payload.sub1 ?? payload.utm_source;
}

function getPostbackOrderId(payload: AccesstradePostbackDto): string | undefined {
  return payload.order_id;
}

function getPostbackStatusRaw(payload: AccesstradePostbackDto): string {
  if (payload.is_confirmed === '1') return 'approved';
  if (payload.status !== undefined && payload.status !== null) {
    return String(payload.status);
  }
  return payload.is_confirmed ?? 'pending';
}

function parseMoney(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(String(raw).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizePostback(
  payload: AccesstradePostbackDto,
): NormalizedAccesstradePostback | null {
  const orderId = getPostbackOrderId(payload);
  const subId = getPostbackSubId(payload);
  if (!orderId || !subId) return null;

  const rawStatus = getPostbackStatusRaw(payload);
  return {
    // Accesstrade can send multiple rows for one marketplace order. Use
    // transaction_id as the unique DB orderId so bonus/product rows are not lost.
    orderId: payload.transaction_id ?? orderId,
    displayOrderId: orderId,
    subId,
    status: mapStatus(rawStatus),
    rawStatus,
    grossCommission: parseMoney(payload.commission ?? payload.reward),
    saleAmount: parseMoney(payload.sale_amount ?? payload.product_price),
  };
}
