-- CreateEnum
CREATE TYPE "FeeCategory" AS ENUM ('TUITION', 'TECHNOLOGY', 'STUDENT_SERVICES', 'REGISTRATION', 'LABORATORY', 'COURSE', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeBasis" AS ENUM ('FLAT', 'PER_CREDIT');

-- CreateEnum
CREATE TYPE "StudentAccountStatus" AS ENUM ('OPEN', 'ON_HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'CREDIT', 'REFUND', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'VOID');

-- CreateTable
CREATE TABLE "FeeDefinition" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "FeeCategory" NOT NULL,
    "basis" "FeeBasis" NOT NULL DEFAULT 'FLAT',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "termId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAccount" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "status" "StudentAccountStatus" NOT NULL DEFAULT 'OPEN',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dueDate" DATE,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "feeDefinitionId" TEXT,
    "quantity" DECIMAL(8,2),
    "unitAmount" DECIMAL(12,2),
    "method" TEXT,
    "externalRef" TEXT,
    "reversesId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "effectiveDate" DATE NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByLabel" TEXT NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATE NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeeDefinition_institutionId_active_idx" ON "FeeDefinition"("institutionId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "FeeDefinition_institutionId_code_key" ON "FeeDefinition"("institutionId", "code");

-- CreateIndex
CREATE INDEX "StudentAccount_institutionId_termId_idx" ON "StudentAccount"("institutionId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAccount_studentId_termId_key" ON "StudentAccount"("studentId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAccount_institutionId_accountNumber_key" ON "StudentAccount"("institutionId", "accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reference_key" ON "LedgerEntry"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reversesId_key" ON "LedgerEntry"("reversesId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_postedAt_idx" ON "LedgerEntry"("accountId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_accountId_idempotencyKey_key" ON "LedgerEntry"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_accountId_idx" ON "Invoice"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_ledgerEntryId_key" ON "InvoiceLine"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- AddForeignKey
ALTER TABLE "FeeDefinition" ADD CONSTRAINT "FeeDefinition_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeDefinition" ADD CONSTRAINT "FeeDefinition_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAccount" ADD CONSTRAINT "StudentAccount_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAccount" ADD CONSTRAINT "StudentAccount_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAccount" ADD CONSTRAINT "StudentAccount_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_feeDefinitionId_fkey" FOREIGN KEY ("feeDefinitionId") REFERENCES "FeeDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "StudentAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Amounts are positive; the direction says which way an entry moves the balance.
ALTER TABLE "FeeDefinition" ADD CONSTRAINT "FeeDefinition_amount_nonnegative" CHECK ("amount" >= 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_total_nonnegative" CHECK ("total" >= 0);

-- The ledger is append-only: a posted entry is never edited, and only illustrative (demo) entries may be deleted,
-- by the demo seed's cleanup. Corrections are REVERSAL or ADJUSTMENT entries.
CREATE FUNCTION ledger_entry_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'LedgerEntry % is posted and cannot be changed; post a reversal or adjustment instead', OLD."id";
  END IF;
  IF OLD."isDemo" = false THEN
    RAISE EXCEPTION 'LedgerEntry % is a posted financial record and cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();
