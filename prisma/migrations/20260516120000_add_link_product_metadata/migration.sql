-- Add product metadata + canonical resolution fields to links table for Alibo 3-tier auto-match
ALTER TABLE "links" ADD COLUMN "canonicalUrl" TEXT;
ALTER TABLE "links" ADD COLUMN "canonicalItemId" TEXT;
ALTER TABLE "links" ADD COLUMN "productTitle" TEXT;
ALTER TABLE "links" ADD COLUMN "aliboEncodedId" TEXT;
ALTER TABLE "links" ADD COLUMN "aliboMobileDeepLink" TEXT;

CREATE INDEX "links_canonicalItemId_idx" ON "links" ("canonicalItemId");
CREATE INDEX "links_aliboEncodedId_idx" ON "links" ("aliboEncodedId");
