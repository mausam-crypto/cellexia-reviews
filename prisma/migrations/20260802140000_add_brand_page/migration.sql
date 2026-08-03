-- v1.19 (SPEC-1.19): "Cellexia Reviews" brand page.
ALTER TABLE "Setting" ADD COLUMN "brandPageConfig" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "BrandAnalysis" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "sections" TEXT NOT NULL,
    "reviewCount" INTEGER NOT NULL,
    "dateFrom" DATETIME,
    "dateTo" DATETIME,
    "model" TEXT,
    "generatedAt" DATETIME NOT NULL
);
