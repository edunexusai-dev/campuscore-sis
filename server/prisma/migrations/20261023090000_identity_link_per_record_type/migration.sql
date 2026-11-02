-- One ACTIVE link per external account AND record type (was: per external account).
-- Lets one person hold a STUDENT and a FACULTY link at the same time. The per-record guards
-- (one ACTIVE link per student record and per faculty record) are unchanged. Every row that
-- satisfied the old index satisfies the new one, so no existing link is affected.
-- Rollback: drop the new index and recreate the old one (only possible while no account holds
-- two ACTIVE links):
--   DROP INDEX "ExternalIdentityLink_active_external_user_type_uq";
--   CREATE UNIQUE INDEX "ExternalIdentityLink_active_external_user_uq" ON "ExternalIdentityLink"("institutionId", "externalSystem", "externalUserId") WHERE "status" = 'ACTIVE';
DROP INDEX IF EXISTS "ExternalIdentityLink_active_external_user_uq";
CREATE UNIQUE INDEX "ExternalIdentityLink_active_external_user_type_uq"
  ON "ExternalIdentityLink"("institutionId", "externalSystem", "externalUserId", "recordType")
  WHERE "status" = 'ACTIVE';
