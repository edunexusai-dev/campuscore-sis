-- Identity provisioning exclusion on Person. Additive: every existing person stays eligible (false).
-- Rollback: ALTER TABLE "Person" DROP COLUMN "identityExcluded", DROP COLUMN "identityExcludedReason", DROP COLUMN "identityExcludedAt";
ALTER TABLE "Person" ADD COLUMN "identityExcluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "identityExcludedReason" TEXT,
ADD COLUMN "identityExcludedAt" TIMESTAMP(3);
