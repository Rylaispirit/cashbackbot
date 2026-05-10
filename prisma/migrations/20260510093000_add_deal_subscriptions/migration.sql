CREATE TABLE IF NOT EXISTS "deal_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL DEFAULT 'all',
    "category" TEXT NOT NULL DEFAULT 'all',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deal_subscriptions_userId_merchant_category_key"
    ON "deal_subscriptions"("userId", "merchant", "category");

CREATE INDEX IF NOT EXISTS "deal_subscriptions_isEnabled_merchant_category_idx"
    ON "deal_subscriptions"("isEnabled", "merchant", "category");

CREATE INDEX IF NOT EXISTS "deal_subscriptions_userId_idx"
    ON "deal_subscriptions"("userId");

ALTER TABLE "deal_subscriptions"
    ADD CONSTRAINT "deal_subscriptions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
