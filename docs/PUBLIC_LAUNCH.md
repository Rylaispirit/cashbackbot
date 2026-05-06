# ChotDeal Public Launch Checklist

## Current status

The bot is ready for a public soft launch.

- Railway health endpoint must return `200 OK`.
- Telegram must respond to `/start`.
- Shopee links must be generated through Accesstrade Smartlink and preferably return `shorten.asia`.
- Accesstrade postback URL must stay active:
  `https://cashbackbot-production.up.railway.app/api/postback/accesstrade`
- Admin link tracking is available through `/admin_links` and `/admin_link <sub_id>`.

## One-command checks

Run this before inviting testers:

```powershell
npm run launch:check
```

Run this after changing Telegram commands:

```powershell
npm run telegram:set-commands
```

## Soft launch flow

1. Invite 3-5 trusted testers.
2. Ask each tester to send `/start`, paste one Shopee product link, and open the bot-generated cashback link.
3. Ask one tester to place a small real order.
4. Wait for Accesstrade to record the conversion and send postback.
5. Verify the order in Telegram:
   - User: `/history`
   - Admin: `/admin_recent`
   - Admin: `/admin_link <sub_id>`

## Launch gate

Do not promote widely until one real Accesstrade order passes all checks:

- Real postback returns `200`.
- Signature verification passes.
- Transaction maps to the correct user by `sub1`.
- Pending and approved balances move correctly.
- User receives the approval/rejection notification.

## Rollout

- Stage 1: 3-5 trusted users for 1-2 days.
- Stage 2: light public promotion after one real order is verified.
- Stage 3: wider promotion after several real orders and payouts behave correctly.
