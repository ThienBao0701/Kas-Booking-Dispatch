-- Housekeeping WORK GROUPS ("Công việc 1, 2, …"), per-room task types, Rooftop,
-- and "Không cần dọn" with the manager's decision.
--
-- Additive and forward-only. Nothing is dropped, renamed or rewritten:
--   * every existing room task keeps workGroupId NULL (shown and worked on its
--     own, exactly as before), taskCodes '{}' (its one code stays in
--     statusCode) and no "Không cần dọn" request;
--   * the new table starts empty; group numbers are per branch and business
--     day, unique, and never reused;
--   * enum values are only added, and nothing in this migration uses them.

-- CreateEnum
CREATE TYPE "HousekeepingNoCleanStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum


ALTER TYPE "RoomTaskEventType" ADD VALUE 'NO_CLEAN_REQUESTED';
ALTER TYPE "RoomTaskEventType" ADD VALUE 'NO_CLEAN_APPROVED';
ALTER TYPE "RoomTaskEventType" ADD VALUE 'NO_CLEAN_REJECTED';

-- AlterEnum
ALTER TYPE "HousekeepingAreaKind" ADD VALUE 'ROOFTOP';

-- AlterTable
ALTER TABLE "HousekeepingRoomTask" ADD COLUMN     "noCleanDecidedAt" TIMESTAMP(3),
ADD COLUMN     "noCleanDecidedByNameSnapshot" TEXT,
ADD COLUMN     "noCleanDecidedByUserId" INTEGER,
ADD COLUMN     "noCleanDecisionNote" TEXT,
ADD COLUMN     "noCleanReason" TEXT,
ADD COLUMN     "noCleanRequestedAt" TIMESTAMP(3),
ADD COLUMN     "noCleanRequestedByNameSnapshot" TEXT,
ADD COLUMN     "noCleanRequestedByUserId" INTEGER,
ADD COLUMN     "noCleanStatus" "HousekeepingNoCleanStatus",
ADD COLUMN     "taskCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "workGroupId" TEXT;

-- CreateTable
CREATE TABLE "HousekeepingWorkGroup" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "workDate" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT,
    "requestId" TEXT,
    "assigneeUserId" INTEGER,
    "assigneeNameSnapshot" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HousekeepingWorkGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HousekeepingWorkGroup_requestId_key" ON "HousekeepingWorkGroup"("requestId");

-- CreateIndex
CREATE INDEX "HousekeepingWorkGroup_branchId_workDate_idx" ON "HousekeepingWorkGroup"("branchId", "workDate");

-- CreateIndex
CREATE INDEX "HousekeepingWorkGroup_assigneeUserId_workDate_idx" ON "HousekeepingWorkGroup"("assigneeUserId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "HousekeepingWorkGroup_branchId_workDate_number_key" ON "HousekeepingWorkGroup"("branchId", "workDate", "number");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTask_workGroupId_idx" ON "HousekeepingRoomTask"("workGroupId");

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_workGroupId_fkey" FOREIGN KEY ("workGroupId") REFERENCES "HousekeepingWorkGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkGroup" ADD CONSTRAINT "HousekeepingWorkGroup_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkGroup" ADD CONSTRAINT "HousekeepingWorkGroup_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkGroup" ADD CONSTRAINT "HousekeepingWorkGroup_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

