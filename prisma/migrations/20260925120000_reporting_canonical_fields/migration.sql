-- RECEPTION REPORTING: the canonical entry fields.
--
-- ADDITIVE ONLY. New nullable columns, two NOT NULLs relaxed, three indexes and
-- two foreign keys. No column is dropped or renamed, no existing row is
-- rewritten, and nothing is backfilled: older reports keep exactly what they
-- say, and every new column is null on them.
--
-- GuestRequestReport
--   "ezCode"      Mã EZ, asked for on every new request.
--   "itemType"    Ký gửi is no longer asked for, so new requests leave it null.
--
-- CustomerComplaintReport
--   "ezCode"      Mã EZ.
--   "location"    Số phòng / Khác is no longer asked for.
--   completion    "Đã tiếp nhận" → "Đã hoàn thành", the same event shape a guest
--                 request has: who, when (server time), on which shift, and an
--                 optional "Hướng xử lý".
--
-- RoomServiceReport
--   "ezCode"      Mã EZ, on every subtype.
--   "nights"      Số đêm, on "Bán phòng" and "Upgrade". Validated (>= 1) by the
--                 service, like every other rule on this table.

-- AlterTable
ALTER TABLE "GuestRequestReport" ADD COLUMN     "ezCode" TEXT,
ALTER COLUMN "itemType" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CustomerComplaintReport" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedByNameSnapshot" TEXT,
ADD COLUMN     "completedByUserId" INTEGER,
ADD COLUMN     "completedShiftSessionId" TEXT,
ADD COLUMN     "completedShiftType" "ShiftType",
ADD COLUMN     "ezCode" TEXT,
ADD COLUMN     "resolution" TEXT,
ALTER COLUMN "location" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RoomServiceReport" ADD COLUMN     "ezCode" TEXT,
ADD COLUMN     "nights" INTEGER;

-- CreateIndex
CREATE INDEX "CustomerComplaintReport_completedAt_idx" ON "CustomerComplaintReport"("completedAt");

-- CreateIndex
CREATE INDEX "CustomerComplaintReport_completedByUserId_idx" ON "CustomerComplaintReport"("completedByUserId");

-- CreateIndex
CREATE INDEX "CustomerComplaintReport_completedShiftSessionId_idx" ON "CustomerComplaintReport"("completedShiftSessionId");

-- AddForeignKey
ALTER TABLE "CustomerComplaintReport" ADD CONSTRAINT "CustomerComplaintReport_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerComplaintReport" ADD CONSTRAINT "CustomerComplaintReport_completedShiftSessionId_fkey" FOREIGN KEY ("completedShiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
