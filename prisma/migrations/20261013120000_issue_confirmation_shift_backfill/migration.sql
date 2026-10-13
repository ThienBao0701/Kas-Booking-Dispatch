-- Two additive changes, nothing dropped, renamed or rewritten:
--
--   * "Xác nhận hoàn thành" for facility incidents: who confirmed a finished
--     repair, in what role, and when. Null on every existing incident — those
--     were closed before the confirmation step existed, and no confirmer is
--     invented for them.
--   * "Thêm ca" for "Nhập bù báo cáo": a shift the receptionist worked but never
--     checked in to, added afterwards, with who added it, when and why, and a
--     unique key so the same missing shift cannot be added twice. Null on every
--     session opened by a real check-in; SHIFT_BACKFILL is its audit action.

-- AlterEnum
ALTER TYPE "ReceptionReportAuditAction" ADD VALUE 'SHIFT_BACKFILL';

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "completionConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "completionConfirmedByNameSnapshot" TEXT,
ADD COLUMN     "completionConfirmedByRole" "UserRole",
ADD COLUMN     "completionConfirmedByUserId" INTEGER;

-- AlterTable
ALTER TABLE "ReceptionShiftSession" ADD COLUMN     "backfillKey" TEXT,
ADD COLUMN     "backfillReason" TEXT,
ADD COLUMN     "backfilledAt" TIMESTAMP(3),
ADD COLUMN     "backfilledByNameSnapshot" TEXT,
ADD COLUMN     "backfilledByRole" "UserRole",
ADD COLUMN     "backfilledByUserId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionShiftSession_backfillKey_key" ON "ReceptionShiftSession"("backfillKey");

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_completionConfirmedByUserId_fkey" FOREIGN KEY ("completionConfirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionShiftSession" ADD CONSTRAINT "ReceptionShiftSession_backfilledByUserId_fkey" FOREIGN KEY ("backfilledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
