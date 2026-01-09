-- Add email and name fields to code_ownership
ALTER TABLE "code_ownership" ADD COLUMN "engineer_email" TEXT;
ALTER TABLE "code_ownership" ADD COLUMN "engineer_name" TEXT;
CREATE INDEX "code_ownership_engineer_email_idx" ON "code_ownership"("engineer_email");

-- Add email and name fields to feature_ownership
ALTER TABLE "feature_ownership" ADD COLUMN "engineer_email" TEXT;
ALTER TABLE "feature_ownership" ADD COLUMN "engineer_name" TEXT;
CREATE INDEX "feature_ownership_engineer_email_idx" ON "feature_ownership"("engineer_email");
