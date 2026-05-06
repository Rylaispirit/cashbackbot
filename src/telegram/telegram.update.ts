import { Logger } from '@nestjs/common';
import { Update, Start, Help, Command, On, Ctx } from 'nestjs-telegraf';
import { Scenes } from 'telegraf';

import { UsersService } from '../users/users.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { extractFirstSupportedUrl } from '../affiliate/url-detector';
import { PayoutsService } from '../payouts/payouts.service';
import { RateLimitService } from './rate-limit.service';
import { SETBANK_SCENE_ID } from './scenes/setbank.scene';

type Context = Scenes.SceneContext;
const ACCESSSTRADE_TRACKING_WAIT_HOURS = 72;
const ACCESSSTRADE_TRACKING_WAIT_MS =
  ACCESSSTRADE_TRACKING_WAIT_HOURS * 60 * 60 * 1000;

const WELCOME_MESSAGE = `🎯 Chào mừng bạn đến với ChotDeal!

Bot hoàn tiền cashback cho đơn Shopee, Lazada, Tiki, TikTok Shop.
Sắp tới: Taobao, 1688 cho hàng order Trung Quốc.

📌 Cách dùng:
1. Copy link sản phẩm bất kỳ
2. Paste vào đây cho bot
3. Bot trả link cashback - mở link đó để mua
4. Đơn được duyệt - tiền tự về ví trong bot

🎮 Lệnh hữu ích:
/balance - xem số dư
/history - lịch sử giao dịch
/setbank - cài tài khoản nhận tiền
/withdraw - yêu cầu rút tiền
/help - xem lại hướng dẫn`;

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly affiliateService: AffiliateService,
    private readonly payoutsService: PayoutsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    await this.usersService.upsertTelegramUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });
    await ctx.reply(WELCOME_MESSAGE);
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(WELCOME_MESSAGE);
  }

  @Command('balance')
  async onBalance(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.usersService.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Bạn chưa đăng ký. Gõ /start để bắt đầu.');
      return;
    }

    const balance = await this.usersService.getBalanceSummary(user.id);
    await ctx.reply(
      [
        '💰 Số dư cashback của bạn',
        '',
        `✅ Có thể rút: ${formatVnd(balance.available)}`,
        `⏳ Đang chờ duyệt: ${formatVnd(balance.pending)}`,
        `📤 Đã rút: ${formatVnd(balance.totalPaidOut)}`,
        '',
        'ℹ️ Đơn cần 1.5-3 tháng để sàn xác nhận trước khi tiền chuyển sang trạng thái có thể rút.',
      ].join('\n'),
    );
  }

  @Command('history')
  async onHistory(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.usersService.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Bạn chưa đăng ký. Gõ /start để bắt đầu.');
      return;
    }

    const untrackedSince = new Date(Date.now() - ACCESSSTRADE_TRACKING_WAIT_MS);
    const [transactions, payouts, untrackedLinks, untrackedLinkCount] =
      await Promise.all([
        this.usersService.getTransactionHistory(user.id, 10),
        this.usersService.getPayoutHistory(user.id, 5),
        this.usersService.getUntrackedLinkHistory(user.id, 1, untrackedSince),
        this.usersService.countUntrackedLinks(user.id, untrackedSince),
      ]);

    if (
      transactions.length === 0 &&
      payouts.length === 0 &&
      untrackedLinkCount === 0
    ) {
      await ctx.reply(
        '📜 Chưa có giao dịch nào. Paste link sản phẩm vào đây để bắt đầu nhận cashback nhé!',
      );
      return;
    }

    const lines: string[] = ['📜 Lịch sử giao dịch (10 mới nhất)\n'];

    if (transactions.length > 0) {
      lines.push('🛒 Cashback:');
      for (const tx of transactions) {
        const merchant = tx.link?.merchant ? labelMerchant(tx.link.merchant) : '?';
        const date = formatDate(tx.createdAt);
        const status = labelStatus(tx.status);
        lines.push(
          `${status} ${date} | ${merchant} | ${formatVnd(tx.userShare)} | ${tx.orderId}`,
        );
      }
      lines.push('');
    }

    if (untrackedLinkCount > 0) {
      lines.push('🔗 Link chờ Accesstrade ghi nhận:');
      const [link] = untrackedLinks;
      if (link) {
        const date = formatDate(link.createdAt);
        const merchant = labelMerchant(link.merchant);
        lines.push(
          `⏳ Gần nhất: ${date} | ${merchant} | ${labelUntrackedLink(link.createdAt)}`,
        );
      }
      lines.push(
        `Có ${untrackedLinkCount} link tạo trong 72h gần nhất chưa có đơn ghi nhận.`,
      );
      lines.push('Nếu bạn không mua qua các link đó thì có thể bỏ qua mục này.');
      lines.push(
        'Khi Accesstrade gửi đơn về, bot sẽ tự chuyển sang mục Cashback và hiển thị số tiền thật.',
      );
      lines.push('');
    }

    if (payouts.length > 0) {
      lines.push('💸 Rút tiền:');
      for (const p of payouts) {
        const date = formatDate(p.createdAt);
        const status = labelPayoutStatus(p.status);
        lines.push(`${status} ${date} | ${formatVnd(p.amount)}`);
      }
    }

    await ctx.reply(lines.join('\n'));
  }

  @Command('setbank')
  async onSetBank(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    await this.usersService.upsertTelegramUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });

    await ctx.scene.enter(SETBANK_SCENE_ID);
  }

  @Command('withdraw')
  async onWithdraw(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.usersService.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Bạn chưa đăng ký. Gõ /start trước nhé.');
      return;
    }

    if (!user.bankName || !user.bankAccount || !user.bankHolder) {
      await ctx.reply(
        'Bạn chưa cài đặt tài khoản nhận tiền. Gõ /setbank để thiết lập.',
      );
      return;
    }

    try {
      const payout = await this.payoutsService.createWithdrawRequest(user.id);
      await ctx.reply(
        [
          '✅ Đã tạo yêu cầu rút tiền.',
          '',
          `💸 Số tiền: ${formatVnd(payout.amount)}`,
          `🏦 ${user.bankName} - ${user.bankAccount}`,
          `👤 ${user.bankHolder}`,
          '',
          'Admin sẽ xử lý trong vòng 24h. Bạn sẽ nhận thông báo khi chuyển xong.',
        ].join('\n'),
      );
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    if (ctx.scene?.current) return;

    const message = ctx.message as { text?: string } | undefined;
    const text = message?.text;
    if (!text || text.startsWith('/')) return;

    const from = ctx.from;
    if (!from) return;

    if (!this.rateLimit.check(from.id)) {
      await ctx.reply('⏳ Bạn đang thao tác quá nhanh. Đợi vài giây rồi thử lại.');
      return;
    }

    const detected = extractFirstSupportedUrl(text);
    if (!detected) {
      await ctx.reply(
        'Mình không tìm thấy link sản phẩm hợp lệ. ChotDeal đang hỗ trợ: Shopee, Lazada, Tiki, TikTok Shop.\n\nTaobao/1688 sẽ ra mắt sớm 🇨🇳',
      );
      return;
    }

    const user = await this.usersService.upsertTelegramUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });

    try {
      const link = await this.affiliateService.createAffiliateLink({
        userId: user.id,
        originalUrl: detected.url,
      });
      await ctx.reply(
        [
          `🛒 Sàn: ${labelMerchant(detected.merchant)}`,
          '',
          '🔗 Link cashback của bạn:',
          link.affiliateUrl,
          '',
          'Bạn cần mở đúng link vừa tạo ở trên để mua hàng thì bot mới tracking được cashback.',
          '',
          '⏳ Lưu ý: Đơn hàng có thể mất vài phút đến 72h mới được Accesstrade ghi nhận và hiện trong /history.',
          '',
          'Trong thời gian này bot chưa biết chính xác cashback, vì số tiền chỉ được tính khi Accesstrade gửi hoa hồng thực tế về hệ thống.',
          'Nếu sau 72h chưa thấy đơn, hãy gửi admin mã đơn + ảnh đơn hàng để kiểm tra.',
          '',
          '⚠️ Mở link trên rồi mua hàng luôn trong session đó để đảm bảo bot tracking được. Đừng đóng tab giữa chừng.',
        ].join('\n'),
        { link_preview_options: { is_disabled: true } },
      );
    } catch (err) {
      this.logger.error(
        `createAffiliateLink failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply('Có lỗi tạo link. Thử lại sau hoặc inbox admin nhé.');
    }
  }
}

function formatVnd(amount: number): string {
  return `${amount.toLocaleString('vi-VN')}đ`;
}

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function labelUntrackedLink(createdAt: Date): string {
  const ageMs = Date.now() - createdAt.getTime();
  const seventyTwoHoursMs = 72 * 60 * 60 * 1000;
  if (ageMs >= seventyTwoHoursMs) {
    return 'quá 72h chưa ghi nhận - gửi admin mã đơn + ảnh đơn để kiểm tra';
  }
  return 'chờ Accesstrade ghi nhận, tối đa 72h';
}

function labelMerchant(m: string): string {
  switch (m) {
    case 'shopee':
      return 'Shopee';
    case 'lazada':
      return 'Lazada';
    case 'tiki':
      return 'Tiki';
    case 'tiktok_shop':
      return 'TikTok';
    default:
      return m;
  }
}

function labelStatus(s: string): string {
  switch (s) {
    case 'PENDING':
      return '⏳';
    case 'APPROVED':
      return '✅';
    case 'REJECTED':
      return '❌';
    case 'CANCELLED':
      return '🚫';
    default:
      return '•';
  }
}

function labelPayoutStatus(s: string): string {
  switch (s) {
    case 'PENDING':
      return '⏳';
    case 'PROCESSING':
      return '🔄';
    case 'PAID':
      return '✅';
    case 'FAILED':
      return '❌';
    default:
      return '•';
  }
}
