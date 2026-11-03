-- Automatic provisioning of university accounts (identity provider) from the person registry.
-- Additive only: a new enum, a new table, three functions and three triggers. No existing row is changed.
-- The triggers upsert the person's IdentityProvisioning row in the SAME transaction as the change that makes it
-- necessary, so a committed record change always has its provisioning request (transactional outbox), whatever
-- code path wrote it. Timestamps are written in UTC like Prisma's.
-- Rollback: DROP TRIGGER "Student_identity_provisioning" ON "Student"; DROP TRIGGER "Faculty_identity_provisioning" ON "Faculty";
--           DROP TRIGGER "Person_identity_provisioning" ON "Person"; DROP FUNCTION identity_provisioning_on_record();
--           DROP FUNCTION identity_provisioning_on_person(); DROP FUNCTION identity_provisioning_request(TEXT, TEXT);
--           DROP TABLE "IdentityProvisioning"; DROP TYPE "IdentityProvisioningStatus";

-- CreateEnum
CREATE TYPE "IdentityProvisioningStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROVISIONED', 'FAILED', 'NEEDS_REVIEW', 'SKIPPED');

-- CreateTable
CREATE TABLE "IdentityProvisioning" (
    "personId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "status" "IdentityProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "requestedVersion" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "keycloakUserId" TEXT,
    "adoptAccountId" TEXT,
    "lastAction" TEXT,
    "reason" TEXT,
    "lastResult" JSONB,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "setupEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityProvisioning_pkey" PRIMARY KEY ("personId")
);

-- CreateIndex
CREATE INDEX "IdentityProvisioning_status_nextAttemptAt_idx" ON "IdentityProvisioning"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IdentityProvisioning_institutionId_status_idx" ON "IdentityProvisioning"("institutionId", "status");

-- AddForeignKey
ALTER TABLE "IdentityProvisioning" ADD CONSTRAINT "IdentityProvisioning_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityProvisioning" ADD CONSTRAINT "IdentityProvisioning_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Request (re)provisioning of a person. Changes coalesce into the one row per person: a new request makes it
-- PENDING again (due now, attempts reset), except while a worker holds it (PROCESSING), where only
-- "requestedVersion" grows so the worker queues the person again when it finishes.
CREATE FUNCTION identity_provisioning_request(p_person_id TEXT, p_institution_id TEXT) RETURNS void AS $$
BEGIN
  IF p_person_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO "IdentityProvisioning" ("personId", "institutionId", "status", "requestedVersion", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
  VALUES (p_person_id, p_institution_id, 'PENDING', 1, 0, now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc')
  ON CONFLICT ("personId") DO UPDATE SET
    "requestedVersion" = "IdentityProvisioning"."requestedVersion" + 1,
    "status" = CASE WHEN "IdentityProvisioning"."status" = 'PROCESSING' THEN 'PROCESSING'::"IdentityProvisioningStatus" ELSE 'PENDING'::"IdentityProvisioningStatus" END,
    "attempts" = 0,
    "nextAttemptAt" = now() AT TIME ZONE 'utc',
    "updatedAt" = now() AT TIME ZONE 'utc';
END;
$$ LANGUAGE plpgsql;

-- Student / Faculty: a record was added or removed, or one of the columns named in the trigger's arguments
-- (what the university account is made of) changed. A record moved to another person (merge) requests both.
CREATE FUNCTION identity_provisioning_on_record() RETURNS trigger AS $$
DECLARE
  col TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM identity_provisioning_request(NEW."personId", NEW."institutionId");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM identity_provisioning_request(OLD."personId", OLD."institutionId");
  ELSE
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        PERFORM identity_provisioning_request(NEW."personId", NEW."institutionId");
        IF OLD."personId" IS DISTINCT FROM NEW."personId" THEN
          PERFORM identity_provisioning_request(OLD."personId", OLD."institutionId");
        END IF;
        RETURN NULL;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Person: merged into another person, or excluded from / included again in identity provisioning.
CREATE FUNCTION identity_provisioning_on_person() RETURNS trigger AS $$
BEGIN
  PERFORM identity_provisioning_request(NEW."id", NEW."institutionId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Student_identity_provisioning" AFTER INSERT OR UPDATE OR DELETE ON "Student"
  FOR EACH ROW EXECUTE FUNCTION identity_provisioning_on_record('personId', 'studentNumber', 'email', 'firstName', 'lastName', 'status');

CREATE TRIGGER "Faculty_identity_provisioning" AFTER INSERT OR UPDATE OR DELETE ON "Faculty"
  FOR EACH ROW EXECUTE FUNCTION identity_provisioning_on_record('personId', 'employeeNumber', 'email', 'firstName', 'lastName', 'status');

CREATE TRIGGER "Person_identity_provisioning" AFTER UPDATE OF "mergedIntoId", "identityExcluded" ON "Person"
  FOR EACH ROW WHEN (OLD."mergedIntoId" IS DISTINCT FROM NEW."mergedIntoId" OR OLD."identityExcluded" IS DISTINCT FROM NEW."identityExcluded")
  EXECUTE FUNCTION identity_provisioning_on_person();

-- Existing people with a record are reconciled once (on a fresh database there are none). Reconciling is
-- idempotent: accounts that already match are left unchanged.
INSERT INTO "IdentityProvisioning" ("personId", "institutionId", "status", "requestedVersion", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
SELECT p."id", p."institutionId", 'PENDING', 1, 0, now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
FROM "Person" p
WHERE p."mergedIntoId" IS NULL
  AND (EXISTS (SELECT 1 FROM "Student" s WHERE s."personId" = p."id") OR EXISTS (SELECT 1 FROM "Faculty" f WHERE f."personId" = p."id"));
