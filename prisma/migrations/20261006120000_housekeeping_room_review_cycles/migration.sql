-- HOUSEKEEPING QUALITY REVIEW AND CLEANING CYCLES.
--
-- A room task row is ONE cleaning cycle. After "Hoàn thành" the manager reviews
-- it once — "Đạt" (released back to "Thêm phòng vào bảng") or "Không đạt" with a
-- reason, optionally "Yêu cầu dọn lại", which opens the NEXT cycle as a new row
-- linked to the failed one. No cycle, review or reason is ever rewritten.
--
-- Additive: one enum, one enum value, nullable/defaulted columns, indexes,
-- foreign keys and checks. The one index replaced is the open-room guard: it
-- allowed one non-voided task per room and day; it now allows one OPEN task
-- (not voided, not yet reviewed), so a room can be cleaned again the same day.
-- No table, column or row is dropped; existing rows keep every value.

-- CreateEnum
CREATE TYPE "RoomReviewResult" AS ENUM ('PASSED', 'FAILED');

-- AlterEnum
ALTER TYPE "RoomTaskEventType" ADD VALUE 'REVIEWED';

-- AlterTable
ALTER TABLE "HousekeepingRoomTask" ADD COLUMN     "cycleNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "previousTaskId" TEXT,
ADD COLUMN     "recleanRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewResult" "RoomReviewResult",
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByNameSnapshot" TEXT,
ADD COLUMN     "reviewedByUserId" INTEGER;

-- Existing rows: a room that already had more than one task that day (a voided
-- one and its replacement) numbers them in creation order — the new column only.
UPDATE "HousekeepingRoomTask" AS t
SET "cycleNumber" = n.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "branchId", "workDate", "roomNumber" ORDER BY "createdAt", "id") AS rn
  FROM "HousekeepingRoomTask"
) AS n
WHERE n."id" = t."id" AND n.rn <> 1;

-- CreateIndex
CREATE UNIQUE INDEX "HousekeepingRoomTask_previousTaskId_key" ON "HousekeepingRoomTask"("previousTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "HousekeepingRoomTask_branchId_workDate_roomNumber_cycleNumb_key" ON "HousekeepingRoomTask"("branchId", "workDate", "roomNumber", "cycleNumber");

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_previousTaskId_fkey" FOREIGN KEY ("previousTaskId") REFERENCES "HousekeepingRoomTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One OPEN task per room and business day (replaces "one live task"): a cycle
-- stops holding the room once it is voided or reviewed. Index only — no data.
DROP INDEX "HousekeepingRoomTask_one_live_per_room_day";
CREATE UNIQUE INDEX "HousekeepingRoomTask_one_open_per_room_day"
  ON "HousekeepingRoomTask" ("branchId", "workDate", "roomNumber")
  WHERE "voidedAt" IS NULL AND "reviewResult" IS NULL;

-- A review is given to a finished cycle only, and "Không đạt" always has its reason.
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_review_after_completion"
  CHECK ("reviewResult" IS NULL OR "state" = 'COMPLETED');
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_failed_has_reason"
  CHECK ("reviewResult" IS DISTINCT FROM 'FAILED' OR ("failureReason" IS NOT NULL AND btrim("failureReason") <> ''));
