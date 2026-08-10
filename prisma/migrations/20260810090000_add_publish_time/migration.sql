-- v1.30 (SPEC-1.30): scheduled auto-publish for QA-generated batches.
ALTER TABLE "GenerationJob" ADD COLUMN "publishAt" DATETIME;
ALTER TABLE "GenerationJob" ADD COLUMN "publishedAt" DATETIME;
