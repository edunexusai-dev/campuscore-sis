-- Person registry: one Person per human being; Student, Faculty and User point to it.
-- Additive. Existing rows are backfilled, nothing is deleted or rewritten:
--   * a login that owns records (Student.userId / Faculty.userId) becomes one person with all of them,
--     which is exactly how CampusCore already expressed "same person" (e.g. a lecturer who also studies);
--   * every record without a login becomes a person of its own (never merged on name or email);
--   * staff-only logins (administrator, registrar) get no person.
-- Person numbers are assigned per institution, oldest first: P0000001, P0000002, ...
-- Rollback: ALTER TABLE "Student" DROP COLUMN "personId"; ALTER TABLE "Faculty" DROP COLUMN "personId";
--           ALTER TABLE "User" DROP COLUMN "personId"; DROP TABLE "Person";

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "personNumber" TEXT NOT NULL,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "User" ADD COLUMN "personId" TEXT;
ALTER TABLE "Student" ADD COLUMN "personId" TEXT;
ALTER TABLE "Faculty" ADD COLUMN "personId" TEXT;

-- Backfill 1: logins that own at least one record.
INSERT INTO "Person" ("id", "institutionId", "personNumber", "createdAt", "updatedAt")
SELECT 'per_' || u."id", u."institutionId", u."id", u."createdAt", CURRENT_TIMESTAMP
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "Student" s WHERE s."userId" = u."id")
   OR EXISTS (SELECT 1 FROM "Faculty" f WHERE f."userId" = u."id");

UPDATE "User" u SET "personId" = p."id" FROM "Person" p WHERE p."id" = 'per_' || u."id";
UPDATE "Student" s SET "personId" = 'per_' || s."userId" WHERE s."userId" IS NOT NULL;
UPDATE "Faculty" f SET "personId" = 'per_' || f."userId" WHERE f."userId" IS NOT NULL;

-- Backfill 2: records without a login, one person each.
INSERT INTO "Person" ("id", "institutionId", "personNumber", "createdAt", "updatedAt")
SELECT 'per_s_' || s."id", s."institutionId", 's_' || s."id", s."createdAt", CURRENT_TIMESTAMP FROM "Student" s WHERE s."personId" IS NULL;
UPDATE "Student" SET "personId" = 'per_s_' || "id" WHERE "personId" IS NULL;

INSERT INTO "Person" ("id", "institutionId", "personNumber", "createdAt", "updatedAt")
SELECT 'per_f_' || f."id", f."institutionId", 'f_' || f."id", f."createdAt", CURRENT_TIMESTAMP FROM "Faculty" f WHERE f."personId" IS NULL;
UPDATE "Faculty" SET "personId" = 'per_f_' || "id" WHERE "personId" IS NULL;

-- Backfill 3: person numbers (the temporary values above only kept the column unique-safe).
UPDATE "Person" p SET "personNumber" = 'P' || lpad(x.n::text, 7, '0')
FROM (SELECT "id", row_number() OVER (PARTITION BY "institutionId" ORDER BY "createdAt", "id") AS n FROM "Person") x
WHERE x."id" = p."id";

ALTER TABLE "Student" ALTER COLUMN "personId" SET NOT NULL;
ALTER TABLE "Faculty" ALTER COLUMN "personId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Person_institutionId_personNumber_key" ON "Person"("institutionId", "personNumber");
CREATE UNIQUE INDEX "Faculty_personId_key" ON "Faculty"("personId");
CREATE UNIQUE INDEX "Student_personId_key" ON "Student"("personId");
CREATE UNIQUE INDEX "User_personId_key" ON "User"("personId");

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Student" ADD CONSTRAINT "Student_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Faculty" ADD CONSTRAINT "Faculty_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
