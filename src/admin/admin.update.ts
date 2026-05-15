import { Update, Command, Hears, Ctx } from 'nestjs-telegraf';
import { Context } from 'telegraf';

import { TransactionStatus } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { PayoutsService } from '../payouts/payouts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DealsService } from '../deals/deals.service';
import { extractFirstSupportedUrl, labelMerchant as merchantLabel } from '../affiliate/url-detector';
import {
  AliboOrderListMode,
  AliboOrdersService,
} from '../alibo-orders/alibo-orders.service';

@Update()
export class AdminUpdate {
  private readonly logger = new Logger(AdminUpdate.name);

  constructor(
    private readonly guard: AdminGuard,
    private readonly admin: AdminService,
    private readonly payouts: PayoutsService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly deals: DealsService,
    private readonly aliboOrders: AliboOrdersService,
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
        '/admin_broadcast_test <nội dung> - gửi thử cho admin',
        '/admin_broadcast <nội dung> - gửi thông báo tới toàn bộ user',
        '/admin_deal_test <url> | <tiêu đề> | <mô tả> - gửi thử deal cho admin',
        '/admin_deal <url> | <tiêu đề> | <mô tả> - gửi deal tới subscriber',
        '/admin_deal_send <deal_id> - gửi deal đã tạo từ bản test',
        '/admin_deals - 10 deal gần nhất',
        '/admin_deal_subscribers - số người đang bật nhận deal',
        '/admin_deal_off <deal_id> - tắt deal',
        '/admin_deal_on <deal_id> - bật lại deal',
        '/admin_scan_deals [limit] - quet deal Shopee tu Accesstrade',
        '/admin_deal_candidates [status] - xem deal bot tim duoc',
        '/admin_deal_approve <candidate_id> - duyet va gui deal',
        '/admin_deal_reject <candidate_id> - bo qua deal',
        '',
        'Alibo sync:',
        '/admin_alibo_sync [days] - sync don tu trang Alibo (chi pull du lieu)',
        '/admin_alibo_auto_match [days] [dry|apply] - auto-match HIGH-confidence orders',
        '/admin_alibo_orders [unmatched|matched|all] - xem don Alibo da sync',
        '/admin_alibo_order <id> - chi tiet 1 don Alibo',
        '/admin_alibo_match_order <order_prefix> <subId_prefix> [status] [commission_vnd] - match don sync vao user',
        '',
        '🇨🇳 Reconcile alibo (Taobao/1688):',
        '/admin_alibo_pending - link Taobao chưa có đơn',
        '/admin_alibo_match <subId_prefix> <orderId> <commission_report> [sale] [status] - tạo đơn manual',
      ].join('\n'),
    );
  }

  /**
   * Fallback for Telegram clients that send commands as plain text or include
   * the bot username, e.g. /admin@chotdeal_bot. This also protects admin
   * commands from decorator ordering issues with generic text handlers.
   */
  @Hears(/^\/admin(?:_[a-z0-9]+)?(?:@\w+)?(?:\s|$)/i)
  async onAdminTextFallback(@Ctx() ctx: Context) {
    const command = parseCommandName(ctx);
    switch (command) {
      case 'admin':
        return this.onAdmin(ctx);
      case 'admin_broadcast_test':
        return this.onBroadcastTest(ctx);
      case 'admin_broadcast':
        return this.onBroadcast(ctx);
      case 'admin_deal_test':
        return this.onDealTest(ctx);
      case 'admin_deal':
        return this.onDeal(ctx);
      case 'admin_deal_send':
        return this.onDealSend(ctx);
      case 'admin_deals':
        return this.onDeals(ctx);
      case 'admin_deal_subscribers':
        return this.onDealSubscribers(ctx);
      case 'admin_deal_off':
        return this.onDealOff(ctx);
      case 'admin_deal_on':
        return this.onDealOn(ctx);
      case 'admin_scan_deals':
        return this.onScanDeals(ctx);
      case 'admin_deal_candidates':
        return this.onDealCandidates(ctx);
      case 'admin_deal_approve':
        return this.onDealApprove(ctx);
      case 'admin_deal_reject':
        return this.onDealReject(ctx);
      case 'admin_stats':
        return this.onStats(ctx);
      case 'admin_links':
        return this.onLinks(ctx);
      case 'admin_link':
        return this.onLinkDetail(ctx);
      case 'admin_payouts':
        return this.onPayouts(ctx);
      case 'admin_paid':
        return this.onPaid(ctx);
      case 'admin_cancel':
        return this.onCancel(ctx);
      case 'admin_user':
        return this.onUser(ctx);
      case 'admin_block':
        return this.onBlock(ctx);
      case 'admin_unblock':
        return this.onUnblock(ctx);
      case 'admin_recent':
        return this.onRecent(ctx);
      case 'admin_alibo_sync':
        return this.onAliboSync(ctx);
      case 'admin_alibo_auto_match':
        return this.onAliboAutoMatch(ctx);
      case 'admin_alibo_orders':
        return this.onAliboOrders(ctx);
      case 'admin_alibo_order':
        return this.onAliboOrderDetail(ctx);
      case 'admin_alibo_match_order':
        return this.onAliboMatchOrder(ctx);
      case 'admin_alibo_pending':
        return this.onAliboPending(ctx);
      case 'admin_alibo_match':
        return this.onAliboMatch(ctx);
      default:
        if (!this.assertAdmin(ctx)) return;
        await ctx.reply('Lệnh admin chưa hỗ trợ. Gõ /admin để xem danh sách lệnh.');
    }
  }

  @Command('admin_broadcast_test')
  async onBroadcastTest(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const text = parseRestArg(ctx);
    if (!text) {
      await ctx.reply('Cú pháp: /admin_broadcast_test <nội dung thông báo>');
      return;
    }

    const ok = await this.notifications.sendAdminTest(ctx.from!.id, text);
    await ctx.reply(
      ok
        ? '✅ Đã gửi thử thông báo cho bạn. Nếu nội dung ổn, dùng /admin_broadcast <nội dung>.'
        : '❌ Gửi thử thất bại. Kiểm tra log bot.',
    );
  }

  @Command('admin_broadcast')
  async onBroadcast(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const text = parseRestArg(ctx);
    if (!text) {
      await ctx.reply(
        [
          'Cú pháp: /admin_broadcast <nội dung thông báo>',
          '',
          'Nên gửi thử trước:',
          '/admin_broadcast_test <nội dung thông báo>',
        ].join('\n'),
      );
      return;
    }

    await ctx.reply('⏳ Đang gửi broadcast. Bot sẽ báo kết quả khi xong...');
    const result = await this.notifications.broadcastToActiveUsers(text);
    await ctx.reply(
      [
        '✅ Broadcast hoàn tất',
        '',
        `Tổng user: ${result.total}`,
        `Đã gửi: ${result.sent}`,
        `User block/deactivated: ${result.blocked}`,
        `Lỗi khác: ${result.failed}`,
      ].join('\n'),
    );
  }

  @Command('admin_deal_test')
  async onDealTest(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const payload = parseDealPayload(ctx);
    if (!payload) {
      await ctx.reply(dealSyntax('/admin_deal_test'));
      return;
    }

    const deal = await this.deals.createDeal({
      ...payload,
      createdByTelegramId: ctx.from!.id,
    });
    const text = buildDealBroadcastMessage(deal);
    const ok = await this.notifications.sendDealTest(ctx.from!.id, deal.id, text);

    await ctx.reply(
      ok
        ? [
            '✅ Đã gửi thử deal cho bạn.',
            '',
            `Deal ID: ${deal.id}`,
            `Gửi thật: /admin_deal_send ${deal.id.slice(0, 10)}`,
          ].join('\n')
        : '❌ Gửi thử deal thất bại. Kiểm tra log bot.',
    );
  }

  @Command('admin_deal')
  async onDeal(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const payload = parseDealPayload(ctx);
    if (!payload) {
      await ctx.reply(dealSyntax('/admin_deal'));
      return;
    }

    const deal = await this.deals.createDeal({
      ...payload,
      createdByTelegramId: ctx.from!.id,
    });
    await this.broadcastDeal(ctx, deal);
  }

  @Command('admin_deal_send')
  async onDealSend(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_deal_send <deal_id hoặc prefix>');
      return;
    }

    const deal = await this.deals.findByIdOrPrefix(id);
    if (!deal) {
      await ctx.reply(`Không tìm thấy deal với id/prefix ${id}`);
      return;
    }
    if (!deal.isActive) {
      await ctx.reply('Deal này đang tắt. Dùng /admin_deal_on <deal_id> nếu muốn bật lại.');
      return;
    }

    await this.broadcastDeal(ctx, deal);
  }

  @Command('admin_deals')
  async onDeals(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const deals = await this.deals.listRecentDeals(10);
    if (deals.length === 0) {
      await ctx.reply('Chưa có deal nào.');
      return;
    }

    await ctx.reply(
      [
        '🔥 10 deal gần nhất',
        '',
        ...deals.map(
          (deal) =>
            `${deal.isActive ? '✅' : '🚫'} ${deal.id.slice(0, 10)} | ${merchantLabel(
              deal.merchant,
            )} | ${truncate(deal.title, 70)}`,
        ),
        '',
        'Gửi lại: /admin_deal_send <deal_id>',
        'Tắt deal: /admin_deal_off <deal_id>',
      ].join('\n'),
    );
  }

  @Command('admin_deal_subscribers')
  async onDealSubscribers(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const stats = await this.deals.getDealSubscriberStats();
    await ctx.reply(
      [
        '👥 Deal subscribers',
        '',
        `Đang bật: ${stats.enabled}`,
        `Đã tắt: ${stats.disabled}`,
        '',
        'Deal broadcast chỉ gửi tới user đang bật /deals_on.',
      ].join('\n'),
    );
  }

  @Command('admin_deal_off')
  async onDealOff(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    await this.setDealActive(ctx, false);
  }

  @Command('admin_deal_on')
  async onDealOn(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    await this.setDealActive(ctx, true);
  }

  @Command('admin_scan_deals')
  async onScanDeals(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const limitArg = parseArg(ctx);
    const limit = limitArg ? parseInt(limitArg, 10) : 30;

    await ctx.reply('⏳ Đang quét deal Shopee từ Accesstrade...');
    try {
      const result = await this.deals.scanShopeeDealCandidates({ limit });
      const top = result.candidates
        .filter((candidate) => candidate.status === 'NEW')
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      await ctx.reply(
        [
          '✅ Quét deal hoàn tất',
          '',
          `Fetched: ${result.fetched}`,
          `Mới: ${result.created}`,
          `Cập nhật: ${result.updated}`,
          `Bỏ qua: ${result.skipped}`,
          '',
          top.length > 0 ? 'Top candidate:' : 'Chưa có candidate mới phù hợp.',
          ...top.map(
            (candidate) =>
              `• ${candidate.id.slice(0, 10)} | score ${candidate.score} | ${truncate(candidate.title, 80)}`,
          ),
          '',
          'Xem danh sách: /admin_deal_candidates',
          'Duyệt gửi: /admin_deal_approve <candidate_id>',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      await ctx.reply(`❌ Quét deal thất bại: ${(err as Error).message}`);
    }
  }

  @Command('admin_deal_candidates')
  async onDealCandidates(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const status = (parseArg(ctx) ?? 'NEW').toUpperCase();
    const candidates = await this.deals.listDealCandidates({ status, limit: 10 });
    if (candidates.length === 0) {
      await ctx.reply(`Không có deal candidate status=${status}.`);
      return;
    }

    await ctx.reply(
      [
        `🔥 Deal candidates (${status})`,
        '',
        ...candidates.map(formatCandidateLine),
        '',
        'Duyệt gửi: /admin_deal_approve <candidate_id>',
        'Bỏ qua: /admin_deal_reject <candidate_id>',
      ].join('\n'),
    );
  }

  @Command('admin_deal_approve')
  async onDealApprove(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_deal_approve <candidate_id hoặc prefix>');
      return;
    }

    try {
      const result = await this.deals.approveCandidate(id, ctx.from!.id);
      await ctx.reply(
        [
          result.alreadyApproved
            ? 'ℹ️ Candidate đã được duyệt trước đó, sẽ gửi lại deal hiện có.'
            : '✅ Đã duyệt candidate, chuẩn bị gửi deal.',
          `Candidate: ${result.candidate.id.slice(0, 10)}`,
          `Deal ID: ${result.deal.id}`,
        ].join('\n'),
      );
      await this.broadcastDeal(ctx, result.deal);
    } catch (err) {
      await ctx.reply(`❌ Duyệt deal thất bại: ${(err as Error).message}`);
    }
  }

  @Command('admin_deal_reject')
  async onDealReject(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_deal_reject <candidate_id hoặc prefix>');
      return;
    }

    try {
      const candidate = await this.deals.rejectCandidate(id, ctx.from!.id);
      await ctx.reply(
        `🚫 Đã reject candidate ${candidate.id.slice(0, 10)} | ${truncate(candidate.title, 90)}`,
      );
    } catch (err) {
      await ctx.reply(`❌ Reject deal thất bại: ${(err as Error).message}`);
    }
  }

  @Command('admin_stats')
  async onStats(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const s = await this.admin.getStats();
    const channelLines =
      s.channelStats.length > 0
        ? s.channelStats.map(
            (row) =>
              `- ${channelLabel(row.channel)}: ${row.linkCount} links | ${row.txApproved} approved / ${row.txPending} pending | ${vnd(row.approvedCashback)}`,
          )
        : ['- chưa có link'];
    await ctx.reply(
      [
        '📊 Bot stats',
        '',
        `👥 Users: ${s.userCount}`,
        `🔗 Links: ${s.linkCount}`,
        `📦 Transactions: ${s.txApproved} approved / ${s.txPending} pending`,
        `💸 Payouts pending: ${s.payoutPending}`,
        '',
        `Cashback user nhận: ${vnd(s.paidToUsers)}`,
        '',
        'Theo kênh:',
        ...channelLines,
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
        `• ${formatDateTime(link.createdAt)} | ${channelLabel(link.channel)} | ${link.merchant} | ${link.subId}`,
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
              userShare: number;
              createdAt: Date;
            }) =>
              `${statusIcon(tx.status)} ${tx.orderId} | cashback ${vnd(tx.userShare)} | ${formatDateTime(tx.createdAt)}`,
          )
        : ['chưa có đơn/postback'];

    await ctx.reply(
      [
        '🔎 Link detail',
        '',
        `sub_id: ${link.subId}`,
        `channel: ${channelLabel(link.channel)}`,
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
        `• ${channelLabel(t.link?.channel)} | ${t.link?.merchant ?? '-'} | ${t.orderId} | ${t.status} | cashback ${vnd(t.userShare)} | ${formatUser(t.user)}`,
    );
    await ctx.reply(['📦 Recent transactions:', '', ...lines].join('\n'));
  }


  @Command('admin_alibo_sync')
  async onAliboSync(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const daysArg = parseArg(ctx);
    const days = daysArg ? parseInt(daysArg, 10) : 7;
    if (Number.isNaN(days) || days < 1 || days > 365) {
      await ctx.reply('Cú pháp: /admin_alibo_sync [days], ví dụ /admin_alibo_sync 7');
      return;
    }

    await ctx.reply(`⏳ Đang sync đơn Alibo ${days} ngày gần nhất...`);
    try {
      const result = await this.aliboOrders.syncRecentOrders({ days });
      const top = result.orders
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 5);
      await ctx.reply(
        [
          '✅ Sync Alibo hoàn tất',
          '',
          `Records total: ${result.recordsTotal}`,
          `Fetched: ${result.fetched}`,
          `Mới: ${result.created}`,
          `Cập nhật: ${result.updated}`,
          `Bỏ qua: ${result.skipped}`,
          '',
          '💡 Sync chỉ pull dữ liệu, không cộng tiền. Chạy:',
          '   /admin_alibo_auto_match 7 dry   — preview các đơn match được',
          '   /admin_alibo_auto_match 7 apply — apply HIGH-confidence',
          '',
          top.length > 0 ? 'Đơn mới/cập nhật gần nhất:' : 'Chưa có đơn trong khoảng này.',
          ...top.map(formatAliboOrderLine),
          '',
          'Xem đơn chưa match: /admin_alibo_orders unmatched',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      await ctx.reply(`❌ Sync Alibo thất bại: ${(err as Error).message}`);
    }
  }

  @Command('admin_alibo_auto_match')
  async onAliboAutoMatch(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const raw = parseRestArg(ctx) ?? '';
    const tokens = raw.split(/\s+/).filter(Boolean);
    let days = 7;
    let mode: 'dry' | 'apply' = 'dry';
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (lower === 'dry') mode = 'dry';
      else if (lower === 'apply' || lower === '--apply') mode = 'apply';
      else if (lower === '--dry') mode = 'dry';
      else if (/^\d+$/.test(lower)) days = parseInt(lower, 10);
    }
    if (Number.isNaN(days) || days < 1 || days > 365) {
      await ctx.reply('Cú pháp: /admin_alibo_auto_match [days] [dry|apply]');
      return;
    }

    await ctx.reply(`⏳ Đang ${mode === 'apply' ? 'auto-match + apply' : 'preview match'} ${days} ngày...`);
    try {
      const result = await this.aliboOrders.autoMatchOrders({ days, apply: mode === 'apply' });
      const lines = [
        `🎯 Alibo auto-match ${mode === 'apply' ? '(APPLY)' : '(DRY)'} ${days}d`,
        '',
        `Scanned orders: ${result.scanned}`,
        `  HIGH (auto-applicable): ${result.high.length}`,
        `  MEDIUM (review):        ${result.medium.length}`,
        `  LOW (cannot match):     ${result.low.length}`,
      ];
      if (mode === 'apply') {
        lines.push(
          '',
          'Apply results:',
          `  Created:        ${result.applied.matched}`,
          `  Status updated: ${result.applied.statusUpdated}`,
          `  Skipped:        ${result.applied.skipped}`,
          `  Errors:         ${result.applied.errors}`,
          `  Notify queued:   ${result.applied.notifications.length}`,
        );
        for (const item of result.applied.notifications) {
          this.notifyTransaction(item.transactionId, item.status);
        }
      }
      const sample = (label: string, list: typeof result.high) => {
        if (list.length === 0) return null;
        return [
          '',
          `${label}:`,
          ...list.slice(0, 5).map((c) => {
            const sub = c.link?.subId ?? '-';
            return `  • order=${c.order.orderId.slice(0, 12)} item=${c.itemId ?? '-'} → subId=${sub} (${c.reason})`;
          }),
          list.length > 5 ? `  ... +${list.length - 5} more` : '',
        ].filter(Boolean) as string[];
      };
      const high = sample('HIGH', result.high);
      const medium = sample('MEDIUM', result.medium);
      const low = sample('LOW (top reasons)', result.low);
      if (high) lines.push(...high);
      if (medium) lines.push(...medium);
      if (low) lines.push(...low);
      lines.push(
        '',
        mode === 'apply'
          ? 'Tip: dùng /admin_alibo_orders unmatched để xem MEDIUM/LOW chưa match.'
          : 'Tip: gõ /admin_alibo_auto_match ' + days + ' apply để apply HIGH-confidence.',
      );
      await ctx.reply(lines.join('\n'));
    } catch (err) {
      await ctx.reply(`❌ Auto-match Alibo thất bại: ${(err as Error).message}`);
    }
  }

  @Command('admin_alibo_orders')
  async onAliboOrders(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const rawMode = (parseArg(ctx) ?? 'unmatched').toLowerCase();
    const mode: AliboOrderListMode =
      rawMode === 'matched' || rawMode === 'all' ? rawMode : 'unmatched';
    const orders = await this.aliboOrders.listOrders({ mode, limit: 10 });
    if (orders.length === 0) {
      await ctx.reply(`Không có đơn Alibo mode=${mode}.`);
      return;
    }

    await ctx.reply(
      [
        `🇨🇳 Alibo orders (${mode})`,
        '',
        ...orders.map(formatAliboOrderLine),
        '',
        'Chi tiết: /admin_alibo_order <id_or_prefix>',
        'Match: /admin_alibo_match_order <order_prefix> <subId_prefix> [status] [commission_vnd]',
      ].join('\n'),
    );
  }

  @Command('admin_alibo_order')
  async onAliboOrderDetail(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply('Cú pháp: /admin_alibo_order <id_or_prefix>');
      return;
    }

    const order = await this.aliboOrders.findByIdOrPrefix(id);
    if (!order) {
      await ctx.reply(`Không tìm thấy đơn Alibo với prefix=${id}`);
      return;
    }

    await ctx.reply(
      [
        '🔎 Alibo order detail',
        '',
        `id: ${order.id}`,
        `lineKey: ${order.lineKey}`,
        `orderId: ${order.orderId}`,
        `status: ${statusIcon(order.status)} ${order.status} (${order.statusRaw})`,
        `match: ${order.matchStatus}`,
        `platform: ${order.platform ?? '-'}`,
        `paidAt: ${order.paidAt ? formatDateTime(order.paidAt) : '-'}`,
        '',
        `Hoa hồng: ${cny(order.commissionCny)} ≈ ${vnd(order.commissionVnd)}`,
        `Giá trị đơn: ${cny(order.saleAmountCny)} ≈ ${vnd(order.saleAmountVnd)}`,
        `Số lượng: ${order.quantity}`,
        '',
        `Sản phẩm: ${truncate(order.itemTitle ?? '-', 300)}`,
        order.itemLink ? `Link: ${order.itemLink}` : '',
        '',
        order.matchStatus === 'MATCHED'
          ? `Đã match: ${order.matchedSubId ?? '-'} | tx:${order.transactionId ?? '-'}`
          : 'Match bằng: /admin_alibo_match_order <order_prefix> <subId_prefix> [status] [commission_vnd]',
      ]
        .filter(Boolean)
        .join('\n'),
      { link_preview_options: { is_disabled: true } },
    );
  }

  @Command('admin_alibo_match_order')
  async onAliboMatchOrder(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const msg = ctx.message as { text?: string } | undefined;
    if (!msg?.text) return;
    const parts = msg.text.split(/\s+/).slice(1);
    if (parts.length < 2) {
      await ctx.reply(
        'Cú pháp: /admin_alibo_match_order <order_prefix> <subId_prefix> [pending|approved|rejected] [commission_vnd]',
      );
      return;
    }

    const [orderPrefix, subPrefix, statusRaw, commissionRaw] = parts;
    const order = await this.aliboOrders.findByIdOrPrefix(orderPrefix);
    if (!order) {
      await ctx.reply(`Không tìm thấy đơn Alibo với prefix=${orderPrefix}`);
      return;
    }

    const subId = await this.resolveAliboSubId(subPrefix);
    if (!subId) {
      await ctx.reply(`Không tìm thấy link alibo nào với subId prefix=${subPrefix}.`);
      return;
    }

    const parsedStatus = parseTxStatus(statusRaw);
    const status = parsedStatus ?? order.status;
    const commissionToken = parsedStatus ? commissionRaw : statusRaw;
    let commissionOverride: number | undefined;
    if (commissionToken) {
      const parsedCommission = parseInt(commissionToken, 10);
      if (!Number.isFinite(parsedCommission) || parsedCommission <= 0) {
        await ctx.reply('commission_vnd phải là số nguyên dương.');
        return;
      }
      commissionOverride = parsedCommission;
    }

    const userRate = parseInt(this.config.get<string>('ALIBO_DEFAULT_USER_RATE', '60'), 10);
    try {
      const result = await this.admin.matchSyncedAliboOrder({
        aliboOrderId: order.id,
        subId,
        status,
        userRate,
        commissionVndOverride: commissionOverride,
        note: `alibo order sync via admin ${ctx.from?.id ?? ''}`,
      });
      const tx = result.transaction;
      if (result.action !== 'skipped') {
        this.notifyTransaction(tx.id, tx.status);
      }

      await ctx.reply(
        [
          result.action === 'created'
            ? '✅ Đã match đơn Alibo và tạo transaction:'
            : result.action === 'updated'
              ? '✅ Đã cập nhật trạng thái transaction Alibo:'
              : '⊘ Transaction Alibo đã tồn tại, không đổi trạng thái:',
          `• orderId: ${tx.orderId}`,
          `• lineKey: ${result.order.lineKey}`,
          `• subId: ${tx.subId}`,
          `• cashback user nhận: ${vnd(tx.userShare)}`,
          `• status: ${tx.status}`,
          '',
          tx.status === TransactionStatus.APPROVED
            ? 'User đã được cộng vào số dư available + nhận notify.'
            : tx.status === TransactionStatus.PENDING
              ? 'User đã được cộng vào pending balance + nhận notify.'
              : 'Transaction đã chuyển sang trạng thái không được duyệt.',
        ].join('\n'),
      );
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  }

  @Command('admin_alibo_pending')
  async onAliboPending(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const list = await this.admin.listAliboPendingLinks(30);
    if (list.length === 0) {
      await ctx.reply('Không có link Taobao/1688 nào đang chờ reconcile.');
      return;
    }
    const lines = list.map((l) => {
      const subPrefix = l.subId.slice(0, 12);
      const date = new Date(l.createdAt).toLocaleDateString('vi-VN');
      return `• ${subPrefix}.. | ${channelLabel(l.channel)} | ${l.merchant} | ${date} | ${formatUser(l.user)}`;
    });
    await ctx.reply(
      [
        '🇨🇳 Alibo pending links (chưa có transaction):',
        '',
        ...lines,
        '',
        'Match thủ công bằng:',
        '/admin_alibo_match <subId_prefix> <orderId> <commission_VND> [sale_VND] [pending|approved]',
      ].join('\n'),
    );
  }

  @Command('admin_alibo_match')
  async onAliboMatch(@Ctx() ctx: Context) {
    if (!this.assertAdmin(ctx)) return;
    const msg = ctx.message as { text?: string } | undefined;
    if (!msg?.text) return;
    const parts = msg.text.split(/\s+/).slice(1);

    if (parts.length < 3) {
      await ctx.reply(
        'Cú pháp: /admin_alibo_match <subId_prefix> <orderId> <commission> [sale] [status]\n\nVí dụ: /admin_alibo_match tgabc12 ALIBO123 50000 500000 pending',
      );
      return;
    }

    const [subPrefix, orderId, commissionRaw, saleRaw, statusRaw] = parts;
    if (!subPrefix || !orderId || !commissionRaw) {
      await ctx.reply('Thiếu tham số. Dùng /admin_alibo_match để xem cú pháp.');
      return;
    }
    const commission = parseInt(commissionRaw, 10);
    const sale = parseInt(saleRaw ?? '0', 10);
    const statusStr = (statusRaw ?? 'pending').toLowerCase();
    const status =
      statusStr === 'approved'
        ? TransactionStatus.APPROVED
        : statusStr === 'rejected'
          ? TransactionStatus.REJECTED
          : TransactionStatus.PENDING;

    if (Number.isNaN(commission) || commission <= 0) {
      await ctx.reply('Commission phải là số nguyên dương (VND).');
      return;
    }

    // Resolve subId từ prefix
    const subId = await this.resolveAliboSubId(subPrefix);
    if (!subId) {
      await ctx.reply(`Không tìm thấy link alibo nào với subId prefix=${subPrefix}.`);
      return;
    }

    const userRate = parseInt(this.config.get<string>('ALIBO_DEFAULT_USER_RATE', '60'), 10);
    try {
      const result = await this.admin.createManualAliboTransaction({
        subId,
        orderId,
        grossCommission: commission,
        saleAmount: sale,
        status,
        userRate,
        note: `manual via admin ${ctx.from?.id ?? ''}`,
      });
      const tx = result.transaction;
      if (result.action !== 'skipped') {
        this.notifyTransaction(tx.id, tx.status);
      }
      await ctx.reply(
        [
          result.action === 'created'
            ? '✅ Đã tạo transaction alibo manual:'
            : result.action === 'updated'
              ? '✅ Đã cập nhật trạng thái transaction alibo:'
              : '⊘ Transaction alibo đã tồn tại, không đổi trạng thái:',
          `• subId: ${subId}`,
          `• orderId: ${tx.orderId}`,
          `• cashback user nhận: ${vnd(tx.userShare)}`,
          `• status: ${tx.status}`,
          '',
          tx.status === TransactionStatus.APPROVED
            ? 'User đã được cộng vào số dư available + nhận notify.'
            : tx.status === TransactionStatus.PENDING
              ? 'User đã được cộng vào pending balance + nhận notify.'
              : 'Transaction đã chuyển sang trạng thái không được duyệt.',
        ].join('\n'),
      );
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  }

  private async broadcastDeal(
    ctx: Context,
    deal: {
      id: string;
      title: string;
      description: string | null;
      merchant: string;
      originalUrl: string;
    },
  ): Promise<void> {
    const text = buildDealBroadcastMessage(deal);
    await ctx.reply(
      [
        '⏳ Đang gửi deal tới subscriber đã bật /deals_on...',
        `Deal: ${deal.title}`,
        'Bot sẽ báo kết quả khi xong.',
      ].join('\n'),
    );

    const result = await this.notifications.broadcastDealToActiveUsers(
      deal.id,
      text,
    );

    await ctx.reply(
      [
        '✅ Gửi deal hoàn tất',
        '',
        `Deal ID: ${deal.id}`,
        `Subscriber phù hợp: ${result.total}`,
        `Đã gửi: ${result.sent}`,
        `User block/deactivated: ${result.blocked}`,
        `Lỗi khác: ${result.failed}`,
        '',
        'Khi user bấm nút "Lấy link cashback", bot mới tạo link riêng cho user đó.',
      ].join('\n'),
    );
  }

  private async setDealActive(ctx: Context, isActive: boolean): Promise<void> {
    const id = parseArg(ctx);
    if (!id) {
      await ctx.reply(`Cú pháp: /admin_deal_${isActive ? 'on' : 'off'} <deal_id hoặc prefix>`);
      return;
    }

    const deal = await this.deals.findByIdOrPrefix(id);
    if (!deal) {
      await ctx.reply(`Không tìm thấy deal với id/prefix ${id}`);
      return;
    }

    const updated = await this.deals.setActive(deal.id, isActive);
    await ctx.reply(
      `${isActive ? '✅ Đã bật' : '🚫 Đã tắt'} deal ${updated.id.slice(0, 10)} | ${updated.title}`,
    );
  }

  private async resolveAliboSubId(prefix: string): Promise<string | null> {
    const link = await this.admin.findAliboLinkBySubIdPrefix(prefix);
    return link?.subId ?? null;
  }

  private notifyTransaction(transactionId: string, status: TransactionStatus): void {
    if (status === TransactionStatus.PENDING) {
      this.notifications.notifyTransactionPending(transactionId).catch(() => {});
    } else if (status === TransactionStatus.APPROVED) {
      this.notifications.notifyTransactionApproved(transactionId).catch(() => {});
    } else if (
      status === TransactionStatus.REJECTED ||
      status === TransactionStatus.CANCELLED
    ) {
      this.notifications.notifyTransactionRejected(transactionId).catch(() => {});
    }
  }

  private assertAdmin(ctx: Context): boolean {
    const id = ctx.from?.id;
    if (!id || !this.guard.isAdmin(id)) {
      this.logger.warn(`Blocked admin command from telegramId=${id ?? 'unknown'}`);
      void ctx
        .reply(
          [
            'Bạn chưa có quyền dùng lệnh admin trên Telegram.',
            'Nếu đây là tài khoản admin, hãy kiểm tra biến TELEGRAM_ADMIN_IDS có đúng Telegram user ID của bạn không.',
          ].join('\n'),
        )
        .catch(() => undefined);
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

function parseCommandName(ctx: Context): string | null {
  const msg = ctx.message as { text?: string } | undefined;
  const match = msg?.text?.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseRestArg(ctx: Context): string | null {
  const msg = ctx.message as { text?: string } | undefined;
  if (!msg?.text) return null;
  const text = msg.text.replace(/^\/\S+\s*/, '').trim();
  return text.length > 0 ? text : null;
}

interface DealPayload {
  title: string;
  description: string | null;
  merchant: string;
  originalUrl: string;
}

function parseDealPayload(ctx: Context): DealPayload | null {
  const text = parseRestArg(ctx);
  if (!text) return null;

  const detected = extractFirstSupportedUrl(text);
  if (!detected) return null;

  const withoutUrl = text.replace(detected.url, '').trim();
  const parts = withoutUrl
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  const title = truncate(
    parts[0] || `Deal ${merchantLabel(detected.merchant)} mới từ ChotDeal`,
    120,
  );
  const description = parts.length > 1 ? truncate(parts.slice(1).join('\n'), 700) : null;

  return {
    title,
    description,
    merchant: detected.merchant,
    originalUrl: detected.url,
  };
}

function dealSyntax(command: string): string {
  return [
    `Cú pháp: ${command} <link sản phẩm> | <tiêu đề deal> | <mô tả ngắn>`,
    '',
    'Ví dụ:',
    `${command} https://shopee.vn/... | Áo chống nắng đang sale | Nhớ bấm nút lấy link cashback trước khi mua.`,
    '',
    'Nên dùng /admin_deal_test trước, sau đó /admin_deal_send <deal_id> để gửi thật.',
  ].join('\n');
}

function buildDealBroadcastMessage(deal: {
  title: string;
  description: string | null;
  merchant: string;
}): string {
  return [
    '🔥 Deal mới từ ChotDeal',
    '',
    `🛍 ${deal.title}`,
    `Sàn: ${merchantLabel(deal.merchant)}`,
    deal.description ? `\n${deal.description}` : '',
    '',
    'Bấm nút “Lấy link cashback” bên dưới để bot tạo link riêng cho bạn.',
    'Chỉ mua qua link bot gửi sau khi bấm nút để hệ thống tracking cashback đúng.',
    '',
    '⏳ Đơn có thể mất vài phút đến 72h mới hiện trong /history.',
  ]
    .filter(Boolean)
    .join('\n');
}

function vnd(n: number): string {
  return `${n.toLocaleString('vi-VN')}đ`;
}

function cny(value: { toString(): string } | number | string | null): string {
  if (value === null || value === undefined) return '-';
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(value.toString());
  if (!Number.isFinite(numeric)) return `${value.toString()} CNY`;
  return `${numeric.toLocaleString('vi-VN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} CNY`;
}

function formatAliboOrderLine(order: {
  id: string;
  orderId: string;
  lineKey: string;
  status: string;
  statusRaw: string;
  matchStatus: string;
  platform: string | null;
  itemTitle: string | null;
  commissionCny: { toString(): string } | null;
  commissionVnd: number;
  paidAt: Date | null;
}): string {
  const paidAt = order.paidAt ? formatDate(order.paidAt) : '-';
  return [
    `• ${order.id.slice(0, 10)} | ${statusIcon(order.status)} ${order.status} | ${order.matchStatus}`,
    `  ${paidAt} | ${order.platform ?? '-'} | ${order.orderId}`,
    `  ${cny(order.commissionCny)} ≈ ${vnd(order.commissionVnd)} | ${truncate(order.itemTitle ?? '-', 90)}`,
  ].join('\n');
}

function parseTxStatus(raw: string | undefined): TransactionStatus | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === 'pending') return TransactionStatus.PENDING;
  if (normalized === 'approved') return TransactionStatus.APPROVED;
  if (normalized === 'rejected') return TransactionStatus.REJECTED;
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return TransactionStatus.CANCELLED;
  }
  return null;
}

function formatCandidateLine(candidate: {
  id: string;
  title: string;
  score: number;
  merchant: string;
  endAt: Date | null;
}): string {
  const end = candidate.endAt ? ` | het han ${formatDate(candidate.endAt)}` : '';
  return `• ${candidate.id.slice(0, 10)} | ${merchantLabel(candidate.merchant)} | score ${candidate.score}${end}\n  ${truncate(candidate.title, 95)}`;
}

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

function formatDateTime(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yy} ${hh}:${mi}`;
}

function statusIcon(s: string): string {
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

function channelLabel(channel: string | null | undefined): string {
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'zalo') return 'Zalo';
  return channel ? channel : 'Unknown';
}

function formatUser(u: {
  telegramId: bigint | null;
  zaloUserId?: string | null;
  username: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const name = [u.firstName ?? '', u.lastName ?? ''].filter(Boolean).join(' ').trim();
  const handle = u.username ? `@${u.username}` : '';
  const tg = u.telegramId ? `tg:${u.telegramId}` : 'tg:-';
  const zalo = u.zaloUserId ? `zalo:${truncate(u.zaloUserId, 12)}` : '';
  return [name, handle, tg, zalo].filter(Boolean).join(' ');
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
