-- FACILITY ISSUE LIFECYCLE V2: cause, repair result and "nghiệm thu".
--
-- ADDITIVE ONLY. Two enum values, one new enum, nullable columns, two indexes
-- and one foreign key. No row is rewritten and nothing is backfilled:
--
--   * Incidents completed before inspection existed stay COMPLETED with NO
--     inspection record. Their inspection reads "Chưa có dữ liệu" — an
--     inspection nobody performed is never invented.
--   * Earlier attempts keep exactly what they recorded; their new cause,
--     result and inspection columns are simply null.
--
-- HotelIssue."cause"                  "Nguyên nhân" as REPORTED (optional).
-- TechnicalRepairAttempt."cause"      the technician's determination, per attempt.
-- TechnicalRepairAttempt."result"     "Kết quả sửa chữa", per attempt.
-- TechnicalRepairAttempt.inspection*  the Technical Manager's verdict on that
--                                     attempt: result, who, when (server time),
--                                     and a note (required when it failed).
--
-- PostgreSQL allows ALTER TYPE ... ADD VALUE inside a transaction block (12+),
-- as long as the new value is not used in the same transaction — and nothing
-- here uses it.

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASSED', 'FAILED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TECHNICAL_MANAGER';

-- AlterEnum
ALTER TYPE "IssueStatus" ADD VALUE IF NOT EXISTS 'AWAITING_INSPECTION';

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "cause" TEXT;

-- AlterTable
ALTER TABLE "TechnicalRepairAttempt" ADD COLUMN     "cause" TEXT,
ADD COLUMN     "inspectedAt" TIMESTAMP(3),
ADD COLUMN     "inspectedByNameSnapshot" TEXT,
ADD COLUMN     "inspectedByUserId" INTEGER,
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "inspectionResult" "InspectionResult",
ADD COLUMN     "result" TEXT;

-- CreateIndex
CREATE INDEX "TechnicalRepairAttempt_inspectedByUserId_idx" ON "TechnicalRepairAttempt"("inspectedByUserId");

-- CreateIndex
CREATE INDEX "TechnicalRepairAttempt_inspectionResult_inspectedAt_idx" ON "TechnicalRepairAttempt"("inspectionResult", "inspectedAt");

-- AddForeignKey
ALTER TABLE "TechnicalRepairAttempt" ADD CONSTRAINT "TechnicalRepairAttempt_inspectedByUserId_fkey" FOREIGN KEY ("inspectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
