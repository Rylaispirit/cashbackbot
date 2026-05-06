import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Gửi thông báo từ bot đến user. Best-effort: nếu user đã block bot
 * hoặc lỗi network, bot chỉ log warning và không làm vỡ business flow.
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

    const message = [
      '⏳ Accesstrade đã ghi nhận đơn hàng của bạn!',
      '',
      `📦 Order: ${tx.orderId}`,
      `💰 Cashback tạm tính: ${vnd(tx.userShare)} đang chờ sàn duyệt.`,
      '',
      'Số tiền này chỉ là tạm tính theo hoa hồng Accesstrade gửi về. Khi sàn duyệt đơn, cashback sẽ chuyển sang số dư có thể rút.',
      'Gõ /history để theo dõi trạng thái đơn.',
    ].join('\n');

    await this.send(Number(tx.user.telegramId), message);
  }

  async notifyTransactionApproved(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });
    if (!tx) return;

    const message = [
      '✅ Đơn hàng đã được duyệt!',
      '',
      `📦 Order: ${tx.orderId}`,
      `💰 Cashback: ${vnd(tx.userShare)} đã sẵn sàng để rút.`,
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

    const message = [
      '❌ Đơn hàng không được duyệt',
      '',
      `📦 Order: ${tx.orderId}`,
      `💸 Cashback ${vnd(tx.userShare)} đã bị huỷ.`,
      '',
      'Lý do thường gặp: đơn bị huỷ/hoàn hàng, mã khuyến mãi không tính hoa hồng, hoặc cookie tracking không match. Đơn sau vẫn có thể tracking bình thường nhé.',
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
      '',
      payout.note ? `📝 Ghi chú: ${payout.note}` : '',
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
      'Vui lòng kiểm tra thông tin bank bằng /setbank hoặc liên hệ admin nếu cần.',
    ]
      .filter(Boolean)
      .join('\n');

    await this.send(Number(payout.user.telegramId), message);
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
}

function vnd(n: number): string {
  return `${n.toLocaleString('vi-VN')}đ`;
}
