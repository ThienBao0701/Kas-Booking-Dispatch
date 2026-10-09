-- CROSS-MODULE WORKFLOW — additive only.
--
-- Nothing is dropped, renamed, rewritten or backfilled. Every new column is
-- nullable, every new enum value is appended, so code from the previous release
-- still reads and writes this schema unchanged.
--
--   * UserRole += TECHNICAL_GENERAL_MANAGER ("Tổng quản lý kỹ thuật").
--   * Reception journal: who deleted a record (role), "Nhập bù" late entries
--     (entered-by + required reason), audit actor role, LATE_ENTRY audit action.
--   * Facility incidents: the current hand-off to a Quản lý kỹ thuật, the note
--     on an in-house assignment, and HotelIssueDispatch — the append-only chain
--     of hand-offs to managers and outside contractors, with the repair cost.
--   * Housekeeping: RoomWorkState += INSPECTED ("Đã kiểm tra"), event STARTED.
--
-- The ADD VALUE statements are not used by anything else in this migration,
-- which is what PostgreSQL requires of a new enum value inside a transaction.

-- CreateEnum
CREATE TYPE "IssueDispatchKind" AS ENUM ('TO_MANAGER', 'TO_EXTERNAL');

-- CreateEnum
CREATE TYPE "ExternalContractorType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- AlterEnum
ALTER TYPE "ReceptionReportAuditAction" ADD VALUE 'LATE_ENTRY';

-- AlterEnum
ALTER TYPE "RoomTaskEventType" ADD VALUE 'STARTED';

-- AlterEnum
ALTER TYPE "RoomWorkState" ADD VALUE 'INSPECTED';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'TECHNICAL_GENERAL_MANAGER';

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "assignedManagerAt" TIMESTAMP(3),
ADD COLUMN     "assignedManagerByNameSnapshot" TEXT,
ADD COLUMN     "assignedManagerByUserId" INTEGER,
ADD COLUMN     "assignedManagerNameSnapshot" TEXT,
ADD COLUMN     "assignedManagerNote" TEXT,
ADD COLUMN     "assignedManagerUserId" INTEGER;

-- AlterTable
ALTER TABLE "HotelIssueAssignment" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "ReceptionOperationalReport" ADD COLUMN     "enteredByNameSnapshot" TEXT,
ADD COLUMN     "enteredByRole" "UserRole",
ADD COLUMN     "enteredByUserId" INTEGER,
ADD COLUMN     "lateEntryReason" TEXT,
ADD COLUMN     "voidedByRole" "UserRole";

-- AlterTable
ALTER TABLE "ReceptionReportAudit" ADD COLUMN     "actorRole" "UserRole";

-- CreateTable
CREATE TABLE "HotelIssueDispatch" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "kind" "IssueDispatchKind" NOT NULL,
    "assignedByUserId" INTEGER NOT NULL,
    "assignedByNameSnapshot" TEXT NOT NULL,
    "assignedByRole" "UserRole" NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "managerUserId" INTEGER,
    "managerNameSnapshot" TEXT,
    "previousManagerUserId" INTEGER,
    "previousManagerNameSnapshot" TEXT,
    "contractorName" TEXT,
    "contractorPhone" TEXT,
    "contractorSpecialty" TEXT,
    "contractorType" "ExternalContractorType",
    "contractorCompany" TEXT,
    "attemptId" TEXT,
    "repairCost" INTEGER,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" INTEGER,
    "completedByNameSnapshot" TEXT,
    "completionNote" TEXT,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "HotelIssueDispatch_pkey" PRIMARY KEY ("id"),
    -- A cost is whole đồng, never negative (0 = done without charge).
    CONSTRAINT "HotelIssueDispatch_cost_non_negative" CHECK ("repairCost" IS NULL OR "repairCost" >= 0),
    -- Each kind carries what it is about: a manager, or a contractor's name and phone.
    CONSTRAINT "HotelIssueDispatch_kind_fields" CHECK (
      ("kind" = 'TO_MANAGER' AND "managerUserId" IS NOT NULL)
      OR ("kind" = 'TO_EXTERNAL' AND "contractorName" IS NOT NULL AND "contractorPhone" IS NOT NULL AND "contractorType" IS NOT NULL)
    ),
    -- "Công ty" always names the company.
    CONSTRAINT "HotelIssueDispatch_company_named" CHECK ("contractorType" IS DISTINCT FROM 'COMPANY' OR "contractorCompany" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelIssueDispatch_attemptId_key" ON "HotelIssueDispatch"("attemptId");

-- CreateIndex
CREATE INDEX "HotelIssueDispatch_issueId_createdAt_idx" ON "HotelIssueDispatch"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueDispatch_managerUserId_createdAt_idx" ON "HotelIssueDispatch"("managerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueDispatch_branchId_createdAt_idx" ON "HotelIssueDispatch"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueDispatch_assignedByUserId_idx" ON "HotelIssueDispatch"("assignedByUserId");

-- CreateIndex
CREATE INDEX "HotelIssueDispatch_completedByUserId_idx" ON "HotelIssueDispatch"("completedByUserId");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_enteredByUserId_idx" ON "ReceptionOperationalReport"("enteredByUserId");

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_assignedManagerUserId_fkey" FOREIGN KEY ("assignedManagerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_enteredByUserId_fkey" FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueDispatch" ADD CONSTRAINT "HotelIssueDispatch_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueDispatch" ADD CONSTRAINT "HotelIssueDispatch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueDispatch" ADD CONSTRAINT "HotelIssueDispatch_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueDispatch" ADD CONSTRAINT "HotelIssueDispatch_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueDispatch" ADD CONSTRAINT "HotelIssueDispatch_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
