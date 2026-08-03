-- v1.14 (SPEC-1.14): market-scoped go-live + Stamped takeover.
ALTER TABLE "Setting" ADD COLUMN "liveScope" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "Setting" ADD COLUMN "liveMarkets" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Setting" ADD COLUMN "hideStamped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Setting" ADD COLUMN "stampedSelectors" TEXT;
ALTER TABLE "Setting" ADD COLUMN "observedMarkets" TEXT NOT NULL DEFAULT '{}';
