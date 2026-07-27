-- CreateTable
-- v1.7 background QA generation (SPEC-1.7 §1): one row per generation job,
-- claimed and driven by the setTimeout runner in app/services/jobs.server.ts.
-- "heartbeatAt" is refreshed after every chunk; a RUNNING row whose heartbeat
-- is older than 3 minutes is treated as crashed and re-queued (its already
-- created reviews stay — resuming counts existing rows for "batchId" first so
-- the job never overshoots "target").
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "batchId" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "chunksTotal" INTEGER NOT NULL DEFAULT 0,
    "chunksDone" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "estimate" TEXT,
    "error" TEXT,
    "errors" TEXT NOT NULL DEFAULT '[]',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
-- v1.7 rolling throughput calibration per shop+model (SPEC-1.7 §4): measured
-- from real chunks, powers the "measured" basis of cost/time estimates.
CREATE TABLE "ModelThroughput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "totalSeconds" REAL NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "totalInTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GenerationJob_shop_status_idx" ON "GenerationJob"("shop", "status");

-- CreateIndex
CREATE INDEX "GenerationJob_shop_createdAt_idx" ON "GenerationJob"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelThroughput_shop_model_key" ON "ModelThroughput"("shop", "model");
