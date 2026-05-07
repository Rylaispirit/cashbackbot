import { Injectable } from '@nestjs/common';
import { Transaction, TransactionStatus, PayoutStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const [
      userCount,
      linkCount,
      txPending,
      txApproved,
      payoutPending,
      revenue,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.link.count(),
      this.prisma.transaction.count({ where: { status: TransactionStatus.PENDING } }),
      this.prisma.transaction.count({ where: { status: TransactionStatus.APPROVED } }),
      this.prisma.payout.count({
        where: { status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] } },
      }),
      this.prisma.transaction.aggregate({
        where: { status: TransactionStatus.APPROVED },
        _sum: { ownerShare: true, grossCommission: true, userShare: true },
      }),
    ]);

    return {
      userCount,
      linkCount,
      txPending,
      txApproved,
      payoutPending,
      grossCommission: revenue._sum.grossCommission ?? 0,
      ownerRevenue: revenue._sum.ownerShare ?? 0,
      paidToUsers: revenue._sum.userShare ?? 0,
    };
  }

  async getUserDetail(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({
      where: { telegramId },
      include: {
        _count: { select: { links: true, transactions: true, payouts: true } },
      },
    });
    return user;
  }

  async listRecentTransactions(limit = 10) {
    return this.prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { telegramId: true, username: true } } },
    });
  }

  async listRecentLinks(limit = 10) {
    return this.prisma.link.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: {
            telegramId: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        _count: { select: { transactions: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            orderId: true,
            status: true,
            userShare: true,
            grossCommission: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getLinkDetail(subIdOrPrefix: string) {
    const include = {
      user: {
        select: {
          telegramId: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      transactions: {
        orderBy: { createdAt: 'desc' as const },
        take: 10,
      },
    };

    const exact = await this.prisma.link.findUnique({
      where: { subId: subIdOrPrefix },
      include,
    });
    if (exact) return exact;

    return this.prisma.link.findFirst({
      where: { subId: { startsWith: subIdOrPrefix } },
      orderBy: { createdAt: 'desc' },
      include,
    });
  }

  async findAliboLinkBySubIdPrefix(subIdOrPrefix: string) {
    return this.prisma.link.findFirst({
      where: {
        network: 'alibo',
        subId: { startsWith: subIdOrPrefix },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async blockUser(telegramId: bigint, blocked: boolean) {
    return this.prisma.user.update({
      where: { telegramId },
      data: { isBlocked: blocked },
    });
  }

  /**
   * List link Taobao/Tmall/1688 (network='alibo') chưa có transaction nào.
   * Dùng cho admin reconcile thủ công với report alibo.vn.
   */
  async listAliboPendingLinks(limit = 30) {
    return this.prisma.link.findMany({
      where: {
        network: 'alibo',
        transactions: { none: {} },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: {
            telegramId: true,
            username: true,
            firstName: true,
          },
        },
      },
    });
  }

  /**
   * Tạo Transaction thủ công cho 1 Link (cho alibo reconciliation).
   * Admin nhập commission gross + status, system tự tính userShare/ownerShare
   * theo ALIBO_DEFAULT_USER_RATE (hoặc commissionRate của user nếu có).
   */
  async createManualAliboTransaction(input: {
    subId: string;
    orderId: string;
    grossCommission: number;
    saleAmount: number;
    status: TransactionStatus;
    userRate: number;
    note?: string;
  }): Promise<{
    transaction: Transaction;
    action: 'created' | 'updated' | 'skipped';
  }> {
    const link = await this.prisma.link.findUnique({
      where: { subId: input.subId },
      include: { user: true },
    });
    if (!link) throw new Error(`Không tìm thấy link với subId=${input.subId}`);

    const existing = await this.prisma.transaction.findUnique({
      where: { orderId: input.orderId },
    });
    if (existing) {
      if (existing.subId !== input.subId) {
        throw new Error(
          `Order ${input.orderId} đã tồn tại nhưng thuộc subId khác: ${existing.subId}`,
        );
      }
      if (existing.status === input.status) {
        return { transaction: existing, action: 'skipped' };
      }
      const updated = await this.transitionTransactionStatus(
        existing.id,
        existing.status,
        input.status,
        input.note,
      );
      return { transaction: updated, action: 'updated' };
    }

    const rate = link.user.commissionRate ?? input.userRate;
    const userShare = Math.floor((input.grossCommission * rate) / 100);
    const ownerShare = input.grossCommission - userShare;

    const created = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          orderId: input.orderId,
          subId: input.subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount: input.saleAmount,
          grossCommission: input.grossCommission,
          userShare,
          ownerShare,
          status: input.status,
          rawPayload: {
            source: 'manual_alibo',
            note: input.note ?? '',
            createdBy: 'admin',
          },
          approvedAt: input.status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (input.status === TransactionStatus.PENDING) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (input.status === TransactionStatus.APPROVED) {
        await tx.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      return created;
    });

    return { transaction: created, action: 'created' };
  }

  private async transitionTransactionStatus(
    transactionId: string,
    from: TransactionStatus,
    to: TransactionStatus,
    note?: string,
  ) {
    return this.prisma.$transaction(async (db) => {
      const tx = await db.transaction.findUniqueOrThrow({
        where: { id: transactionId },
      });

      if (from === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { decrement: tx.userShare } },
        });
      } else if (from === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { decrement: tx.userShare } },
        });
      }

      if (to === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { increment: tx.userShare } },
        });
      } else if (to === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { increment: tx.userShare } },
        });
      }

      return db.transaction.update({
        where: { id: transactionId },
        data: {
          status: to,
          approvedAt: to === TransactionStatus.APPROVED ? new Date() : null,
          rawPayload: {
            source: 'manual_alibo_status_update',
            note: note ?? '',
            previousStatus: from,
          },
        },
      });
    });
  }
}
