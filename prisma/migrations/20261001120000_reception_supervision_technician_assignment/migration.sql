-- RECEPTION SUPERVISION ROLES, TECHNICIAN ASSIGNMENT, CREATOR ROLE — additive only.
--
-- Nothing here drops, renames or rewrites a row:
--   * two new roles ("Quản lý lễ tân", "Tổng quản lý lễ tân");
--   * UserBranchAssignment — which branches a Quản lý lễ tân supervises;
--   * HotelIssue: the current technician assignment, the reporter's role and a
--     likely-repeat link — all nullable, so every existing incident is unchanged
--     (unassigned, legacy reporter, no repeat link);
--   * HotelIssueAssignment — the append-only assignment history;
--   * ReceptionOperationalReport.createdByRole — null on every existing row,
--     which were all written by a receptionist on shift.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'RECEPTION_MANAGER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'RECEPTION_GENERAL_MANAGER';

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedByNameSnapshot" TEXT,
ADD COLUMN     "assignedByUserId" INTEGER,
ADD COLUMN     "assignedTechnicianNameSnapshot" TEXT,
ADD COLUMN     "assignedTechnicianUserId" INTEGER,
ADD COLUMN     "repeatOfIssueId" TEXT,
ADD COLUMN     "reportedByRole" "UserRole";

-- AlterTable
ALTER TABLE "ReceptionOperationalReport" ADD COLUMN     "createdByRole" "UserRole";

-- CreateTable
CREATE TABLE "UserBranchAssignment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBranchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelIssueAssignment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "technicianUserId" INTEGER NOT NULL,
    "technicianNameSnapshot" TEXT NOT NULL,
    "previousTechnicianUserId" INTEGER,
    "previousTechnicianNameSnapshot" TEXT,
    "assignedByUserId" INTEGER NOT NULL,
    "assignedByNameSnapshot" TEXT NOT NULL,
    "assignedByRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelIssueAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBranchAssignment_branchId_idx" ON "UserBranchAssignment"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBranchAssignment_userId_branchId_key" ON "UserBranchAssignment"("userId", "branchId");

-- CreateIndex
CREATE INDEX "HotelIssueAssignment_issueId_createdAt_idx" ON "HotelIssueAssignment"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueAssignment_technicianUserId_createdAt_idx" ON "HotelIssueAssignment"("technicianUserId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueAssignment_previousTechnicianUserId_idx" ON "HotelIssueAssignment"("previousTechnicianUserId");

-- CreateIndex
CREATE INDEX "HotelIssue_assignedTechnicianUserId_status_idx" ON "HotelIssue"("assignedTechnicianUserId", "status");

-- CreateIndex
CREATE INDEX "HotelIssue_branchId_roomNumber_idx" ON "HotelIssue"("branchId", "roomNumber");

-- AddForeignKey
ALTER TABLE "UserBranchAssignment" ADD CONSTRAINT "UserBranchAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBranchAssignment" ADD CONSTRAINT "UserBranchAssignment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_assignedTechnicianUserId_fkey" FOREIGN KEY ("assignedTechnicianUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_repeatOfIssueId_fkey" FOREIGN KEY ("repeatOfIssueId") REFERENCES "HotelIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueAssignment" ADD CONSTRAINT "HotelIssueAssignment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueAssignment" ADD CONSTRAINT "HotelIssueAssignment_technicianUserId_fkey" FOREIGN KEY ("technicianUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueAssignment" ADD CONSTRAINT "HotelIssueAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
