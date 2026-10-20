-- ADDITIVE ONLY.
--
--   * "Chưa dọn — chuyển người khác dọn": a new history event type (RELEASED).
--   * The journal record's department (originDepartment). Every existing row is
--     Reception's, which is what the default gives it; nothing else changes.

-- AlterEnum
ALTER TYPE "RoomTaskEventType" ADD VALUE 'RELEASED';

-- CreateEnum
CREATE TYPE "ReportDepartment" AS ENUM ('RECEPTION', 'HOUSEKEEPING');

-- AlterTable
ALTER TABLE "ReceptionOperationalReport" ADD COLUMN     "originDepartment" "ReportDepartment" NOT NULL DEFAULT 'RECEPTION';

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_originDepartment_branchId_create_idx" ON "ReceptionOperationalReport"("originDepartment", "branchId", "createdAt");
