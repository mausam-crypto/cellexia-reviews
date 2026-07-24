-- AlterTable
-- v1.4 review provenance (SPEC-1.4 §0). No backfill on purpose: pre-1.4 rows
-- keep a NULL "source" (the admin treats NULL as storefront) and are never
-- synthetic, which the column default already expresses.
ALTER TABLE "Review" ADD COLUMN "isSynthetic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Review" ADD COLUMN "source" TEXT;
ALTER TABLE "Review" ADD COLUMN "syntheticBatchId" TEXT;
ALTER TABLE "Review" ADD COLUMN "syntheticGeneratedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Review_shop_isSynthetic_idx" ON "Review"("shop", "isSynthetic");
