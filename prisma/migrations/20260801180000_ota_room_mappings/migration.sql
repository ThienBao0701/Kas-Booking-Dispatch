-- ===========================================================================
-- KAS — per-platform OTA room mappings
--
-- ADDITIVE ONLY. One new enum type and two new tables. Nothing existing is
-- altered: `BranchRoomClass`, `BranchRoomClassAlias` and the versioned
-- `BranchRoomMappingVersion` catalogue keep every row, column and index, and
-- no booking's immutable room-class snapshot is touched.
--
-- WHY A SEPARATE TABLE FROM BranchRoomClass:
-- the catalogue answers "which room classes does this branch have, and what is
-- each one's PMS code?". This answers a different question — "when Agoda calls
-- a room «Phòng Queen Superior Có Cửa Sổ», which of THIS branch's PMS codes is
-- that?". The same physical class is named differently by each OTA, and the
-- same OTA name means different classes at different branches.
--
-- WHY AGODA AND CTRIP GET INDEPENDENT ROWS:
-- their room names are identical today, which makes a shared row tempting. But
-- sharing one would mean renaming a room on Agoda silently changed what a CTrip
-- booking resolves to. The unique key includes the platform, so the two can
-- never collapse into one another.
--
-- NO DATA IS WRITTEN HERE. Populating the mappings is a separate idempotent
-- seed, so the operator-confirmed table is observable, re-runnable and testable
-- rather than buried in DDL.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "OtaRoomMappingAction" AS ENUM ('MAPPING_CREATED', 'MAPPING_UPDATED', 'MAPPING_DELETED');

-- CreateTable
CREATE TABLE "BranchOtaRoomMapping" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "platform" "OtaPlatform" NOT NULL,
    "otaRoomName" TEXT NOT NULL,
    "normalizedOtaRoomName" TEXT NOT NULL,
    "otaRoomTypeId" TEXT,
    "pmsCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" INTEGER,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOtaRoomMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchOtaRoomMappingEvent" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "platform" "OtaPlatform" NOT NULL,
    "action" "OtaRoomMappingAction" NOT NULL,
    "otaRoomName" TEXT NOT NULL,
    "oldPmsCode" TEXT,
    "newPmsCode" TEXT,
    "reason" TEXT,
    "actorUserId" INTEGER,
    "actorRole" "UserRole",
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchOtaRoomMappingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One CURRENT mapping per OTA room name, per platform, per branch. Enforced by
-- the database because two concurrent writers can interleave an application
-- check-then-write under READ COMMITTED.
CREATE UNIQUE INDEX "BranchOtaRoomMapping_branchId_platform_normalizedOtaRoomName_key" ON "BranchOtaRoomMapping"("branchId", "platform", "normalizedOtaRoomName");

-- CreateIndex
CREATE INDEX "BranchOtaRoomMapping_branchId_platform_idx" ON "BranchOtaRoomMapping"("branchId", "platform");

-- CreateIndex
CREATE INDEX "BranchOtaRoomMapping_platform_normalizedOtaRoomName_idx" ON "BranchOtaRoomMapping"("platform", "normalizedOtaRoomName");

-- CreateIndex
CREATE INDEX "BranchOtaRoomMappingEvent_branchId_createdAt_idx" ON "BranchOtaRoomMappingEvent"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "BranchOtaRoomMappingEvent_platform_createdAt_idx" ON "BranchOtaRoomMappingEvent"("platform", "createdAt");

-- AddForeignKey
ALTER TABLE "BranchOtaRoomMapping" ADD CONSTRAINT "BranchOtaRoomMapping_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOtaRoomMappingEvent" ADD CONSTRAINT "BranchOtaRoomMappingEvent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOtaRoomMappingEvent" ADD CONSTRAINT "BranchOtaRoomMappingEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
