import { Injectable } from '@nestjs/common';
import { TransactionStatus, PayoutStatus } from '@prisma/client';

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

  async blockUser(telegramId: bigint, blocked: boolean) {
    return this.prisma.user.update({
      where: { telegramId },
      data: { isBlocked: blocked },
    });
  }
}
