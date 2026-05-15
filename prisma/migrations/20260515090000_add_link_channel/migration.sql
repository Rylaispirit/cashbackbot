ALTER TABLE "links" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'telegram';

CREATE INDEX "links_channel_createdAt_idx" ON "links"("channel", "createdAt");
