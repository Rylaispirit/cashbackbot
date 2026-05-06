import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccesstradePostbackDto } from './dto';

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
    if (!payload.signature) return false;

    const subId = getPostbackSubId(payload) ?? '';
    const expected = createHmac('sha256', secret)
      .update(`${payload.order_id}${subId}${payload.status}`)
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
    const subId = getPostbackSubId(payload);
    if (!subId) {
      this.logger.warn(`Postback missing sub_id: order=${payload.order_id}`);
      return;
    }

    const link = await this.prisma.link.findUnique({
      where: { subId },
      include: { user: true },
    });
    if (!link) {
      this.logger.warn(`Link not found for sub_id=${subId} order=${payload.order_id}`);
      return;
    }

    const status = mapStatus(payload.status);
    const grossCommission = parseInt(payload.commission ?? '0', 10);
    const saleAmount = parseInt(payload.sale_amount ?? '0', 10);

    const userRate =
      link.user.commissionRate ??
      parseInt(this.config.get<string>('USER_COMMISSION_RATE', '70'), 10);
    const userShare = Math.floor((grossCommission * userRate) / 100);
    const ownerShare = grossCommission - userShare;

    const existing = await this.prisma.transaction.findUnique({
      where: { orderId: payload.order_id },
    });

    if (existing) {
      const updated = await this.handleStatusTransition(
        existing.id,
        existing.status,
        status,
      );
      // Gửi notify nếu status thay đổi sang APPROVED hoặc REJECTED
      if (updated) await this.notifyTransition(existing.id, status);
      return;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const newTx = await tx.transaction.create({
        data: {
          orderId: payload.order_id,
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

      return newTx;
    });

    this.logger.log(
      `Transaction created: order=${payload.order_id} user=${link.userId} status=${status} userShare=${userShare}`,
    );

    // Notify lần đầu nếu đơn vào thẳng APPROVED hoặc REJECTED (không qua PENDING)
    if (status === TransactionStatus.APPROVED) {
      this.notifications.notifyTransactionApproved(created.id).catch(() => {});
    } else if (
      status === TransactionStatus.REJECTED ||
      status === TransactionStatus.CANCELLED
    ) {
      this.notifications.notifyTransactionRejected(created.id).catch(() => {});
    }
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
    if (to === TransactionStatus.APPROVED) {
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
  if (s.includes('approve') || s === 'success' || s === 'confirmed')
    return TransactionStatus.APPROVED;
  if (s.includes('reject')) return TransactionStatus.REJECTED;
  if (s.includes('cancel')) return TransactionStatus.CANCELLED;
  return TransactionStatus.PENDING;
}

function getPostbackSubId(payload: AccesstradePostbackDto): string | undefined {
  return payload.aff_sub ?? payload.sub_id ?? payload.sub1;
}
