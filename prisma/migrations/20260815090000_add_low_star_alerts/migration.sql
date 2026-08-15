-- v1.34 (SPEC-1.34): low-star review support alerts (default OFF).
ALTER TABLE "Setting" ADD COLUMN "lowStarAlerts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Setting" ADD COLUMN "lowStarAlertMax" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Setting" ADD COLUMN "alertRecipients" TEXT;
ALTER TABLE "Setting" ADD COLUMN "smtpHost" TEXT;
ALTER TABLE "Setting" ADD COLUMN "smtpPort" INTEGER NOT NULL DEFAULT 587;
ALTER TABLE "Setting" ADD COLUMN "smtpSecurity" TEXT NOT NULL DEFAULT 'starttls';
ALTER TABLE "Setting" ADD COLUMN "smtpUser" TEXT;
ALTER TABLE "Setting" ADD COLUMN "smtpPass" TEXT;
ALTER TABLE "Setting" ADD COLUMN "alertFromEmail" TEXT;
ALTER TABLE "Setting" ADD COLUMN "lastAlertAt" DATETIME;
ALTER TABLE "Setting" ADD COLUMN "lastAlertError" TEXT;
