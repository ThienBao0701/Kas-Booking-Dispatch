-- TECHNICAL REPAIR STAGES, HOUSEKEEPING SHIFTS — additive only.
--
-- Nothing here drops, renames or rewrites a row:
--   * TechnicalRepairStage — a repair recorded stage by stage ("Giai đoạn"),
--     numbered per incident; existing incidents simply have no stages yet;
--   * HousekeepingWorkSession / HousekeepingWorkSegment — "Vào ca", "Đổi chi
--     nhánh", "Kết thúc ca": where a housekeeping account works, and when;
--   * RoomInspection.workSegmentId — nullable; null on every existing inspection.

-- AlterTable
ALTER TABLE "RoomInspection" ADD COLUMN     "workSegmentId" TEXT;

-- CreateTable
CREATE TABLE "TechnicalRepairStage" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "stageNumber" INTEGER NOT NULL,
    "technicianUserId" INTEGER,
    "technicianNameSnapshot" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "workDone" TEXT NOT NULL,
    "nextWork" TEXT,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalRepairStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingWorkSession" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "HousekeepingWorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HousekeepingWorkSegment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "staffName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "HousekeepingWorkSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechnicalRepairStage_technicianUserId_idx" ON "TechnicalRepairStage"("technicianUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalRepairStage_issueId_stageNumber_key" ON "TechnicalRepairStage"("issueId", "stageNumber");

-- CreateIndex
CREATE INDEX "HousekeepingWorkSession_userId_endedAt_idx" ON "HousekeepingWorkSession"("userId", "endedAt");

-- CreateIndex
CREATE INDEX "HousekeepingWorkSession_startedAt_idx" ON "HousekeepingWorkSession"("startedAt");

-- CreateIndex
CREATE INDEX "HousekeepingWorkSegment_sessionId_startedAt_idx" ON "HousekeepingWorkSegment"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "HousekeepingWorkSegment_branchId_startedAt_idx" ON "HousekeepingWorkSegment"("branchId", "startedAt");

-- CreateIndex
CREATE INDEX "RoomInspection_workSegmentId_idx" ON "RoomInspection"("workSegmentId");

-- AddForeignKey
ALTER TABLE "TechnicalRepairStage" ADD CONSTRAINT "TechnicalRepairStage_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalRepairStage" ADD CONSTRAINT "TechnicalRepairStage_technicianUserId_fkey" FOREIGN KEY ("technicianUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspection" ADD CONSTRAINT "RoomInspection_workSegmentId_fkey" FOREIGN KEY ("workSegmentId") REFERENCES "HousekeepingWorkSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkSession" ADD CONSTRAINT "HousekeepingWorkSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkSegment" ADD CONSTRAINT "HousekeepingWorkSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HousekeepingWorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingWorkSegment" ADD CONSTRAINT "HousekeepingWorkSegment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One open workday per housekeeping account, and one open branch segment per
-- workday: a second "Vào ca" or a racing "Đổi chi nhánh" fails cleanly.
CREATE UNIQUE INDEX "HousekeepingWorkSession_one_open_per_user" ON "HousekeepingWorkSession"("userId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "HousekeepingWorkSegment_one_open_per_session" ON "HousekeepingWorkSegment"("sessionId") WHERE "endedAt" IS NULL;
