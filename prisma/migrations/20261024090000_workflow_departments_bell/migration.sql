-- WORKFLOW DEPARTMENTS: Bell, request routing and completion attribution,
-- assigned vs self-claimed housekeeping work, and how a housekeeping shift ended.
-- ADDITIVE: new enum values, new enums and nullable columns only. No row is
-- rewritten and nothing is backfilled — a past completion's department or a
-- past group's assigner is not invented; the code reads them as unknown.

-- A department's staff role: "Bell", branch-bound like a receptionist.
ALTER TYPE "UserRole" ADD VALUE 'BELL';

-- Assigning a request's responsible person is audited like every correction.
ALTER TYPE "ReceptionReportAuditAction" ADD VALUE 'ASSIGN';
-- The name on an open shift ("CA A · 06:00–14:00 · <tên>") corrected by its owner.
ALTER TYPE "ReceptionReportAuditAction" ADD VALUE 'SHIFT_NAME';

-- "Yêu cầu khách mới" — a request routed to someone.
ALTER TYPE "NotificationKind" ADD VALUE 'REQUEST_ASSIGNED';

-- CreateEnum
CREATE TYPE "WorkDepartment" AS ENUM ('RECEPTION', 'HOUSEKEEPING', 'BELL');

-- AlterTable: the receiving department, the responsible person, and the
-- department that actually completed it — three separate facts.
ALTER TABLE "GuestRequestReport"
  ADD COLUMN "receivingDepartment" "WorkDepartment",
  ADD COLUMN "assigneeUserId" INTEGER,
  ADD COLUMN "assigneeNameSnapshot" TEXT,
  ADD COLUMN "assigneeDepartment" "WorkDepartment",
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "assignedByUserId" INTEGER,
  ADD COLUMN "assignedByNameSnapshot" TEXT,
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "completedDepartment" "WorkDepartment";

ALTER TABLE "GuestRequestReport"
  ADD CONSTRAINT "GuestRequestReport_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "GuestRequestReport_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "GuestRequestReport_assigneeUserId_acceptedAt_idx" ON "GuestRequestReport"("assigneeUserId", "acceptedAt");
CREATE INDEX "GuestRequestReport_receivingDepartment_idx" ON "GuestRequestReport"("receivingDepartment");
CREATE INDEX "GuestRequestReport_completedDepartment_idx" ON "GuestRequestReport"("completedDepartment");

-- AlterTable: who gave a work group out ("Được giao"); null = taken by the
-- housekeeper itself ("Tự nhận") or not given out.
ALTER TABLE "HousekeepingWorkGroup"
  ADD COLUMN "assignedByUserId" INTEGER,
  ADD COLUMN "assignedByNameSnapshot" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3);

ALTER TABLE "HousekeepingWorkGroup"
  ADD CONSTRAINT "HousekeepingWorkGroup_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: how the workday ended — null: "Kết thúc ca" by the person (and
-- every workday before this column), NO_WORK / CUTOFF_20H: ended by the server.
ALTER TABLE "HousekeepingWorkSession" ADD COLUMN "endReason" TEXT;
