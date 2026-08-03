-- v1.18 (SPEC-1.18): AI Curator candidate-source toggle + automatic refresh.
ALTER TABLE "Setting" ADD COLUMN "curationSource" TEXT NOT NULL DEFAULT 'as_seen';
ALTER TABLE "Setting" ADD COLUMN "curationRefresh" TEXT NOT NULL DEFAULT 'manual';
