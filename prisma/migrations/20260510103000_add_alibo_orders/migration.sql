-- Raw Alibo order sync. Syncing these rows does not move user balances;
-- admins explicitly match a row to a tracked link before creating a transaction.
CREATE TABLE IF NOT EXISTS "alibo_orders" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "platform" TEXT,
    "statusRaw" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "itemTitle" TEXT,
    "itemLink" TEXT,
    "itemImage" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "saleAmountCny" DECIMAL(12,2),
    "commissionCny" DECIMAL(12,2),
    "commissionVnd" INTEGER NOT NULL DEFAULT 0,
    "saleAmountVnd" INTEGER NOT NULL DEFAULT 0,
    "rawPayload" JSONB NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchedSubId" TEXT,
    "matchedLinkId" TEXT,
    "transactionId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alibo_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "alibo_orders_lineKey_key" ON "alibo_orders"("lineKey");
CREATE UNIQUE INDEX IF NOT EXISTS "alibo_orders_transactionId_key" ON "alibo_orders"("transactionId");
CREATE INDEX IF NOT EXISTS "alibo_orders_orderId_idx" ON "alibo_orders"("orderId");
CREATE INDEX IF NOT EXISTS "alibo_orders_matchStatus_createdAt_idx" ON "alibo_orders"("matchStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "alibo_orders_status_idx" ON "alibo_orders"("status");
CREATE INDEX IF NOT EXISTS "alibo_orders_paidAt_idx" ON "alibo_orders"("paidAt");

ALTER TABLE "alibo_orders"
  ADD CONSTRAINT "alibo_orders_matchedLinkId_fkey"
  FOREIGN KEY ("matchedLinkId") REFERENCES "links"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alibo_orders"
  ADD CONSTRAINT "alibo_orders_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
