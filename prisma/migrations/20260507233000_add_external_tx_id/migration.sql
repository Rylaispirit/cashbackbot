-- Accesstrade can send multiple transaction rows for the same merchant order.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "externalTxId" TEXT;

DROP INDEX IF EXISTS "transactions_orderId_key";

-- One legacy manual CSV row aggregated two Accesstrade transaction rows for this
-- order. Split it before externalTxId becomes the idempotency key so future
-- postback retries update the correct row instead of creating duplicates.
DO $$
DECLARE
  legacy_row RECORD;
BEGIN
  SELECT *
  INTO legacy_row
  FROM "transactions"
  WHERE id = 'cmovh5kw40002cetjkuh3aklt'
    AND "orderId" = '260506PKPNMAGQ'
    AND "externalTxId" IS NULL
    AND status = 'PENDING'::"TransactionStatus";

  IF FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM "transactions"
      WHERE "externalTxId" IN ('455113078', '455111717')
    ) THEN
      RAISE EXCEPTION 'Cannot split legacy order 260506PKPNMAGQ because target externalTxId rows already exist';
    END IF;

    INSERT INTO "transactions" (
      id,
      "externalTxId",
      "orderId",
      "subId",
      "userId",
      "linkId",
      "saleAmount",
      "grossCommission",
      "userShare",
      "ownerShare",
      status,
      "rawPayload",
      "approvedAt",
      "createdAt",
      "updatedAt"
    )
    VALUES
      (
        'legacy_at_455113078',
        '455113078',
        legacy_row."orderId",
        legacy_row."subId",
        legacy_row."userId",
        legacy_row."linkId",
        104720,
        1152,
        806,
        346,
        'PENDING'::"TransactionStatus",
        jsonb_build_object(
          'source', 'legacy_split_from_accesstrade_csv_manual_reconcile',
          'legacyTransactionId', legacy_row.id,
          'transaction_id', '455113078',
          'order_id', legacy_row."orderId",
          'utm_source', legacy_row."subId",
          'reward', 1152,
          'product_price', 104720,
          'status', 0,
          'is_confirmed', 0,
          'originalRawPayload', legacy_row."rawPayload"
        ),
        NULL,
        legacy_row."createdAt",
        legacy_row."updatedAt"
      ),
      (
        'legacy_at_455111717',
        '455111717',
        legacy_row."orderId",
        legacy_row."subId",
        legacy_row."userId",
        legacy_row."linkId",
        104720,
        1885,
        1319,
        566,
        'PENDING'::"TransactionStatus",
        jsonb_build_object(
          'source', 'legacy_split_from_accesstrade_csv_manual_reconcile',
          'legacyTransactionId', legacy_row.id,
          'transaction_id', '455111717',
          'order_id', legacy_row."orderId",
          'utm_source', legacy_row."subId",
          'reward', 1885,
          'product_price', 104720,
          'status', 0,
          'is_confirmed', 0,
          'originalRawPayload', legacy_row."rawPayload"
        ),
        NULL,
        legacy_row."createdAt",
        legacy_row."updatedAt"
      )
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM "transactions"
    WHERE id = legacy_row.id;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "transactions_externalTxId_key" ON "transactions"("externalTxId");
CREATE INDEX IF NOT EXISTS "transactions_orderId_idx" ON "transactions"("orderId");
