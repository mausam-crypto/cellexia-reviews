-- v1.24 (SPEC-1.24): the QA generator's skeptical double-check.
ALTER TABLE "Review" ADD COLUMN "qaChecked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GenerationJob" ADD COLUMN "checkedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GenerationJob" ADD COLUMN "removedByCheck" INTEGER NOT NULL DEFAULT 0;
