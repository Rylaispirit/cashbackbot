import { Injectable } from '@nestjs/common';
import { Transaction, TransactionStatus, PayoutStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

type AliboOrder = {
  id: string;
  orderId: string;
  lineKey: string;
  statusRaw: string;
  status: TransactionStatus;
  commissionCny: { toString(): string } | null;
  saleAmountCny: { toString(): string } | null;
  commissionVnd: number;
  saleAmountVnd: number;
} & Record<string, any>;

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
      userCashback,
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
        _sum: { userShare: true },
      }),
    ]);

    return {
      userCount,
      linkCount,
      txPending,
      txApproved,
      payoutPending,
      paidToUsers: userCashback._sum.userShare ?? 0,
    };
  }

  async getUserDetail(telegramId: bigint) {
    return this.prisma.user.findUnique({
      where: { telegramId },
      include: {
        _count: { select: { links: true, transactions: true, payouts: true } },
      },
    });
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

    const existingExternalId = `alibo_${input.orderId}`;
    const existing = await this.prisma.transaction.findUnique({
      where: { externalTxId: existingExternalId },
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
      const newTx = await tx.transaction.create({
        data: {
          externalTxId: existingExternalId,
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

      return newTx;
    });

    return { transaction: created, action: 'created' };
  }

  async matchSyncedAliboOrder(input: {
    aliboOrderId: string;
    subId: string;
    status: TransactionStatus;
    userRate: number;
    commissionVndOverride?: number;
    note?: string;
  }): Promise<{
    order: AliboOrder;
    transaction: Transaction;
    action: 'created' | 'updated' | 'skipped';
  }> {
    const [order, link] = await Promise.all([
      (this.prisma as any).aliboOrder.findUnique({
        where: { id: input.aliboOrderId },
      }),
      this.prisma.link.findUnique({
        where: { subId: input.subId },
        include: { user: true },
      }),
    ]);

    if (!order) throw new Error(`Không tìm thấy đơn Alibo ${input.aliboOrderId}`);
    if (!link) throw new Error(`Không tìm thấy link với subId=${input.subId}`);
    if (link.network !== 'alibo') {
      throw new Error(`Link ${input.subId} không phải link Alibo/Taobao`);
    }

    const grossCommission =
      input.commissionVndOverride ?? order.commissionVnd;
    if (!Number.isFinite(grossCommission) || grossCommission <= 0) {
      throw new Error(
        'Commission VND của đơn Alibo đang bằng 0. Hãy truyền commission_vnd_override.',
      );
    }

    const externalTxId = `alibo_${order.lineKey}`;
    const existing = await this.prisma.transaction.findUnique({
      where: { externalTxId },
    });
    const rate = link.user.commissionRate ?? input.userRate;

    if (existing) {
      if (existing.subId !== input.subId) {
        throw new Error(
          `Đơn ${order.orderId} đã được match với subId khác: ${existing.subId}`,
        );
      }

      const updatedOrder = await this.markAliboOrderMatched({
        orderId: order.id,
        subId: input.subId,
        linkId: link.id,
        transactionId: existing.id,
      });

      if (
        existing.status === input.status &&
        existing.grossCommission === grossCommission &&
        existing.saleAmount === order.saleAmountVnd
      ) {
        return { order: updatedOrder, transaction: existing, action: 'skipped' };
      }

      const updated = await this.updateAliboTransactionFromMatch({
        transactionId: existing.id,
        from: existing.status,
        to: input.status,
        grossCommission,
        saleAmount: order.saleAmountVnd,
        rate,
        note: input.note,
      });
      return { order: updatedOrder, transaction: updated, action: 'updated' };
    }

    const userShare = Math.floor((grossCommission * rate) / 100);
    const ownerShare = grossCommission - userShare;

    const created = await this.prisma.$transaction(async (db) => {
      const newTx = await db.transaction.create({
        data: {
          externalTxId,
          orderId: order.orderId,
          subId: input.subId,
          userId: link.userId,
          linkId: link.id,
          saleAmount: order.saleAmountVnd,
          grossCommission,
          userShare,
          ownerShare,
          status: input.status,
          rawPayload: {
            source: 'alibo_order_sync',
            aliboOrderId: order.id,
            lineKey: order.lineKey,
            statusRaw: order.statusRaw,
            commissionCny: decimalToString(order.commissionCny),
            saleAmountCny: decimalToString(order.saleAmountCny),
            commissionVndOverride: input.commissionVndOverride ?? null,
            note: input.note ?? '',
          },
          approvedAt:
            input.status === TransactionStatus.APPROVED ? new Date() : null,
        },
      });

      if (input.status === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: link.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (input.status === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: link.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      await (db as any).aliboOrder.update({
        where: { id: order.id },
        data: {
          matchStatus: 'MATCHED',
          matchedSubId: input.subId,
          matchedLinkId: link.id,
          transactionId: newTx.id,
          matchedAt: new Date(),
        },
      });

      return newTx;
    });

    const updatedOrder = await (this.prisma as any).aliboOrder.findUniqueOrThrow({
      where: { id: order.id },
    });

    return { order: updatedOrder, transaction: created, action: 'created' };
  }

  private async markAliboOrderMatched(input: {
    orderId: string;
    subId: string;
    linkId: string;
    transactionId: string;
  }): Promise<AliboOrder> {
    return (this.prisma as any).aliboOrder.update({
      where: { id: input.orderId },
      data: {
        matchStatus: 'MATCHED',
        matchedSubId: input.subId,
        matchedLinkId: input.linkId,
        transactionId: input.transactionId,
        matchedAt: new Date(),
      },
    });
  }

  private async updateAliboTransactionFromMatch(input: {
    transactionId: string;
    from: TransactionStatus;
    to: TransactionStatus;
    grossCommission: number;
    saleAmount: number;
    rate: number;
    note?: string;
  }): Promise<Transaction> {
    const userShare = Math.floor((input.grossCommission * input.rate) / 100);
    const ownerShare = input.grossCommission - userShare;

    return this.prisma.$transaction(async (db) => {
      const tx = await db.transaction.findUniqueOrThrow({
        where: { id: input.transactionId },
      });

      if (input.from === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { decrement: tx.userShare } },
        });
      } else if (input.from === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { decrement: tx.userShare } },
        });
      }

      if (input.to === TransactionStatus.PENDING) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balancePending: { increment: userShare } },
        });
      } else if (input.to === TransactionStatus.APPROVED) {
        await db.user.update({
          where: { id: tx.userId },
          data: { balanceAvail: { increment: userShare } },
        });
      }

      const raw = tx.rawPayload as Record<string, unknown> | null;
      return db.transaction.update({
        where: { id: input.transactionId },
        data: {
          saleAmount: input.saleAmount,
          grossCommission: input.grossCommission,
          userShare,
          ownerShare,
          status: input.to,
          approvedAt:
            input.to === TransactionStatus.APPROVED ? new Date() : null,
          rawPayload: {
            ...(raw ?? {}),
            updateNote: input.note ?? '',
            amountUpdatedBy: 'admin_alibo_match_order',
            previousGrossCommission: tx.grossCommission,
            previousUserShare: tx.userShare,
          },
        },
      });
    });
  }

  private async transitionTransactionStatus(
    transactionId: string,
    from: TransactionStatus,
    to: TransactionStatus,
    note?: string,
  ): Promise<Transaction> {
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

      const data: Record<string, unknown> = {
        status: to,
        approvedAt: to === TransactionStatus.APPROVED ? new Date() : null,
      };
      if (note) {
        const raw = tx.rawPayload as Record<string, unknown> | null;
        data.rawPayload = { ...(raw ?? {}), updateNote: note };
      }
      return db.transaction.update({
        where: { id: transactionId },
        data,
      });
    });
  }
}

function decimalToString(value: { toString(): string } | null): string | null {
  return value ? value.toString() : null;
}
