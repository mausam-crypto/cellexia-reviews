-- v1.17 (SPEC-1.17): AI Curator.
ALTER TABLE "Setting" ADD COLUMN "curationInstructions" TEXT;
ALTER TABLE "Setting" ADD COLUMN "curationOverviewField" TEXT NOT NULL DEFAULT 'accentuate.overview';
CREATE TABLE "AiCuration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "orderedIds" TEXT NOT NULL DEFAULT '[]',
    "rationale" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AiCuration_shop_productId_locale_key" ON "AiCuration"("shop", "productId", "locale");
CREATE INDEX "AiCuration_shop_productId_idx" ON "AiCuration"("shop", "productId");
