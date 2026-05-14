# Zalo Bot Channel - Integration Guide

ChotDeal da co kenh Zalo Bot song song voi Telegram. Zalo chi dung webhook, khong co polling nhu Telegram.

## Files

```text
src/zalo/
├── zalo.types.ts
├── zalo.service.ts
├── zalo.controller.ts
└── zalo.module.ts

scripts/zalo-smoke.ts
```

## Runtime Endpoint

Webhook production:

```text
POST https://go.1688vn.com/api/webhook/zalo
```

Controller nhan webhook o `src/zalo/zalo.controller.ts`, verify secret token neu co `ZALO_SECRET_TOKEN`, tao/cap nhat user Zalo, roi xu ly lenh/link nhu Telegram o muc co ban.

## Env Vars

Them vao local `.env` va Railway/Oracle production:

```env
ZALO_BOT_TOKEN=<token tu dashboard Zalo>
ZALO_SECRET_TOKEN=<secret token 8-256 ky tu>
ZALO_BASE_URL=https://bot-api.zapps.me/bot
```

`ZALO_SECRET_TOKEN` phai trung voi o "Secret Token" trong dashboard Zalo. Neu de trong, webhook se khong verify secret, chi nen dung khi dev.

## Database

Migration da them:

```text
prisma/migrations/20260514090000_add_zalo_user_id/migration.sql
```

Thay doi schema:

```prisma
telegramId BigInt? @unique
zaloUserId String? @unique
```

Ly do: user co the den tu Zalo truoc, khong co Telegram ID.

Deploy production can chay:

```powershell
npm run prisma:deploy
```

Local dev can chay:

```powershell
npm run prisma:migrate
```

## Dashboard Zalo

1. Vao dashboard bot.zaloplatforms.com.
2. Mo bot ChotDeal.
3. Dien Webhook URL:

```text
https://go.1688vn.com/api/webhook/zalo
```

4. Tao Secret Token random 8-256 ky tu.
5. Paste Secret Token vao dashboard Zalo.
6. Set cung gia tri do vao env `ZALO_SECRET_TOKEN`.
7. Luu thay doi va restart app.

## Secret Token Verification

Zalo docs/screenshot xac nhan Secret Token dung de xac thuc request webhook. Format Zalo gui ve chua duoc verify chinh thuc, nen controller tam thoi check linh hoat:

```text
headers:
- x-zalo-secret-token
- x-secret-token
- x-bot-secret
- zalo-secret-token

query:
- secret
- token

body:
- secret
- secret_token
```

Sau webhook dau tien, xem log de biet Zalo gui secret o dau. Khi da chac format, co the tighten controller lai chi check dung vi tri do.

## Smoke Test

Kiem tra token:

```powershell
npm run zalo:smoke
```

Kiem tra gui tin neu da co `chat_id` that:

```powershell
npm run zalo:smoke -- --chat=<chat_id> --text="ChotDeal test"
```

Neu `ZALO_BOT_TOKEN` chua co trong `.env`, smoke test se fail dung ky vong.

## Supported Commands

Zalo v1 ho tro:

```text
/start
/help
/balance
/history
```

Paste link san pham Shopee/Lazada/Tiki/TikTok/Taobao/Tmall/1688 se tao link cashback nhu Telegram.

`/setbank` va `/withdraw` hien chua lam state machine tren Zalo, bot se huong user sang Telegram tam thoi.

## Notifications

NotificationsService da gui theo channel cua user:

```text
telegramId co gia tri -> gui Telegram
zaloUserId co gia tri -> gui Zalo
```

Deal broadcast va inline button hien van la Telegram-first. Zalo deal button/rich message se lam sau khi verify format nut bam cua Zalo Bot Platform.

## Test Checklist

```powershell
npx prisma validate
npm run prisma:generate
npm run typecheck
npm run build
npm run zalo:smoke
```

Production:

```text
1. Add env ZALO_* vao Railway/Oracle.
2. Run prisma migrate deploy.
3. Restart app.
4. Set dashboard webhook URL.
5. Nhan /start tren Zalo.
6. Check log co "Zalo update".
7. Paste link Shopee test.
```

## Known Limitations

```text
Zalo khong co polling API.
Webhook phai config bang dashboard, khong set bang API.
Inline keyboard/rich button chua verify.
Notification ngoai cua so chat co the bi Zalo limit, can theo doi log thuc te.
```
