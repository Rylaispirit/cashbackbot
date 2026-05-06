import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface UpsertTelegramUserInput {
  telegramId: number | bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tạo user nếu chưa có, update info nếu đã có. Idempotent.
   */
  async upsertTelegramUser(input: UpsertTelegramUserInput): Promise<User> {
    const telegramId = BigInt(input.telegramId);
    return this.prisma.user.upsert({
      where: { telegramId },
      update: {
        username: input.username ?? undefined,
        firstName: input.firstName ?? undefined,
        lastName: input.lastName ?? undefined,
      },
      create: {
        telegramId,
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
      },
    });
  }

  async findByTelegramId(telegramId: number | bigint): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
    });
  }

  async getBalanceSummary(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return {
      available: user.balanceAvail,
      pending: user.balancePending,
      totalPaidOut: user.totalPaidOut,
    };
  }

  async updateBankInfo(
    userId: string,
    data: { bankName: string; bankAccount: string; bankHolder: string },
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  /**
   * Lấy lịch sử giao dịch của user (mới nhất trước).
   */
  async getTransactionHistory(userId: string, limit = 10) {
    return this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        link: { select: { merchant: true, originalUrl: true } },
      },
    });
  }

  async getUntrackedLinkHistory(userId: string, limit = 5) {
    return this.prisma.link.findMany({
      where: {
        userId,
        transactions: { none: {} },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        subId: true,
        merchant: true,
        createdAt: true,
      },
    });
  }

  /**
   * Lấy lịch sử payout của user.
   */
  async getPayoutHistory(userId: string, limit = 10) {
    return this.prisma.payout.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
