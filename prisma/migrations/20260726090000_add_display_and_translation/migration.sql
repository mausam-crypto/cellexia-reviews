-- AlterTable
-- v1.8 review display order + translation display mode (SPEC-1.8 §1).
--
-- "rankingStrategy" is the shop-wide default display order (a
-- RANKING_STRATEGIES key); "rankingBoosts" is a JSON object
-- { boostVerified?: boolean, boostMedia?: boolean } whose true flags prepend
-- orderBy keys (never applied to the "balanced" strategy);
-- "translationDisplay" chooses between the pre-1.8 behavior ("original":
-- original language + Translate button) and auto-translated display
-- ("translated": shopper-locale text + a See original toggle). No backfill is
-- needed: all three defaults reproduce today's behavior byte-for-byte, so
-- existing stores upgrade with zero shopper-visible change.
ALTER TABLE "Setting" ADD COLUMN "rankingStrategy" TEXT NOT NULL DEFAULT 'amazon_top';
ALTER TABLE "Setting" ADD COLUMN "rankingBoosts" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "Setting" ADD COLUMN "translationDisplay" TEXT NOT NULL DEFAULT 'original';

-- CreateTable
-- v1.8 per-product display override (SPEC-1.8 §1): at most one row per
-- (shop, productId). "strategy" is a RANKING_STRATEGIES key or NULL (inherit
-- the shop default); "pinnedIds" is a JSON string[] of review ids in the
-- exact order the merchant arranged them to show first. The admin deletes the
-- row when a product reverts to the default with no pins, so a missing row
-- means "inherit everything".
CREATE TABLE "ProductDisplayConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "strategy" TEXT,
    "pinnedIds" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductDisplayConfig_shop_productId_key" ON "ProductDisplayConfig"("shop", "productId");
