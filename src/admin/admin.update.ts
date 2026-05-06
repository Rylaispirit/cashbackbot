import { Update, Command, Ctx } from 'nestjs-telegraf';
import { Context } from 'telegraf';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { PayoutsService } from '../payouts/payouts.service';

@Update()
export class AdminUpdate {
  constructor(
    private readonly guard: AdminGuard,
    private readonly admin: AdminService,
    private readonly payouts: PayoutsService,
  ) {}

  @Command('admin')
  async onAdmin(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    await ctx.reply(
      [
        '🛠 Admin commands:',
        '/admin_stats - tổng quan',
        '/admin_links - 10 link mới nhất',
        '/admin_link <sub_id> - chi tiết 1 link',
        '/admin_recent - 10 đơn gần nhất',
        '/admin_payouts - list payout pending',
        '/admin_paid <id> - mark payout đã chuyển',
        '/admin_cancel <id> - huỷ payout',
        '/admin_user <telegram_id>',
        '/admin_block <telegram_id>',
        '/admin_unblock <telegram_id>',
      ].join('\n'),
    );
  }

  @Command('admin_stats')
  async onStats(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const s = await this.admin.getStats();
    await ctx.reply(
      [
        '📊 Bot stats',
        '',
        `👥 Users: ${s.userCount}`,
        `🔗 Links: ${s.linkCount}`,
        `📦 Transactions: ${s.txApproved} approved / ${s.txPending} pending`,
        `💸 Payouts pending: ${s.payoutPending}`,
        '',
        `Gross commission: ${vnd(s.grossCommission)}`,
        `Đã chia user: ${vnd(s.paidToUsers)}`,
        `Phần bot giữ: ${vnd(s.ownerRevenue)}`,
      ].join('\n'),
    );
  }

  @Command('admin_links')
  async onLinks(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const list = await this.admin.listRecentLinks(10);
    if (list.length === 0) {
      await ctx.reply('Chưa có link nào.');
      return;
    }

    const lines = list.flatMap((link) => {
      const tx = link.transactions[0];
      const txText = tx
        ? `${statusIcon(tx.status)} ${tx.orderId} | ${vnd(tx.userShare)}`
        : 'chưa có đơn';
      return [
        `• ${formatDateTime(link.createdAt)} | ${link.merchant} | ${link.subId}`,
        `  ${formatUser(link.user)} | tx:${link._count.transactions} | ${txText}`,
      ];
    });

    await ctx.reply(
      [
        '🔗 10 link mới nhất',
        '',
        ...lines,
        '',
        'Xem chi tiết: /admin_link <sub_id>',
      ].join('\n'),
    );
  }

  @Command('admin_link')
  async onLinkDetail(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const subId = parseArg(ctx);
    if (!subId || subId.length < 6) {
      await ctx.reply('Cú pháp: /admin_link <sub_id hoặc prefix>');
      return;
    }

    const link = await this.admin.getLinkDetail(subId);
    if (!link) {
      await ctx.reply(`Không tìm thấy link với sub_id/prefix ${subId}`);
      return;
    }

    const txLines =
      link.transactions.length > 0
        ? link.transactions.map(
            (tx: {
              status: string;
              orderId: string;
              grossCommission: number;
              userShare: number;
              createdAt: Date;
            }) =>
              `${statusIcon(tx.status)} ${tx.orderId} | gross ${vnd(tx.grossCommission)} | user ${vnd(tx.userShare)} | ${formatDateTime(tx.createdAt)}`,
          )
        : ['chưa có đơn/postback'];

    await ctx.reply(
      [
        '🔎 Link detail',
        '',
        `sub_id: ${link.subId}`,
        `merchant: ${link.merchant}`,
        `user: ${formatUser(link.user)}`,
        `created: ${formatDateTime(link.createdAt)}`,
        '',
        'Affiliate link:',
        link.affiliateUrl,
        '',
        'Original link:',
        truncate(link.originalUrl, 700),
        '',
        'Transactions:',
        ...txLines,
      ].join('\n'),
      { link_preview_options: { is_disabled: true } },
    );
  }

  @Command('admin_payouts')
  async onPayouts(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const list = await this.payouts.listPending(20);
    if (list.length === 0) {
      await ctx.reply('Không có payout pending.');
      return;
    }
    const lines = list.map(
      (p) =>
        `• ${p.id.slice(0, 8)} | ${vnd(p.amount)} | ${p.bankName} ${p.bankAccount} (${p.bankHolder}) | tg:${p.telegramId}`,
    );
    await ctx.reply(['💸 Payouts pending:', '', ...lines].join('\n'));
  }

  @Command('admin_paid')
  async onPaid(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_paid <payout_id>');
      return;
    }
    try {
      const fullId = await this.resolvePayoutId(id);
      const payout = await this.payouts.markPaid(fullId);
      await ctx.reply(
        `✅ Đã mark paid payout ${payout.id.slice(0, 8)} (${vnd(payout.amount)})`,
      );
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  }

  @Command('admin_cancel')
  async onCancel(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_cancel <payout_id>');
      return;
    }
    try {
      const fullId = await this.resolvePayoutId(id);
      const payout = await this.payouts.cancel(fullId, 'Cancelled by admin');
      await ctx.reply(
        `✅ Đã huỷ payout ${payout.id.slice(0, 8)}, hoàn ${vnd(payout.amount)} về user.`,
      );
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  }

  @Command('admin_user')
  async onUser(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const arg = parseArg(ctx);
    if (!arg || !/^\d+$/.test(arg)) {
      await ctx.reply('Cú pháp: /admin_user <telegram_id>');
      return;
    }
    const user = await this.admin.getUserDetail(BigInt(arg));
    if (!user) {
      await ctx.reply('Không tìm thấy user.');
      return;
    }
    await ctx.reply(
      [
        `👤 ${user.firstName ?? ''} ${user.lastName ?? ''} (@${user.username ?? '-'})`,
        `tg:${user.telegramId}`,
        `Bank: ${user.bankName ?? '-'} ${user.bankAccount ?? '-'} (${user.bankHolder ?? '-'})`,
        '',
        `✅ Available: ${vnd(user.balanceAvail)}`,
        `⏳ Pending: ${vnd(user.balancePending)}`,
        `📤 Paid out: ${vnd(user.totalPaidOut)}`,
        '',
        `Links: ${user._count.links} | Tx: ${user._count.transactions} | Payouts: ${user._count.payouts}`,
        user.isBlocked ? '🚫 BLOCKED' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  @Command('admin_block')
  async onBlock(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const arg = parseArg(ctx);
    if (!arg || !/^\d+$/.test(arg)) {
      await ctx.reply('Cú pháp: /admin_block <telegram_id>');
      return;
    }
    await this.admin.blockUser(BigInt(arg), true);
    await ctx.reply(`🚫 Đã block tg:${arg}`);
  }

  @Command('admin_unblock')
  async onUnblock(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const arg = parseArg(ctx);
    if (!arg || !/^\d+$/.test(arg)) {
      await ctx.reply('Cú pháp: /admin_unblock <telegram_id>');
      return;
    }
    await this.admin.blockUser(BigInt(arg), false);
    await ctx.reply(`✅ Đã unblock tg:${arg}`);
  }

  @Command('admin_recent')
  async onRecent(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const list = await this.admin.listRecentTransactions(10);
    if (list.length === 0) {
      await ctx.reply('Chưa có transaction nào.');
      return;
    }
    const lines = list.map(
      (t) =>
        `• ${t.orderId} | ${t.status} | ${vnd(t.grossCommission)} | tg:${t.user.telegramId} (@${t.user.username ?? '-'})`,
    );
    await ctx.reply(['📦 Recent transactions:', '', ...lines].join('\n'));
  }

  private assertAdmin(ctx: Context): boolean {
    const id = ctx.from?.id;
    if (!id || !this.guard.isAdmin(id)) {
      return false;
    }
    return true;
  }

  private async resolvePayoutId(idOrPrefix: string): Promise<string> {
    if (idOrPrefix.length >= 20) return idOrPrefix;
    const all = await this.payouts.listPending(100);
    const match = all.find((p) => p.id.startsWith(idOrPrefix));
    if (!match) throw new Error(`Không tìm thấy payout với prefix ${idOrPrefix}`);
    return match.id;
  }
}

function parseArg(ctx: Context): string | null {
  const msg = ctx.message as { text?: string } | undefined;
  if (!msg?.text) return null;
  const parts = msg.text.split(/\s+/);
  return parts[1] ?? null;
}

function vnd(n: number): string {
  return `${n.toLocaleString('vi-VN')}đ`;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatUser(user: {
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const username = user.username ? `@${user.username}` : name || '-';
  return `tg:${user.telegramId} ${username}`;
}

function statusIcon(status: string): string {
  switch (status) {
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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
