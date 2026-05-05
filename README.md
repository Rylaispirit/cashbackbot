# Cashback Bot (Telegram + Accesstrade)

Bot Telegram nhận link sản phẩm, tạo link cashback qua Accesstrade, ghi nhận postback đơn hàng, và quản lý số dư/rút tiền cho user.

## Stack

- NestJS 10
- Telegraf (`nestjs-telegraf`)
- Prisma + Supabase Postgres
- TypeScript 5
- Local: polling
- Production: webhook qua Railway

## Current capabilities

- Hỗ trợ Shopee, Lazada, Tiki, TikTok Shop
- `/start`, `/help`, `/balance`, `/history`, `/setbank`, `/withdraw`
- Admin commands: `/admin_stats`, `/admin_recent`, `/admin_payouts`, `/admin_paid`, `/admin_cancel`, `/admin_user`, `/admin_block`, `/admin_unblock`
- Tự notify khi đơn approved/rejected/cancelled
- Tự notify khi payout paid/cancelled
- Simulate postback local hoặc public endpoint

## Environment

Sao chép `.env.example` thành `.env`, rồi điền tối thiểu:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_IDS`
- `DATABASE_URL`
- `DIRECT_URL`
- `ACCESSTRADE_PUB_ID`
- `ACCESSTRADE_POSTBACK_SECRET`

Biến production mới:

- `TELEGRAM_UPDATES_MODE=polling|webhook`
- `PUBLIC_BASE_URL=https://cashbackbot-production.up.railway.app`
- `TELEGRAM_WEBHOOK_PATH=/telegram/webhook/chotdeal-prod-20260505`
- `TELEGRAM_WEBHOOK_SECRET_TOKEN=<random-secret>`

Ghi chú:

- Local/dev mặc định dùng `polling`
- `NODE_ENV=production` sẽ mặc định dùng `webhook` nếu bạn không set `TELEGRAM_UPDATES_MODE`
- Nếu chưa có `ACCESSTRADE_CAMPAIGN_ID_*`, bot vẫn hoạt động nhờ fallback về deeplink template

## Local development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run start:dev
```

Bot sẽ chạy qua polling. Test nhanh:

1. Nhắn `/start`
2. Paste 1 link Shopee/Lazada/Tiki/TikTok Shop
3. Gõ `/balance`
4. Gõ `/history`

Test postback local:

```bash
npm run simulate:postback -- \
  --sub=tg<sub_id> \
  --order=ORDER001 \
  --commission=20000 \
  --status=pending
```

## Production on Railway

Repo đã có sẵn:

- `railway.json`
- `npm run start:railway`

### Suggested Railway flow

1. Tạo service trên Railway
2. Set các env production:
   - `NODE_ENV=production`
   - `TELEGRAM_UPDATES_MODE=webhook`
   - `PUBLIC_BASE_URL=https://cashbackbot-production.up.railway.app`
   - `TELEGRAM_WEBHOOK_PATH=/telegram/webhook/chotdeal-prod-20260505`
   - `TELEGRAM_WEBHOOK_SECRET_TOKEN=<random-secret>`
   - các biến DB / Telegram / Accesstrade còn lại
3. Deploy
4. Kiểm tra:
   - `GET /`
   - `GET /api/health`
   - log startup có in mode webhook, webhook URL, postback URL
5. Cấu hình Accesstrade postback:

```text
https://cashbackbot-production.up.railway.app/api/postback/accesstrade
```

6. Test public simulator:

```bash
npm run simulate:postback -- \
  --endpoint=https://cashbackbot-production.up.railway.app/api/postback/accesstrade \
  --sub=tg<sub_id> \
  --order=ORDER001 \
  --commission=20000 \
  --status=approved
```

## Launch gate

Trước khi public rộng, cần xác nhận ít nhất 1 đơn thật từ Accesstrade:

- postback trả `200`
- `sub_id` map đúng user
- balance pending/approved cập nhật đúng
- notification Telegram hiển thị đúng

Sau đó mới mở truyền thông/public rộng.

## Useful scripts

```bash
npm run typecheck
npm run build
npm run smoke
npm run test:at
npm run simulate:postback
npm run start:railway
```
