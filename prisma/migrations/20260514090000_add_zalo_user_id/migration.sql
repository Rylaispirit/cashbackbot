-- Allow users to originate from Zalo without requiring a Telegram chat id.
ALTER TABLE "users" ALTER COLUMN "telegramId" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "zaloUserId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_zaloUserId_key" ON "users"("zaloUserId");
