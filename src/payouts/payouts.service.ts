import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Payout, PayoutStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async createWithdrawRequest(userId: string): Promise<Payout> {
    const minPayout = parseInt(
      this.config.get<string>('MIN_PAYOUT_AMOUNT', '50000'),
      10,
    );

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.isBlocked) {
      throw new BadRequestException('Tài khoản đang bị khoá. Liên hệ admin.');
    }
    if (!user.bankName || !user.bankAccount || !user.bankHolder) {
      throw new BadRequestException(
        'Bạn chưa cài đặt tài khoản nhận tiền. Gõ /setbank.',
      );
    }
    if (user.balanceAvail < minPayout) {
      throw new BadRequestException(
        `Số dư rút tối thiểu là ${minPayout.toLocaleString('vi-VN')}đ. Bạn còn thiếu ${(minPayout - user.balanceAvail).toLocaleString('vi-VN')}đ.`,
      );
    }

    const existing = await this.prisma.payout.findFirst({
      where: {
        userId,
        status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      },
    });
    if (existing) {
      throw new BadRequestException(
        'Bạn đã có yêu cầu rút đang xử lý. Đợi admin xử lý xong nhé.',
      );
    }

    const amount = user.balanceAvail;

    return this.prisma.$transaction(async (tx) => {
      const payout = await tx.payout.create({
        data: {
          userId,
          amount,
          status: PayoutStatus.PENDING,
          bankName: user.bankName,
          bankAccount: user.bankAccount,
          bankHolder: user.bankHolder,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { balanceAvail: { decrement: amount } },
      });
      this.logger.log(
        `Payout ${payout.id} created for user=${userId} amount=${amount}`,
      );
      return payout;
    });
  }

  async markPaid(payoutId: string, note?: string): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Payout không tồn tại');
    if (payout.status === PayoutStatus.PAID) {
      throw new BadRequestException('Payout đã được đánh dấu paid');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payout.update({
        where: { id: payoutId },
        data: {
          status: PayoutStatus.PAID,
          paidAt: new Date(),
          note,
        },
      });
      await tx.user.update({
        where: { id: payout.userId },
        data: { totalPaidOut: { increment: payout.amount } },
      });
      return updated;
    });

    // Notify user — không await để tránh block caller
    this.notifications.notifyPayoutPaid(result.id).catch(() => {});
    return result;
  }

  async cancel(payoutId: string, note?: string): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Payout không tồn tại');
    if (payout.status === PayoutStatus.PAID) {
      throw new BadRequestException('Payout đã paid, không thể huỷ');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payout.update({
        where: { id: payoutId },
        data: { status: PayoutStatus.FAILED, note },
      });
      await tx.user.update({
        where: { id: payout.userId },
        data: { balanceAvail: { increment: payout.amount } },
      });
      return updated;
    });

    this.notifications.notifyPayoutCancelled(result.id).catch(() => {});
    return result;
  }

  async listPending(limit = 20): Promise<(Payout & { telegramId: bigint })[]> {
    const rows = await this.prisma.payout.findMany({
      where: {
        status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((p) => ({ ...p, telegramId: p.user.telegramId }));
  }
}
