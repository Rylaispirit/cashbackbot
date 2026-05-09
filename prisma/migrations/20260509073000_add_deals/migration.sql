-- Deal broadcasts are stored once; user-specific affiliate links are created
-- lazily only when the user taps the Telegram deal button.
CREATE TABLE IF NOT EXISTS "deals" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "merchant" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByTelegramId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "deals_isActive_idx" ON "deals"("isActive");
CREATE INDEX IF NOT EXISTS "deals_createdAt_idx" ON "deals"("createdAt");
