-- "Hoàn thành vấn đề" — Đúng / Sai, and "Xóa" / "Chuyển về chờ giao kỹ thuật" for incidents.
--
-- ADDITIVE ONLY. One enum, nullable columns and indexes; every existing row keeps
-- its values (a NULL verdict reads as "Đúng" — completed before the question
-- existed). A deleted incident is VOIDED like a journal entry, never removed:
-- its attempts, assignments, stages and edits stay. Nothing here drops, renames
-- or rewrites a row.

-- CreateEnum
CREATE TYPE "ReportVerdict" AS ENUM ('CORRECT', 'INCORRECT');

-- AlterTable
ALTER TABLE "CustomerComplaintReport" ADD COLUMN     "incorrectReason" TEXT,
ADD COLUMN     "reportVerdict" "ReportVerdict";

-- AlterTable
ALTER TABLE "GuestRequestReport" ADD COLUMN     "incorrectReason" TEXT,
ADD COLUMN     "reportVerdict" "ReportVerdict";

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "incorrectReason" TEXT,
ADD COLUMN     "reportVerdict" "ReportVerdict",
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedByNameSnapshot" TEXT,
ADD COLUMN     "voidedByUserId" INTEGER;

-- AlterTable
ALTER TABLE "HotelIssueAssignment" ADD COLUMN     "returnedAt" TIMESTAMP(3),
ADD COLUMN     "returnedByNameSnapshot" TEXT,
ADD COLUMN     "returnedByUserId" INTEGER;

-- CreateIndex
CREATE INDEX "HotelIssue_voidedAt_idx" ON "HotelIssue"("voidedAt");

-- CreateIndex
CREATE INDEX "HotelIssue_reportVerdict_idx" ON "HotelIssue"("reportVerdict");

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueAssignment" ADD CONSTRAINT "HotelIssueAssignment_returnedByUserId_fkey" FOREIGN KEY ("returnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

