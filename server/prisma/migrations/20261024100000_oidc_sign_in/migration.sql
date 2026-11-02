-- University sign-in (OpenID Connect) for CampusCore: identity links and SSO session fields.
-- Additive only. Rollback: DROP TABLE "UserIdentityLink"; ALTER TABLE "Session" DROP COLUMN "authMethod", DROP COLUMN "oidcIssuer", DROP COLUMN "oidcSubject", DROP COLUMN "oidcSid", DROP COLUMN "idTokenSealed";

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "authMethod" TEXT NOT NULL DEFAULT 'PASSWORD',
ADD COLUMN     "idTokenSealed" TEXT,
ADD COLUMN     "oidcIssuer" TEXT,
ADD COLUMN     "oidcSid" TEXT,
ADD COLUMN     "oidcSubject" TEXT;

-- CreateTable
CREATE TABLE "UserIdentityLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "linkMethod" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "UserIdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentityLink_issuer_subject_key" ON "UserIdentityLink"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentityLink_userId_issuer_key" ON "UserIdentityLink"("userId", "issuer");

-- CreateIndex
CREATE INDEX "Session_oidcIssuer_oidcSid_idx" ON "Session"("oidcIssuer", "oidcSid");

-- CreateIndex
CREATE INDEX "Session_oidcIssuer_oidcSubject_idx" ON "Session"("oidcIssuer", "oidcSubject");

-- AddForeignKey
ALTER TABLE "UserIdentityLink" ADD CONSTRAINT "UserIdentityLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

