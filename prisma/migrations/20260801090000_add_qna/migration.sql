-- v1.16 (SPEC-1.16): review Q&A + suggested questions + summary activation.
ALTER TABLE "Summary" ADD COLUMN "suggestedQuestions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Setting" ADD COLUMN "showQna" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "AskAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "questionHash" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "quotes" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AskAnswer_shop_productId_locale_questionHash_key" ON "AskAnswer"("shop", "productId", "locale", "questionHash");
CREATE INDEX "AskAnswer_shop_productId_idx" ON "AskAnswer"("shop", "productId");
