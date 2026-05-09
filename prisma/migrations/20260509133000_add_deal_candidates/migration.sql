-- Store deal candidates detected from Accesstrade. Admin approval turns a
-- candidate into a user-facing Deal; users still get their own tracking link
-- only after tapping the Telegram button.
CREATE TABLE IF NOT EXISTS "deal_candidates" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'accesstrade',
    "externalId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "originalUrl" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sourceAffiliateUrl" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "score" INTEGER NOT NULL DEFAULT 0,
    "rawPayload" JSONB,
    "dealId" TEXT,
    "reviewedByTelegramId" BIGINT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deal_candidates_source_externalId_key" ON "deal_candidates"("source", "externalId");
CREATE INDEX IF NOT EXISTS "deal_candidates_status_createdAt_idx" ON "deal_candidates"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "deal_candidates_merchant_idx" ON "deal_candidates"("merchant");
