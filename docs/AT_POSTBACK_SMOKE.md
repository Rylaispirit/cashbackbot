# Accesstrade Postback Smoke Test

Use this after Railway deploys the hotfix and runs `prisma migrate deploy`.

Set these PowerShell variables first:

```powershell
$BASE_URL = "https://cashbackbot-production.up.railway.app"
$SUB_ID = "tg_replace_with_real_sub_id"
$ORDER_ID = "SMOKE-" + (Get-Date -Format "yyyyMMddHHmmss")
```

## 1. Retry Same Transaction (Fail Fast)

This checks the core idempotency assumption first: same `transaction_id` must not create a second row or double-credit balance.

```powershell
$NUM_TX = [int64](Get-Date -Format "yyyyMMddHHmmss")
$dedupBody = @{
  order_id = "${ORDER_ID}-DEDUP"
  transaction_id = $NUM_TX
  utm_source = $SUB_ID
  reward = 1885.0
  product_price = 104720.0
  status = 0
  is_confirmed = 0
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BASE_URL/api/postback/accesstrade" `
  -ContentType "application/json" `
  -Body $dedupBody

Invoke-RestMethod `
  -Method Post `
  -Uri "$BASE_URL/api/postback/accesstrade" `
  -ContentType "application/json" `
  -Body $dedupBody
```

Expected:

- Both responses are `{ ok: true }`.
- Only one transaction row exists for `$NUM_TX`.
- Balance is incremented once.

## 2. String Payload

```powershell
npm run simulate:postback -- `
  --endpoint="$BASE_URL/api/postback/accesstrade" `
  --sub=$SUB_ID `
  --order="$ORDER_ID-STRING" `
  --tx="AT-SMOKE-STRING-$ORDER_ID" `
  --commission=1885.0 `
  --saleAmount=104720.0 `
  --status=0 `
  --is_confirmed=0
```

Expected:

- HTTP status is `200`.
- Railway log includes `Postback in: tx=AT-SMOKE-STRING`.
- One pending transaction is created.

## 3. Numeric Payload

```powershell
$NUM_TX_2 = [int64](Get-Date -Format "yyyyMMddHHmmss")
$body = @{
  order_id = "${ORDER_ID}-NUMERIC"
  transaction_id = $NUM_TX_2
  utm_source = $SUB_ID
  reward = 1885.0
  product_price = 104720.0
  status = 0
  is_confirmed = 0
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$BASE_URL/api/postback/accesstrade" `
  -ContentType "application/json" `
  -Body $body
```

Expected:

- Response is `{ ok: true }`.
- No validation error appears in Railway logs.
- Pending balance increases by the computed user share.

## 4. Split Main + Bonus Rows

```powershell
$splitOrder = "$ORDER_ID-SPLIT"

npm run simulate:postback -- `
  --endpoint="$BASE_URL/api/postback/accesstrade" `
  --sub=$SUB_ID `
  --order=$splitOrder `
  --tx="AT-SMOKE-MAIN-$ORDER_ID" `
  --commission=1885.0 `
  --saleAmount=104720.0 `
  --status=0 `
  --is_confirmed=0

npm run simulate:postback -- `
  --endpoint="$BASE_URL/api/postback/accesstrade" `
  --sub=$SUB_ID `
  --order=$splitOrder `
  --tx="AT-SMOKE-BONUS-$ORDER_ID" `
  --commission=1152.0 `
  --saleAmount=104720.0 `
  --status=0 `
  --is_confirmed=0
```

Expected:

- Two transaction rows exist with the same `orderId`.
- The rows have different `externalTxId` values.
- User pending balance includes both rows.
- Telegram sends at most one pending notification for the order/status group.

## 5. Pending To Approved

Replay one split row using the same `transaction_id` and approved status:

```powershell
npm run simulate:postback -- `
  --endpoint="$BASE_URL/api/postback/accesstrade" `
  --sub=$SUB_ID `
  --order=$splitOrder `
  --tx="AT-SMOKE-MAIN-$ORDER_ID" `
  --commission=1885.0 `
  --saleAmount=104720.0 `
  --status=1 `
  --is_confirmed=1
```

Expected:

- The existing row transitions from `PENDING` to `APPROVED`.
- Pending balance decreases by that row's `userShare`.
- Available balance increases by that row's `userShare`.
- Telegram sends at most one approved notification for the order/status group.

## 6. Optional Smoke Cleanup

Smoke tests create real production rows and adjust the test user's balances. Run cleanup only if every smoke order used the `SMOKE-` prefix.

Preview first:

```sql
SELECT "orderId", "externalTxId", status, "userShare"
FROM "transactions"
WHERE "orderId" LIKE 'SMOKE-%'
ORDER BY "createdAt" DESC;
```

Cleanup:

```sql
BEGIN;

WITH smoke AS (
  SELECT
    "userId",
    COALESCE(SUM(CASE WHEN status = 'PENDING'::"TransactionStatus" THEN "userShare" ELSE 0 END), 0)::integer AS pending,
    COALESCE(SUM(CASE WHEN status = 'APPROVED'::"TransactionStatus" THEN "userShare" ELSE 0 END), 0)::integer AS available
  FROM "transactions"
  WHERE "orderId" LIKE 'SMOKE-%'
  GROUP BY "userId"
),
balance_cleanup AS (
  UPDATE "users" u
  SET
    "balancePending" = u."balancePending" - smoke.pending,
    "balanceAvail" = u."balanceAvail" - smoke.available
  FROM smoke
  WHERE u.id = smoke."userId"
  RETURNING u.id
)
DELETE FROM "transactions"
WHERE "orderId" LIKE 'SMOKE-%';

COMMIT;
```

Expected:

- Smoke transactions are deleted.
- Pending/available balances are reversed for the affected test user.

## 7. Optional Legacy Backfill

Run this only after the migration has added `externalTxId` in production:

```powershell
npm run backfill:external-tx-id -- --dry
```

If the dry run reports no conflicts and the candidate list looks correct:

```powershell
npm run backfill:external-tx-id -- --apply
```

Expected:

- Rows with `rawPayload.transaction_id` get that exact value as `externalTxId`.
- Alibo/manual rows get `externalTxId = alibo_<orderId>`.
- Unknown legacy rows remain `NULL`.
