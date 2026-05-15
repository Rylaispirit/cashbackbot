import { timingSafeEqual } from 'crypto';

import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionStatus } from '@prisma/client';
import { Request, Response } from 'express';

import { AdminService } from './admin.service';

const COOKIE_NAME = 'chotdeal_admin';
const ADMIN_BASE = '/api/admin/web';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['all', 'telegram', 'zalo']);

@Controller('admin/web')
export class AdminWebController {
  constructor(
    private readonly admin: AdminService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async dashboard(@Req() req: Request, @Res() res: Response) {
    if (!this.authorize(req, res)) return;

    const [stats, recentZaloLinks, recentTransactions, unmatchedAlibo] =
      await Promise.all([
        this.admin.getStats(),
        this.admin.listRecentLinks(8, { channel: 'zalo' }),
        this.admin.listRecentTransactions(8),
        this.admin.listAliboOrdersForAdmin('UNMATCHED', 8),
      ]);

    const channelRows = stats.channelStats
      .map(
        (row) => html`
          <tr>
            <td>${badge(channelLabel(row.channel), `channel ${row.channel}`)}</td>
            <td>${row.linkCount}</td>
            <td>${row.txApproved}</td>
            <td>${row.txPending}</td>
            <td>${vnd(row.approvedCashback)}</td>
          </tr>
        `,
      )
      .join('');

    const body = html`
      <section class="hero">
        <div>
          <p class="eyebrow">ChotDeal Control Room</p>
          <h1>Quản lý đơn và link theo kênh</h1>
          <p class="muted">
            Bảng này chỉ đọc dữ liệu để giảm rủi ro thao tác nhầm. Các lệnh cộng tiền,
            match Alibo và broadcast vẫn dùng Telegram admin command.
          </p>
        </div>
        <form class="search" method="get" action="${ADMIN_BASE}/link-search">
          <input name="q" placeholder="Nhập subId hoặc prefix..." />
          <button type="submit">Tìm link</button>
        </form>
      </section>

      <section class="cards">
        ${metricCard('Users', stats.userCount)}
        ${metricCard('Links', stats.linkCount)}
        ${metricCard('Đơn pending', stats.txPending)}
        ${metricCard('Đơn approved', stats.txApproved)}
        ${metricCard('Payout đang chờ', stats.payoutPending)}
        ${metricCard('Cashback đã duyệt', vnd(stats.paidToUsers))}
      </section>

      <section class="grid two">
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Channel</p>
              <h2>Hiệu suất theo kênh</h2>
            </div>
            <a class="ghost" href="${ADMIN_BASE}/transactions?channel=zalo">Xem đơn Zalo</a>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kênh</th>
                  <th>Links</th>
                  <th>Approved</th>
                  <th>Pending</th>
                  <th>Cashback</th>
                </tr>
              </thead>
              <tbody>${channelRows || emptyRow(5, 'Chưa có dữ liệu')}</tbody>
            </table>
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Alibo</p>
              <h2>Đơn Taobao chưa match</h2>
            </div>
            <a class="ghost" href="${ADMIN_BASE}/alibo-orders">Xem tất cả</a>
          </div>
          ${compactAliboList(unmatchedAlibo)}
        </article>
      </section>

      <section class="grid two">
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Zalo</p>
              <h2>Link Zalo mới tạo</h2>
            </div>
            <a class="ghost" href="${ADMIN_BASE}/links?channel=zalo">Mở danh sách</a>
          </div>
          ${compactLinkList(recentZaloLinks)}
        </article>

        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Orders</p>
              <h2>Đơn mới nhất</h2>
            </div>
            <a class="ghost" href="${ADMIN_BASE}/transactions">Mở danh sách</a>
          </div>
          ${compactTransactionList(recentTransactions)}
        </article>
      </section>
    `;

    this.sendPage(res, req, 'Dashboard', body);
  }

  @Get('links')
  async links(@Req() req: Request, @Res() res: Response) {
    if (!this.authorize(req, res)) return;

    const channel = normaliseChannel(queryString(req, 'channel', 'all'));
    const merchant = queryString(req, 'merchant', 'all').toLowerCase();
    const limit = queryInt(req, 'limit', 30);
    const links = await this.admin.listRecentLinks(limit, {
      channel,
      merchant: merchant || 'all',
    });

    const rows = links
      .map((link) => {
        const lastTx = link.transactions[0];
        const openUrl = openPath(link.network, link.subId);
        return html`
          <tr>
            <td>
              <a class="strong" href="${ADMIN_BASE}/link/${encodeURIComponent(link.subId)}">
                ${escapeHtml(link.subId)}
              </a>
              <div class="muted tiny">${formatDate(link.createdAt)}</div>
            </td>
            <td>${badge(channelLabel(link.channel), `channel ${link.channel}`)}</td>
            <td>
              <span class="strong">${escapeHtml(link.merchant)}</span>
              <div class="muted tiny">${escapeHtml(link.network)}</div>
            </td>
            <td>${formatUser(link.user)}</td>
            <td>
              ${link._count.transactions}
              <div class="muted tiny">
                ${lastTx
                  ? `${escapeHtml(lastTx.status)} · ${vnd(lastTx.userShare)}`
                  : 'chưa có đơn'}
              </div>
            </td>
            <td class="actions">
              <a href="${openUrl}" target="_blank" rel="noreferrer">Mở link</a>
              <a href="${ADMIN_BASE}/link/${encodeURIComponent(link.subId)}">Chi tiết</a>
            </td>
          </tr>
        `;
      })
      .join('');

    const body = html`
      ${pageTitle('Link cashback', 'Theo dõi link tạo từ Telegram/Zalo và số đơn phát sinh.')}
      ${filters(
        [
          ['all', 'Tất cả', `${ADMIN_BASE}/links?channel=all`],
          ['zalo', 'Zalo', `${ADMIN_BASE}/links?channel=zalo`],
          ['telegram', 'Telegram', `${ADMIN_BASE}/links?channel=telegram`],
        ],
        channel,
      )}
      <article class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SubId</th>
                <th>Kênh</th>
                <th>Sàn</th>
                <th>User</th>
                <th>Đơn</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows || emptyRow(6, 'Chưa có link phù hợp')}</tbody>
          </table>
        </div>
      </article>
    `;

    this.sendPage(res, req, 'Links', body);
  }

  @Get('transactions')
  async transactions(@Req() req: Request, @Res() res: Response) {
    if (!this.authorize(req, res)) return;

    const channel = normaliseChannel(queryString(req, 'channel', 'all'));
    const status = parseStatus(queryString(req, 'status', 'all'));
    const limit = queryInt(req, 'limit', 40);
    const transactions = await this.admin.listRecentTransactions(limit, {
      channel,
      status,
    });

    const rows = transactions
      .map(
        (tx: Record<string, any>) => html`
          <tr>
            <td>
              <span class="strong">${escapeHtml(tx.orderId)}</span>
              <div class="muted tiny">${formatDate(tx.createdAt)}</div>
            </td>
            <td>${badge(tx.status, `status ${tx.status.toLowerCase()}`)}</td>
            <td>${badge(channelLabel(tx.link?.channel), `channel ${tx.link?.channel ?? 'unknown'}`)}</td>
            <td>
              ${escapeHtml(tx.link?.merchant ?? '-')}
              <div class="muted tiny">${escapeHtml(tx.subId)}</div>
            </td>
            <td>${formatUser(tx.user)}</td>
            <td class="money">${vnd(tx.saleAmount)}</td>
            <td class="money">${vnd(tx.userShare)}</td>
            <td>
              ${tx.link?.subId
                ? `<a href="${ADMIN_BASE}/link/${encodeURIComponent(tx.link.subId)}">Link</a>`
                : '-'}
            </td>
          </tr>
        `,
      )
      .join('');

    const statusQuery = status ? `&status=${status}` : '';
    const body = html`
      ${pageTitle('Đơn / Transaction', 'Lọc nhanh đơn theo kênh để support user Zalo hoặc Telegram.')}
      ${filters(
        [
          ['all', 'Tất cả', `${ADMIN_BASE}/transactions?channel=all${statusQuery}`],
          ['zalo', 'Zalo', `${ADMIN_BASE}/transactions?channel=zalo${statusQuery}`],
          ['telegram', 'Telegram', `${ADMIN_BASE}/transactions?channel=telegram${statusQuery}`],
        ],
        channel,
      )}
      <article class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Kênh</th>
                <th>Sàn/SubId</th>
                <th>User</th>
                <th>Giá trị</th>
                <th>Cashback user</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows || emptyRow(8, 'Chưa có đơn phù hợp')}</tbody>
          </table>
        </div>
      </article>
    `;

    this.sendPage(res, req, 'Transactions', body);
  }

  @Get('alibo-orders')
  async aliboOrders(@Req() req: Request, @Res() res: Response) {
    if (!this.authorize(req, res)) return;

    const matchStatus = normaliseMatchStatus(queryString(req, 'match', 'UNMATCHED'));
    const limit = queryInt(req, 'limit', 40);
    const orders = await this.admin.listAliboOrdersForAdmin(matchStatus, limit);
    const rows = orders
      .map((order) => {
        const matchedLink = order.matchedLink as Record<string, any> | null | undefined;
        return html`
          <tr>
            <td>
              <span class="strong">${escapeHtml(order.orderId)}</span>
              <div class="muted tiny">${escapeHtml(short(order.lineKey, 24))}</div>
            </td>
            <td>${badge(order.matchStatus, `status ${String(order.matchStatus).toLowerCase()}`)}</td>
            <td>${badge(String(order.status), `status ${String(order.status).toLowerCase()}`)}</td>
            <td>
              ${escapeHtml(short(order.itemTitle ?? '-', 64))}
              <div class="muted tiny">${formatDate(order.paidAt ?? order.createdAt)}</div>
            </td>
            <td class="money">${vnd(order.saleAmountVnd)}</td>
            <td class="money">${vnd(order.commissionVnd)}</td>
            <td>
              ${order.matchedSubId
                ? `<a href="${ADMIN_BASE}/link/${encodeURIComponent(order.matchedSubId)}">${escapeHtml(order.matchedSubId)}</a>`
                : '<span class="muted">chưa match</span>'}
              <div class="muted tiny">${matchedLink?.user ? formatUser(matchedLink.user) : ''}</div>
            </td>
          </tr>
        `;
      })
      .join('');

    const body = html`
      ${pageTitle(
        'Đơn Alibo / Taobao',
        'Đơn sync từ Alibo chỉ hiển thị để đối soát. Match/cộng tiền vẫn nên làm qua Telegram admin command.',
      )}
      ${filters(
        [
          ['UNMATCHED', 'Chưa match', `${ADMIN_BASE}/alibo-orders?match=UNMATCHED`],
          ['MATCHED', 'Đã match', `${ADMIN_BASE}/alibo-orders?match=MATCHED`],
          ['ALL', 'Tất cả', `${ADMIN_BASE}/alibo-orders?match=ALL`],
        ],
        matchStatus,
      )}
      <article class="panel note">
        <p>Lệnh match nhanh: <code>/admin_alibo_match_order &lt;order_prefix&gt; &lt;subId_prefix&gt; pending</code></p>
      </article>
      <article class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Match</th>
                <th>Status</th>
                <th>Sản phẩm</th>
                <th>Sale</th>
                <th>Hoa hồng</th>
                <th>SubId</th>
              </tr>
            </thead>
            <tbody>${rows || emptyRow(7, 'Chưa có đơn Alibo phù hợp')}</tbody>
          </table>
        </div>
      </article>
    `;

    this.sendPage(res, req, 'Alibo orders', body);
  }

  @Get('link-search')
  linkSearch(@Req() req: Request, @Res() res: Response) {
    if (!this.authorize(req, res)) return;
    const q = queryString(req, 'q', '').trim();
    if (!q) {
      res.redirect(ADMIN_BASE);
      return;
    }
    res.redirect(`${ADMIN_BASE}/link/${encodeURIComponent(q)}`);
  }

  @Get('link/:subId')
  async linkDetail(
    @Param('subId') subId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.authorize(req, res)) return;

    const link = await this.admin.getLinkDetail(subId);
    if (!link) {
      this.sendPage(
        res,
        req,
        'Không tìm thấy link',
        html`
          ${pageTitle('Không tìm thấy link', `Không có link nào khớp "${subId}".`)}
          <a class="button" href="${ADMIN_BASE}/links">Quay lại danh sách</a>
        `,
        404,
      );
      return;
    }

    const txRows = link.transactions
      .map(
        (tx: Record<string, any>) => html`
          <tr>
            <td>${escapeHtml(tx.orderId)}</td>
            <td>${badge(tx.status, `status ${tx.status.toLowerCase()}`)}</td>
            <td class="money">${vnd(tx.saleAmount)}</td>
            <td class="money">${vnd(tx.grossCommission)}</td>
            <td class="money">${vnd(tx.userShare)}</td>
            <td>${formatDate(tx.createdAt)}</td>
          </tr>
        `,
      )
      .join('');

    const body = html`
      ${pageTitle('Chi tiết link', link.subId)}
      <section class="grid two">
        <article class="panel details">
          <h2>Thông tin link</h2>
          ${detail('SubId', link.subId)}
          ${detail('Kênh', channelLabel(link.channel))}
          ${detail('Network', link.network)}
          ${detail('Merchant', link.merchant)}
          ${detail('User', formatUser(link.user), true)}
          ${detail('Ngày tạo', formatDate(link.createdAt))}
          ${detail('Click gần nhất', link.clickedAt ? formatDate(link.clickedAt) : 'chưa có')}
          <div class="actions wide">
            <a href="${openPath(link.network, link.subId)}" target="_blank" rel="noreferrer">Mở link rút gọn</a>
            <a href="${ADMIN_BASE}/transactions?channel=${encodeURIComponent(link.channel)}">Đơn cùng kênh</a>
          </div>
        </article>
        <article class="panel details">
          <h2>URL</h2>
          ${detail('Original', link.originalUrl)}
          ${detail('Affiliate', link.affiliateUrl)}
        </article>
      </section>

      <article class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Transactions</p>
            <h2>10 đơn gần nhất của link</h2>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Sale</th>
                <th>Gross</th>
                <th>User share</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>${txRows || emptyRow(6, 'Link này chưa có đơn')}</tbody>
          </table>
        </div>
      </article>
    `;

    this.sendPage(res, req, 'Link detail', body);
  }

  @Get('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    res.clearCookie(COOKIE_NAME, { path: ADMIN_BASE });
    this.sendPage(
      res,
      req,
      'Đã đăng xuất',
      html`
        ${pageTitle('Đã đăng xuất', 'Cookie admin web đã được xoá trên trình duyệt này.')}
        <a class="button" href="${ADMIN_BASE}">Đăng nhập lại</a>
      `,
    );
  }

  private authorize(req: Request, res: Response): boolean {
    const expected = this.config.get<string>('ADMIN_WEB_TOKEN')?.trim();
    if (!expected) {
      this.sendPage(
        res,
        req,
        'Admin web chưa bật',
        html`
          ${pageTitle(
            'Admin web chưa bật',
            'Thiếu ADMIN_WEB_TOKEN. Hãy set env này trên Railway/local trước khi mở giao diện quản lý.',
          )}
        `,
        503,
      );
      return false;
    }

    const token = this.readToken(req);
    if (token && secureEquals(token, expected)) {
      if (queryString(req, 'token', '')) {
        this.setCookie(req, res, token);
        res.redirect(stripToken(req));
        return false;
      }
      return true;
    }

    this.renderLogin(req, res, token ? 'Token không đúng, thử lại nhé.' : undefined);
    return false;
  }

  private readToken(req: Request): string | null {
    const queryToken = queryString(req, 'token', '').trim();
    if (queryToken) return queryToken;

    const headerToken = req.header('x-admin-web-token')?.trim();
    if (headerToken) return headerToken;

    return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
  }

  private setCookie(req: Request, res: Response, token: string): void {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps(req),
      maxAge: COOKIE_MAX_AGE_MS,
      path: ADMIN_BASE,
    });
  }

  private renderLogin(req: Request, res: Response, error?: string): void {
    const body = html`
      <section class="login-card">
        <p class="eyebrow">ChotDeal Admin</p>
        <h1>Đăng nhập web quản lý</h1>
        <p class="muted">Nhập <code>ADMIN_WEB_TOKEN</code> để xem link, đơn và thống kê theo kênh.</p>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
        <form method="get" action="${escapeAttr(req.path || ADMIN_BASE)}">
          <label for="token">Admin token</label>
          <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
          <button type="submit">Vào dashboard</button>
        </form>
      </section>
    `;
    this.sendPage(res, req, 'Đăng nhập', body, 401, false);
  }

  private sendPage(
    res: Response,
    req: Request,
    title: string,
    body: string,
    status = 200,
    showNav = true,
  ): void {
    res
      .status(status)
      .type('text/html; charset=utf-8')
      .send(layout(title, body, req, showNav));
  }
}

function layout(title: string, body: string, req: Request, showNav: boolean): string {
  return html`<!doctype html>
    <html lang="vi">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)} · ChotDeal Admin</title>
        <style>
          :root {
            --ink: #18231f;
            --muted: #6f7d76;
            --paper: #fffdf7;
            --panel: rgba(255, 255, 255, 0.78);
            --line: rgba(24, 35, 31, 0.12);
            --green: #1c6f55;
            --green-soft: #d8efe5;
            --gold: #c17b22;
            --red: #b54635;
            --shadow: 0 24px 80px rgba(24, 35, 31, 0.12);
          }

          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            color: var(--ink);
            font-family: "Trebuchet MS", "Gill Sans", sans-serif;
            background:
              radial-gradient(circle at 8% 12%, rgba(193, 123, 34, 0.16), transparent 28rem),
              radial-gradient(circle at 92% 8%, rgba(28, 111, 85, 0.18), transparent 26rem),
              linear-gradient(135deg, #f8f1df 0%, #eef5ea 42%, #fdfaf1 100%);
          }

          body::before {
            content: "";
            position: fixed;
            inset: 0;
            pointer-events: none;
            opacity: 0.38;
            background-image:
              linear-gradient(rgba(24,35,31,0.04) 1px, transparent 1px),
              linear-gradient(90deg, rgba(24,35,31,0.04) 1px, transparent 1px);
            background-size: 34px 34px;
          }

          a { color: var(--green); text-decoration: none; }
          a:hover { text-decoration: underline; }
          code {
            padding: 0.18rem 0.35rem;
            border-radius: 0.45rem;
            background: rgba(24, 35, 31, 0.07);
          }

          .shell {
            position: relative;
            width: min(1180px, calc(100% - 24px));
            margin: 0 auto;
            padding: 22px 0 60px;
          }

          .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 22px;
            padding: 14px 16px;
            border: 1px solid var(--line);
            border-radius: 24px;
            background: rgba(255,255,255,0.62);
            box-shadow: var(--shadow);
            backdrop-filter: blur(14px);
          }

          .brand {
            display: flex;
            align-items: center;
            gap: 10px;
            font-weight: 800;
            letter-spacing: -0.03em;
          }

          .brand-mark {
            display: inline-grid;
            place-items: center;
            width: 34px;
            height: 34px;
            border-radius: 14px;
            color: #fff;
            background: linear-gradient(135deg, var(--green), #2d9173);
            box-shadow: 0 10px 26px rgba(28, 111, 85, 0.26);
          }

          .nav {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
          }

          .nav a, .ghost, .button, button {
            border: 1px solid var(--line);
            border-radius: 999px;
            padding: 0.64rem 0.9rem;
            color: var(--ink);
            background: rgba(255,255,255,0.62);
            font-weight: 700;
          }

          .nav a.active, button, .button {
            color: #fff;
            border-color: transparent;
            background: var(--green);
          }

          .hero {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(260px, 380px);
            gap: 18px;
            align-items: end;
            margin-bottom: 18px;
          }

          h1, h2 {
            margin: 0;
            font-family: Georgia, "Times New Roman", serif;
            letter-spacing: -0.04em;
          }
          h1 { font-size: clamp(2rem, 5vw, 4.8rem); line-height: 0.96; }
          h2 { font-size: clamp(1.35rem, 3vw, 2.05rem); }
          p { line-height: 1.55; }

          .eyebrow {
            margin: 0 0 8px;
            color: var(--gold);
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.14em;
            font-size: 0.74rem;
          }

          .muted { color: var(--muted); }
          .tiny { font-size: 0.78rem; }
          .strong { font-weight: 900; }
          .money { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }

          .search, .login-card form {
            display: grid;
            gap: 10px;
            padding: 14px;
            border-radius: 24px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.68);
          }

          input {
            width: 100%;
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 0.86rem 1rem;
            color: var(--ink);
            background: #fffdf7;
            font: inherit;
          }

          button { cursor: pointer; font: inherit; }

          .cards {
            display: grid;
            grid-template-columns: repeat(6, minmax(0, 1fr));
            gap: 12px;
            margin: 18px 0;
          }

          .metric, .panel, .login-card {
            border: 1px solid var(--line);
            border-radius: 28px;
            background: var(--panel);
            box-shadow: var(--shadow);
            backdrop-filter: blur(16px);
          }

          .metric { padding: 18px; }
          .metric .value {
            margin-top: 8px;
            font-size: clamp(1.45rem, 3vw, 2.25rem);
            font-weight: 900;
            letter-spacing: -0.04em;
          }

          .grid {
            display: grid;
            gap: 16px;
            margin-top: 16px;
          }
          .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }

          .panel { padding: 18px; overflow: hidden; }
          .panel-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 14px;
          }

          .table-wrap { overflow-x: auto; }
          table {
            width: 100%;
            border-collapse: collapse;
            min-width: 760px;
          }
          th, td {
            padding: 0.84rem 0.72rem;
            border-bottom: 1px solid var(--line);
            text-align: left;
            vertical-align: top;
          }
          th {
            color: var(--muted);
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }

          .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 0.34rem 0.62rem;
            border-radius: 999px;
            font-size: 0.8rem;
            font-weight: 900;
            background: rgba(24, 35, 31, 0.08);
          }
          .channel.zalo, .status.approved, .status.matched { color: var(--green); background: var(--green-soft); }
          .channel.telegram { color: #285d9d; background: #dfeafa; }
          .status.pending, .status.unmatched { color: var(--gold); background: #fff0cd; }
          .status.rejected, .status.cancelled { color: var(--red); background: #f9ded8; }

          .list { display: grid; gap: 10px; }
          .list-item {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 10px;
            padding: 12px;
            border: 1px solid var(--line);
            border-radius: 18px;
            background: rgba(255,255,255,0.54);
          }

          .filters {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin: 14px 0;
          }
          .filters a {
            padding: 0.58rem 0.84rem;
            border: 1px solid var(--line);
            border-radius: 999px;
            background: rgba(255,255,255,0.62);
            font-weight: 800;
          }
          .filters a.active {
            color: #fff;
            background: var(--ink);
            border-color: var(--ink);
          }

          .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }
          .actions.wide { margin-top: 14px; }
          .actions a {
            padding: 0.44rem 0.68rem;
            border-radius: 999px;
            background: rgba(28, 111, 85, 0.1);
            font-weight: 800;
          }

          .details h2 { margin-bottom: 14px; }
          .detail {
            display: grid;
            gap: 4px;
            padding: 10px 0;
            border-bottom: 1px solid var(--line);
            overflow-wrap: anywhere;
          }
          .detail span:first-child {
            color: var(--muted);
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }

          .note { background: rgba(255, 246, 222, 0.78); }
          .login-card {
            width: min(460px, calc(100% - 24px));
            margin: 12vh auto 0;
            padding: 26px;
          }
          .error {
            color: var(--red);
            font-weight: 800;
          }

          @media (max-width: 920px) {
            .hero, .grid.two { grid-template-columns: 1fr; }
            .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .topbar { align-items: flex-start; flex-direction: column; }
          }

          @media (max-width: 560px) {
            .cards { grid-template-columns: 1fr; }
            .panel, .metric { border-radius: 22px; }
            .list-item { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        ${showNav ? nav(req.path) : ''}
        <main class="shell">${body}</main>
      </body>
    </html>`;
}

function nav(path: string): string {
  return html`
    <div class="shell" style="padding-bottom:0">
      <header class="topbar">
        <a class="brand" href="${ADMIN_BASE}">
          <span class="brand-mark">C</span>
          <span>ChotDeal Admin</span>
        </a>
        <nav class="nav">
          ${navItem('Dashboard', ADMIN_BASE, path === ADMIN_BASE)}
          ${navItem('Links', `${ADMIN_BASE}/links`, path.startsWith(`${ADMIN_BASE}/links`))}
          ${navItem('Đơn', `${ADMIN_BASE}/transactions`, path.startsWith(`${ADMIN_BASE}/transactions`))}
          ${navItem('Alibo', `${ADMIN_BASE}/alibo-orders`, path.startsWith(`${ADMIN_BASE}/alibo-orders`))}
          ${navItem('Logout', `${ADMIN_BASE}/logout`, false)}
        </nav>
      </header>
    </div>
  `;
}

function navItem(label: string, href: string, active: boolean): string {
  return `<a class="${active ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`;
}

function pageTitle(title: string, subtitle: string): string {
  return html`
    <section class="hero">
      <div>
        <p class="eyebrow">Admin</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">${escapeHtml(subtitle)}</p>
      </div>
      <form class="search" method="get" action="${ADMIN_BASE}/link-search">
        <input name="q" placeholder="Tìm subId..." />
        <button type="submit">Tìm link</button>
      </form>
    </section>
  `;
}

function metricCard(label: string, value: string | number): string {
  return html`
    <article class="metric">
      <div class="muted tiny">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(String(value))}</div>
    </article>
  `;
}

function compactLinkList(links: Array<Record<string, any>>): string {
  if (links.length === 0) return `<p class="muted">Chưa có link Zalo.</p>`;
  return html`
    <div class="list">
      ${links
        .map(
          (link) => html`
            <div class="list-item">
              <div>
                <a class="strong" href="${ADMIN_BASE}/link/${encodeURIComponent(link.subId)}">
                  ${escapeHtml(link.subId)}
                </a>
                <div class="muted tiny">${escapeHtml(link.merchant)} · ${formatUser(link.user)}</div>
              </div>
              ${badge(`${link._count.transactions} đơn`, 'status pending')}
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function compactTransactionList(transactions: Array<Record<string, any>>): string {
  if (transactions.length === 0) return `<p class="muted">Chưa có đơn.</p>`;
  return html`
    <div class="list">
      ${transactions
        .map(
          (tx) => html`
            <div class="list-item">
              <div>
                <span class="strong">${escapeHtml(tx.orderId)}</span>
                <div class="muted tiny">
                  ${channelLabel(tx.link?.channel)} · ${escapeHtml(tx.link?.merchant ?? '-')} · ${formatUser(tx.user)}
                </div>
              </div>
              ${badge(vnd(tx.userShare), `status ${String(tx.status).toLowerCase()}`)}
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function compactAliboList(orders: Array<Record<string, any>>): string {
  if (orders.length === 0) return `<p class="muted">Không có đơn Alibo chưa match.</p>`;
  return html`
    <div class="list">
      ${orders
        .map(
          (order) => html`
            <div class="list-item">
              <div>
                <span class="strong">${escapeHtml(order.orderId)}</span>
                <div class="muted tiny">${escapeHtml(short(order.itemTitle ?? '-', 54))}</div>
              </div>
              ${badge(vnd(order.commissionVnd), 'status pending')}
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function filters(items: Array<[string, string, string]>, active: string): string {
  return html`
    <div class="filters">
      ${items
        .map(
          ([key, label, href]) =>
            `<a class="${key === active ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`,
        )
        .join('')}
    </div>
  `;
}

function detail(label: string, value: string, alreadyHtml = false): string {
  return html`
    <div class="detail">
      <span>${escapeHtml(label)}</span>
      <strong>${alreadyHtml ? value : escapeHtml(value)}</strong>
    </div>
  `;
}

function badge(label: string, className: string): string {
  return `<span class="badge ${escapeAttr(className)}">${escapeHtml(label)}</span>`;
}

function emptyRow(colspan: number, message: string): string {
  return `<tr><td colspan="${colspan}" class="muted">${escapeHtml(message)}</td></tr>`;
}

function formatUser(user: Record<string, any> | null | undefined): string {
  if (!user) return '<span class="muted">unknown</span>';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
  const label = name ? `${name} · ` : '';
  if (user.zaloUserId) {
    return `${escapeHtml(label)}<span class="strong">Zalo ${escapeHtml(short(String(user.zaloUserId), 18))}</span>`;
  }
  if (user.telegramId) {
    return `${escapeHtml(label)}<span class="strong">TG ${escapeHtml(String(user.telegramId))}</span>`;
  }
  return `${escapeHtml(label)}<span class="muted">no channel id</span>`;
}

function channelLabel(channel?: string | null): string {
  if (channel === 'zalo') return 'Zalo';
  if (channel === 'telegram') return 'Telegram';
  return 'Unknown';
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function vnd(value: number | bigint | null | undefined): string {
  const numeric = typeof value === 'bigint' ? Number(value) : value ?? 0;
  return `${new Intl.NumberFormat('vi-VN').format(numeric)}đ`;
}

function openPath(network: string, subId: string): string {
  const kind = network === 'alibo' ? 'taobao' : 'link';
  return `/api/open/${kind}/${encodeURIComponent(subId)}`;
}

function queryString(req: Request, key: string, fallback = ''): string {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return fallback;
}

function queryInt(req: Request, key: string, fallback: number): number {
  const raw = Number.parseInt(queryString(req, key, String(fallback)), 10);
  if (Number.isNaN(raw)) return fallback;
  return Math.min(Math.max(raw, 1), 100);
}

function normaliseChannel(value: string): string {
  const channel = value.toLowerCase();
  return CHANNELS.has(channel) ? channel : 'all';
}

function parseStatus(value: string): TransactionStatus | undefined {
  const upper = value.toUpperCase();
  return Object.values(TransactionStatus).includes(upper as TransactionStatus)
    ? (upper as TransactionStatus)
    : undefined;
}

function normaliseMatchStatus(value: string): 'UNMATCHED' | 'MATCHED' | 'ALL' {
  const upper = value.toUpperCase();
  if (upper === 'MATCHED' || upper === 'ALL') return upper;
  return 'UNMATCHED';
}

function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return raw.split(';').reduce<Record<string, string>>((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function secureEquals(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stripToken(req: Request): string {
  const url = new URL(req.originalUrl, 'http://local');
  url.searchParams.delete('token');
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

function isHttps(req: Request): boolean {
  return req.secure || req.header('x-forwarded-proto') === 'https';
}

function short(value: string, max = 36): string {
  if (value.length <= max) return value;
  if (max <= 8) return value.slice(0, max);
  return `${value.slice(0, Math.ceil(max / 2) - 2)}...${value.slice(-(Math.floor(max / 2) - 1))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function html(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, '');
}
