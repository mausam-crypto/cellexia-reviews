-- v1.20 (SPEC-1.20): spend ceiling + Message Batches for AI curation.
ALTER TABLE "Setting" ADD COLUMN "curationBudgetUsd" REAL;
ALTER TABLE "Setting" ADD COLUMN "curationSpendMonth" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Setting" ADD COLUMN "curationSpendUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Setting" ADD COLUMN "curationBatchLock" DATETIME;

CREATE TABLE "CurationBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "anthropicBatchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "model" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "pairs" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "reservedUsd" REAL NOT NULL DEFAULT 0,
    "reservedMonth" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "claimedAt" DATETIME,
    "appliedAt" DATETIME
);
CREATE UNIQUE INDEX "CurationBatch_anthropicBatchId_key" ON "CurationBatch"("anthropicBatchId");
CREATE INDEX "CurationBatch_shop_status_idx" ON "CurationBatch"("shop", "status");

-- Staleness anchor: the PUBLISHED review count at curation time, so a run that
-- trimmed its payload is not stale the moment it finishes.
ALTER TABLE "AiCuration" ADD COLUMN "sourceCount" INTEGER NOT NULL DEFAULT 0;
