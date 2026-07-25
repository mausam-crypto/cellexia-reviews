-- AlterTable
-- v1.6 storefront-connection health (SPEC-1.6 §2).
--
-- "proxySubpath" is the app-proxy subpath this install actually serves. No
-- backfill is needed: the column default is the shipped subpath
-- ("cellexia-reviews"), and probeProxySubpath overwrites it with the detected
-- value on the next install/re-auth or storefront health check.
--
-- "lastStorefrontHitAt" starts NULL on purpose — "no storefront request has
-- ever arrived". The health check reports that as a warning ("is the app embed
-- enabled?"), never as a failure, so existing stores are not flagged as broken
-- until their first storefront request lands.
-- "lastSyncError" / "lastSyncAt" (v1.6.1, SPEC-1.6.1 §A) record the outcome of
-- the most recent product metafield sync so a failure is visible in the admin
-- instead of only in the server log. Both start NULL — "no sync has run yet",
-- which health check 5 reports as a pass (nothing is known to be broken) until
-- the first write path records a real outcome. Added to this migration rather
-- than a new one because the v1.6 schema has not shipped to any database yet.
ALTER TABLE "Setting" ADD COLUMN "proxySubpath" TEXT NOT NULL DEFAULT 'cellexia-reviews';
ALTER TABLE "Setting" ADD COLUMN "lastStorefrontHitAt" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "lastSyncError" TEXT;
ALTER TABLE "Setting" ADD COLUMN "lastSyncAt" DATETIME;
