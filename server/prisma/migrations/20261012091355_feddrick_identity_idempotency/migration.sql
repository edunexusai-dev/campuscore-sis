-- CreateEnum
CREATE TYPE "IdentityRecordType" AS ENUM ('STUDENT', 'FACULTY');

-- CreateEnum
CREATE TYPE "IdentityLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "onBehalfOf" TEXT,
ADD COLUMN     "outcome" TEXT NOT NULL DEFAULT 'SUCCESS';

-- AlterTable
ALTER TABLE "Institution" ADD COLUMN     "emailDomain" TEXT,
ADD COLUMN     "studentEmailDomain" TEXT;

-- AlterTable
ALTER TABLE "IntegrationClient" ADD COLUMN     "writePreferences" JSONB;

-- CreateTable
CREATE TABLE "ExternalIdentityLink" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "externalSystem" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalEmail" TEXT,
    "externalLabel" TEXT,
    "recordType" "IdentityRecordType" NOT NULL,
    "studentId" TEXT,
    "facultyId" TEXT,
    "status" "IdentityLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "method" TEXT NOT NULL,
    "evidence" JSONB,
    "createdByType" "ActorType" NOT NULL,
    "createdById" TEXT,
    "createdByLabel" TEXT NOT NULL,
    "clientId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "revokedByLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalIdentityLink_institutionId_externalSystem_externalU_idx" ON "ExternalIdentityLink"("institutionId", "externalSystem", "externalUserId");

-- CreateIndex
CREATE INDEX "ExternalIdentityLink_studentId_idx" ON "ExternalIdentityLink"("studentId");

-- CreateIndex
CREATE INDEX "ExternalIdentityLink_facultyId_idx" ON "ExternalIdentityLink"("facultyId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_clientId_key_key" ON "IdempotencyRecord"("clientId", "key");

-- AddForeignKey
ALTER TABLE "ExternalIdentityLink" ADD CONSTRAINT "ExternalIdentityLink_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentityLink" ADD CONSTRAINT "ExternalIdentityLink_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentityLink" ADD CONSTRAINT "ExternalIdentityLink_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "Faculty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentityLink" ADD CONSTRAINT "ExternalIdentityLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "IntegrationClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "IntegrationClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written integrity rules (not expressible in the Prisma schema):
-- one ACTIVE link per external account, and one ACTIVE link per SIS record, per institution and external system.
CREATE UNIQUE INDEX "ExternalIdentityLink_active_external_user_uq" ON "ExternalIdentityLink"("institutionId", "externalSystem", "externalUserId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "ExternalIdentityLink_active_student_uq" ON "ExternalIdentityLink"("institutionId", "externalSystem", "studentId") WHERE "status" = 'ACTIVE' AND "studentId" IS NOT NULL;
CREATE UNIQUE INDEX "ExternalIdentityLink_active_faculty_uq" ON "ExternalIdentityLink"("institutionId", "externalSystem", "facultyId") WHERE "status" = 'ACTIVE' AND "facultyId" IS NOT NULL;
-- The target column must match the record type.
ALTER TABLE "ExternalIdentityLink" ADD CONSTRAINT "ExternalIdentityLink_target_ck" CHECK (
  ("recordType" = 'STUDENT' AND "facultyId" IS NULL) OR ("recordType" = 'FACULTY' AND "studentId" IS NULL)
);
