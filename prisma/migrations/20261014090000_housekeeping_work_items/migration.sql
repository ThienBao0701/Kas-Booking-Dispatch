-- Housekeeping WORK ITEMS ("Tạo công việc"): several independent items for one
-- room or shared area on the same day, each accepted ("Nhận"), inspected and
-- cleaned on its own.
--
-- Additive and forward-only. No existing row is rewritten: every room task on
-- file keeps itemKey '' and areaKind ROOM, which is exactly its meaning today
-- (one item per room per cycle), so the new unique key — which adds itemKey —
-- admits every existing row and still allows only one legacy item per room and
-- cycle. Nothing active is completed, assigned or re-dated; the new timestamps
-- stay null on older rows (screens fall back to the records they already have).

-- CreateEnum
CREATE TYPE "HousekeepingAreaKind" AS ENUM ('ROOM', 'HALLWAY', 'STAIRCASE', 'OTHER');

-- AlterEnum
ALTER TYPE "RoomTaskEventType" ADD VALUE 'ACCEPTED';
ALTER TYPE "RoomTaskEventType" ADD VALUE 'INSPECTION_STARTED';
ALTER TYPE "RoomTaskEventType" ADD VALUE 'CLAIM_REJECTED';

-- AlterTable
ALTER TABLE "HousekeepingRoomTask" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "areaKind" "HousekeepingAreaKind" NOT NULL DEFAULT 'ROOM',
ADD COLUMN     "floor" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupIndex" INTEGER,
ADD COLUMN     "inspectedAt" TIMESTAMP(3),
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "inspectionStartedAt" TIMESTAMP(3),
ADD COLUMN     "itemKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "taskName" TEXT;

-- The one-item-per-room key becomes one-row-per-item-cycle. Created before the
-- old index is dropped, so the table is never without a uniqueness guard.
CREATE UNIQUE INDEX "HousekeepingRoomTask_branchId_workDate_roomNumber_itemKey_c_key" ON "HousekeepingRoomTask"("branchId", "workDate", "roomNumber", "itemKey", "cycleNumber");

DROP INDEX "HousekeepingRoomTask_branchId_workDate_roomNumber_cycleNumb_key";

-- A repeated "Tạo công việc" submission cannot create its items twice.
CREATE UNIQUE INDEX "HousekeepingRoomTask_groupId_groupIndex_key" ON "HousekeepingRoomTask"("groupId", "groupIndex");
