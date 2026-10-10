-- "Quản lý buồng phòng" and the daily room work: the role, one work item per
-- room per day (operational code, priority, note, assignee, cleaning state and
-- timing, the "Dọn phòng" form) and its event history.
--
-- ADDITIVE ONLY: one enum value on UserRole, two new enums, two new tables,
-- indexes and keys. No existing row is touched; inspections, findings and
-- collections keep their shape — the KPI reads them through existing relations.

-- CreateEnum
CREATE TYPE "RoomWorkState" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "RoomTaskEventType" AS ENUM ('CREATED', 'UPDATED', 'ASSIGNED', 'OPENED', 'INSPECTED', 'CLEANING_SAVED', 'COMPLETED', 'VOIDED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'HOUSEKEEPING_MANAGER';

-- CreateTable
CREATE TABLE "HousekeepingRoomTask" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "workDate" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "assigneeUserId" INTEGER,
    "assigneeNameSnapshot" TEXT,
    "state" "RoomWorkState" NOT NULL DEFAULT 'NOT_STARTED',
    "inspectionId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "cleaning" JSONB,
    "cleanedByUserId" INTEGER,
    "cleanedByNameSnapshot" TEXT,
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" INTEGER,
    "voidedByNameSnapshot" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "HousekeepingRoomTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingRoomTaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "type" "RoomTaskEventType" NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HousekeepingRoomTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HousekeepingRoomTask_inspectionId_key" ON "HousekeepingRoomTask"("inspectionId");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTask_branchId_workDate_idx" ON "HousekeepingRoomTask"("branchId", "workDate");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTask_assigneeUserId_workDate_idx" ON "HousekeepingRoomTask"("assigneeUserId", "workDate");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTask_workDate_idx" ON "HousekeepingRoomTask"("workDate");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTaskEvent_taskId_createdAt_idx" ON "HousekeepingRoomTaskEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "HousekeepingRoomTaskEvent_actorUserId_createdAt_idx" ON "HousekeepingRoomTaskEvent"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "RoomInspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_cleanedByUserId_fkey" FOREIGN KEY ("cleanedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTask" ADD CONSTRAINT "HousekeepingRoomTask_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTaskEvent" ADD CONSTRAINT "HousekeepingRoomTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HousekeepingRoomTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingRoomTaskEvent" ADD CONSTRAINT "HousekeepingRoomTaskEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One LIVE work item per branch, business date and room; a voided one stays as history.
CREATE UNIQUE INDEX "HousekeepingRoomTask_one_live_per_room_day"
  ON "HousekeepingRoomTask" ("branchId", "workDate", "roomNumber")
  WHERE "voidedAt" IS NULL;
