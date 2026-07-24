-- AlterTable
ALTER TABLE "Setting" ADD COLUMN "isLive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Setting" ADD COLUMN "previewToken" TEXT;

-- Upgrade safety: stores already running v1.0/v1.1 must not go dark — every
-- existing Setting row was created by a store whose widget is already visible,
-- so backfill them as live. New installs (rows created after this migration)
-- start NOT live via the column default.
UPDATE "Setting" SET "isLive" = true;
