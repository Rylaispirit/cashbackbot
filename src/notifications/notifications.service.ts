import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { TransactionStatus } from '@prisma/client';
import { Telegraf, Context } from 'telegraf';

import { PrismaService } from '../prisma/prisma.service';

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
  blocked: number;
}

interface DealSubscriptionUser {
  user: { id: string; telegramId: bigint };
}

interface DealSubscriptionDelegate {
  findMany(args: unknown): Promise<DealSubscriptionUser[]>;
}

/**
 * Gửi thông báo từ bot đến user. Best-effort — nếu user đã block bot
 * hoặc lỗi network, ta nuốt error để không vỡ flow business chính.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly prisma: PrismaService,
  ) {}


  async notifyTransactionPending(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });
    if (!tx) return;
    const amount = await this.orderNotificationAmount(tx.userId, tx.orderId, [
      TransactionStatus.PENDING,
    ]);

    const message = [
      '🛒 Đơn hàng đã được hệ thống Cashback ghi nhận!',
      '',
      `📦 Order: ${tx.orderId}`,
      `💰 Cashback dự kiến: ${vnd(amount)} (đang chờ duyệt)`,
      '',
      'Đơn cần được sàn xác nhận sau 1.5-3 tháng. Khi duyệt, tiền sẽ chuyển sang số dư có thể rút.',
    ].join('\n');

    await this.send(Number(tx.user.telegramId), message);
  }

  async notifyTransactionApproved(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });
    if (!tx) return;
    const amount = await this.orderNotificationAmount(tx.userId, tx.orderId, [
      TransactionStatus.APPROVED,
    ]);

    const message = [
      '✅ Đơn hàng đã được duyệt!',
      '',
      `📦 Order: ${tx.orderId}`,
      `💰 Cashback: ${vnd(amount)} đã sẵn sàng để rút.`,
      '',
      'Gõ /balance để xem số dư hoặc /withdraw để rút tiền.',
    ].join('\n');

    await this.send(Number(tx.user.telegramId), message);
  }

  async notifyTransactionRejected(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });
    if (!tx) return;
    const amount = await this.orderNotificationAmount(tx.userId, tx.orderId, [
      TransactionStatus.REJECTED,
      TransactionStatus.CANCELLED,
    ]);

    const message = [
      '❌ Đơn hàng không được duyệt',
      '',
      `📦 Order: ${tx.orderId}`,
      `💸 Cashback ${vnd(amount)} đã bị huỷ.`,
      '',
      'Lý do thường gặp: đơn bị huỷ/hoàn hàng, mua giá khuyến mãi không tính hoa hồng, hoặc cookie tracking không match. Đừng buồn — đơn sau sẽ tracking ổn hơn 💪',
    ].join('\n');

    await this.send(Number(tx.user.telegramId), message);
  }

  async notifyPayoutPaid(payoutId: string): Promise<void> {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { user: true },
    });
    if (!payout) return;

    const message = [
      '🎉 Đã chuyển tiền vào tài khoản của bạn!',
      '',
      `💸 Số tiền: ${vnd(payout.amount)}`,
      `🏦 ${payout.bankName} - ${payout.bankAccount}`,
      `👤 ${payout.bankHolder}`,
      payout.note ? `📝 Ghi chú: ${payout.note}` : '',
      '',
      'Cảm ơn bạn đã tin dùng ChotDeal! Tiếp tục mua sắm để nhận thêm cashback nhé 🛒',
    ]
      .filter(Boolean)
      .join('\n');

    await this.send(Number(payout.user.telegramId), message);
  }

  async notifyPayoutCancelled(payoutId: string): Promise<void> {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { user: true },
    });
    if (!payout) return;

    const message = [
      '⚠️ Yêu cầu rút tiền đã bị huỷ',
      '',
      `💸 Số tiền: ${vnd(payout.amount)} đã được hoàn lại số dư.`,
      payout.note ? `📝 Lý do: ${payout.note}` : '',
      '',
      'Vui lòng kiểm tra thông tin bank (gõ /setbank) hoặc liên hệ admin nếu cần.',
    ]
      .filter(Boolean)
      .join('\n');

    await this.send(Number(payout.user.telegramId), message);
  }

  async broadcastToActiveUsers(text: string): Promise<BroadcastResult> {
    const users = await this.prisma.user.findMany({
      where: { isBlocked: false },
      select: { id: true, telegramId: true },
      orderBy: { createdAt: 'asc' },
    });

    const result: BroadcastResult = {
      total: users.length,
      sent: 0,
      failed: 0,
      blocked: 0,
    };

    for (const user of users) {
      const status = await this.sendBroadcastMessage(
        Number(user.telegramId),
        text,
      );

      if (status === 'sent') {
        result.sent += 1;
      } else if (status === 'blocked') {
        result.blocked += 1;
        await this.prisma.user
          .update({
            where: { id: user.id },
            data: { isBlocked: true },
          })
          .catch(() => undefined);
      } else {
        result.failed += 1;
      }

      await sleep(80);
    }

    return result;
  }

  async broadcastDealToActiveUsers(
    dealId: string,
    text: string,
  ): Promise<BroadcastResult> {
    const deal = await this.prisma.deal.findUnique({
      where: { id: dealId },
      select: { merchant: true },
    });
    const merchants = ['all', deal?.merchant].filter(Boolean) as string[];
    const subscriptions = await this.dealSubscriptions().findMany({
      where: {
        isEnabled: true,
        category: 'all',
        merchant: { in: merchants },
        user: { isBlocked: false },
      },
      select: {
        user: { select: { id: true, telegramId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const userMap = new Map<
      string,
      { id: string; telegramId: bigint }
    >();
    for (const subscription of subscriptions) {
      userMap.set(subscription.user.id, subscription.user);
    }
    const users = Array.from(userMap.values());

    const result: BroadcastResult = {
      total: users.length,
      sent: 0,
      failed: 0,
      blocked: 0,
    };

    for (const user of users) {
      const status = await this.sendBroadcastMessage(
        Number(user.telegramId),
        text,
        dealId,
      );

      if (status === 'sent') {
        result.sent += 1;
      } else if (status === 'blocked') {
        result.blocked += 1;
        await this.prisma.user
          .update({
            where: { id: user.id },
            data: { isBlocked: true },
          })
          .catch(() => undefined);
      } else {
        result.failed += 1;
      }

      await sleep(100);
    }

    return result;
  }

  private dealSubscriptions(): DealSubscriptionDelegate {
    return (this.prisma as unknown as { dealSubscription: DealSubscriptionDelegate })
      .dealSubscription;
  }

  async sendAdminTest(chatId: number, text: string): Promise<boolean> {
    return (await this.sendBroadcastMessage(chatId, text)) === 'sent';
  }

  async sendDealTest(
    chatId: number,
    dealId: string,
    text: string,
  ): Promise<boolean> {
    return (await this.sendBroadcastMessage(chatId, text, dealId)) === 'sent';
  }

  private async orderNotificationAmount(
    userId: string,
    orderId: string,
    statuses: TransactionStatus[],
  ): Promise<number> {
    const sum = await this.prisma.transaction.aggregate({
      where: {
        userId,
        orderId,
        status: { in: statuses },
      },
      _sum: { userShare: true },
    });

    return sum._sum.userShare ?? 0;
  }

  private async send(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      this.logger.warn(
        `Send notification to chat=${chatId} failed: ${(err as Error).message}`,
      );
    }
  }

  private async sendBroadcastMessage(
    chatId: number,
    text: string,
    dealId?: string,
  ): Promise<'sent' | 'blocked' | 'failed'> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
        ...(dealId
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🛒 Lấy link cashback',
                      callback_data: `deal:${dealId}`,
                    },
                  ],
                ],
              },
            }
          : {}),
      });
      return 'sent';
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Broadcast to chat=${chatId} failed: ${message}`);
      if (/bot was blocked|user is deactivated|chat not found|forbidden/i.test(message)) {
        return 'blocked';
      }
      return 'failed';
    }
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vnd(n: number): string {
  return `${n.toLocaleString('vi-VN')}đ`;
}
