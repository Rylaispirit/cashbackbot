# ChotDeal Bot — Setup Checklist

## 0. Chuẩn bị

- Node.js >= 20
- npm
- Telegram bot token từ `@BotFather`
- Supabase project
- Accesstrade publisher account

```powershell
cd D:\1_DU_AN\cashbackbot
npm install
```

## 1. Cấu hình `.env`

```powershell
copy .env.example .env
```

Điền tối thiểu:

```text
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ADMIN_IDS=<telegram_id_admin>
DATABASE_URL=<supabase_pooler_url>
DIRECT_URL=<supabase_direct_url>
ACCESSTRADE_PUB_ID=<publisher_id>
```

Nếu muốn deploy Railway webhook:

```text
NODE_ENV=production
TELEGRAM_UPDATES_MODE=webhook
PUBLIC_BASE_URL=https://cashbackbot-production.up.railway.app
# Optional: chỉ dùng để rút gọn link mở app Taobao/Tmall/1688.
# Shopee/Accesstrade và Telegram webhook vẫn dùng PUBLIC_BASE_URL.
TAOBAO_OPEN_BASE_URL=https://go.1688vn.com
TELEGRAM_WEBHOOK_PATH=/telegram/webhook/chotdeal-prod-20260505
TELEGRAM_WEBHOOK_SECRET_TOKEN=<random-secret>
ADMIN_WEB_TOKEN=<random-admin-web-token>
```

Web admin doc nhanh:

- URL: `https://<domain>/api/admin/web`
- Dang nhap bang `ADMIN_WEB_TOKEN`.
- Trang web admin chi nen dung de xem link/don/thong ke. Cac thao tac cong tien, match Alibo, broadcast van nen lam qua Telegram admin command de tranh bam nham.

## 2. Database

```powershell
npm run prisma:generate
npm run prisma:migrate -- --name init
```

Kiểm tra nhanh:

```powershell
npm run smoke
```

## 3. BotFather metadata

Làm theo [BOTFATHER_SETUP.md](/D:/1_DU_AN/cashbackbot/docs/BOTFATHER_SETUP.md).

Quan trọng nhất là `/setcommands` để menu có đủ:

- `start`
- `balance`
- `history`
- `deals_on`
- `deals_off`
- `deal_settings`
- `setbank`
- `withdraw`
- `help`
- `cancel`

## 4. Local run

```powershell
npm run start:dev
```

Kỳ vọng log:

```text
[Bootstrap] Cashback bot listening on port 3000
[Bootstrap] Telegram updates mode: polling
[Bootstrap] Telegram polling is active
```

Test:

1. `/start`
2. paste 1 link sản phẩm
3. `/balance`
4. `/history`
5. `/setbank`
6. `/withdraw`

## 5. Accesstrade setup

Điền thêm nếu có:

```text
ACCESSTRADE_API_TOKEN=<api_token>
ACCESSTRADE_CAMPAIGN_ID_SHOPEE=
ACCESSTRADE_CAMPAIGN_ID_LAZADA=
ACCESSTRADE_CAMPAIGN_ID_TIKI=
ACCESSTRADE_CAMPAIGN_ID_TIKTOK=
```

Ghi chú:

- `GET /v1/me` và `GET /v1/transactions` đã được verify
- create-link API chính thức hiện dùng `POST /v1/product_link/create`
- Postback thật của Accesstrade hiện dùng `transaction_id`, `utm_source`, `reward`, `product_price`, `status`, `is_confirmed` và thường không gửi `signature`.
- Bot chỉ mở cashback cho sàn có campaign ID verified. Hiện Shopee có campaign mặc định trong code.
- Muốn bật Lazada, cần lấy đúng campaign ID Lazada Việt Nam trong tài khoản đối tác rồi điền `ACCESSTRADE_CAMPAIGN_ID_LAZADA` trên Railway.
- nếu chưa có `campaign_id`, bot vẫn fallback về deeplink template nên không chặn launch

## 6. Test postback local

```powershell
npm run simulate:postback -- --sub=tg<sub_id> --order=O1 --commission=20000 --status=pending
npm run simulate:postback -- --sub=tg<sub_id> --order=O1 --commission=20000 --status=approved
```

Simulator mặc định gửi `transaction_id`, `utm_source`, `reward`, và `product_price`. Dùng `--tx=<id>` để retry cùng một transaction hoặc test nhiều dòng cho cùng `order`.

Kỳ vọng:

- `/balance` chuyển từ pending sang available
- user nhận notification khi approved

## 7. Deploy Railway

Repo đã có `railway.json`, nên flow đơn giản là:

1. Tạo Railway project/service
2. Import repo
3. Set env production
4. Deploy

Railway sẽ dùng:

- build command: `npm run build`
- pre-deploy command: `npm run prisma:deploy`
- start command: `npm run start:railway`
- healthcheck path: `/`

Sau deploy, kiểm tra:

```text
GET https://cashbackbot-production.up.railway.app/
GET https://cashbackbot-production.up.railway.app/api/health
```

Kỳ vọng log:

```text
[Bootstrap] Cashback bot listening on port <PORT>
[Bootstrap] Telegram updates mode: webhook
[Bootstrap] Telegram webhook URL: https://<railway-domain><path>
[Bootstrap] Accesstrade postback URL: https://<railway-domain>/api/postback/accesstrade
```

## 8. Configure public callbacks

Telegram webhook sẽ được app tự set khi boot bằng:

```text
https://cashbackbot-production.up.railway.app/telegram/webhook/chotdeal-prod-20260505
```

Accesstrade postback URL cần set thủ công trên dashboard:

```text
https://cashbackbot-production.up.railway.app/api/postback/accesstrade
```

## 9. Public simulator test

```powershell
npm run simulate:postback -- --endpoint=https://cashbackbot-production.up.railway.app/api/postback/accesstrade --sub=tg<sub_id> --order=CHOTDEAL001 --commission=20000 --status=approved
```

Test thêm admin flow:

- `/admin_payouts`
- `/admin_paid <id>`
- `/admin_cancel <id>`

## 10. Launch gate

Chỉ public rộng sau khi có ít nhất 1 đơn thật từ Accesstrade xác nhận:

- postback thật trả `200`
- unsigned payload có `transaction_id` được nhận đúng
- transaction map đúng user qua `utm_source`
- cùng `order_id` nhiều `transaction_id` tạo được nhiều rows
- balance cập nhật đúng
- notification hiển thị đúng

## Troubleshooting

- Bot không trả lời local: kiểm tra `TELEGRAM_UPDATES_MODE=polling`
- Production không nhận Telegram update: kiểm tra `PUBLIC_BASE_URL`, `TELEGRAM_WEBHOOK_PATH`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- Postback trả `401`: kiểm tra service đã deploy code mới chưa; nếu vẫn là build cũ, tạm xoá `ACCESSTRADE_POSTBACK_SECRET` trên Railway rồi redeploy
- Railway healthcheck fail: mở `GET /api/health` trực tiếp để xác nhận app lên thành công
