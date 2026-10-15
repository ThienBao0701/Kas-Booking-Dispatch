-- Reception shift sessions, server-derived order creators, and the Hotel
-- Technical Department incident lifecycle.
--
-- This migration does three separable things. Nothing here rewrites a historical
-- row's meaning; every new column is nullable and every rename preserves data.
--
-- ---------------------------------------------------------------------------
-- 1. A FOURTH ROLE
--
-- TECHNICAL is added to "UserRole" the same way BOOKING_DEPARTMENT was
-- (20260808120000_add_charge_documents). The new label is not USED anywhere in
-- this migration, which matters: PostgreSQL forbids using a value added by
-- ALTER TYPE ... ADD VALUE inside the same transaction that added it.
--
-- ---------------------------------------------------------------------------
-- 2. RESOLVED BECOMES COMPLETED — A RENAME, NOT A REPLACEMENT
--
-- ALTER TYPE ... RENAME VALUE rewrites the enum label in the catalogue and
-- leaves every stored row physically untouched: no table rewrite, no UPDATE, no
-- window in which a row holds a value the type does not know. The alternative —
-- add COMPLETED, UPDATE every row, drop RESOLVED — cannot drop a value at all in
-- PostgreSQL, and would have left a dead label behind forever.
--
-- The columns are renamed to match, so `completedAt` cannot be misread as the
-- older, weaker "resolved" notion. RENAME COLUMN keeps the data and the
-- constraint; only the identifier changes.
--
-- ---------------------------------------------------------------------------
-- 3. STRUCTURED INCIDENT LOCATION, AND WHY EVERYTHING IS NULLABLE
--
-- Incidents created before this migration were asked only for a category, a
-- free-form room number and a description. They were never asked WHERE. So
-- `areaCategory` is left NULL on them rather than defaulted to ROOM: a default
-- would assert something nobody ever recorded. `category` becomes nullable for
-- the opposite reason — a hallway report is a place plus a description, and the
-- new form does not ask a receptionist to classify it.
--
-- ---------------------------------------------------------------------------
-- 4. ONE OPEN SHIFT PER RECEPTIONIST IS A DATABASE RULE
--
-- `ReceptionShiftSession_one_open_per_user` is a partial unique index, the same
-- device `Booking_one_operational_per_code_branch_checkin` uses. Two browser
-- tabs pressing "check in" at the same instant both pass any application-level
-- SELECT; only one of them can land the INSERT. It is not expressible in the
-- Prisma schema and so is created here, and the schema says so.

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'TECHNICAL';

-- AlterEnum: rename in place. Every existing HotelIssue row keeps its identity.
ALTER TYPE "IssueStatus" RENAME VALUE 'RESOLVED' TO 'COMPLETED';

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('A', 'B', 'C', 'A4', 'C4');

-- CreateEnum
CREATE TYPE "IssueAreaCategory" AS ENUM ('ROOM', 'LOBBY', 'HALLWAY', 'STAIRCASE', 'RESTAURANT', 'ROOFTOP', 'OTHER_AREA');

-- CreateEnum
CREATE TYPE "IssueAreaSubtype" AS ENUM ('RECEPTION_DESK', 'SOFA', 'FLOOR', 'CEILING', 'LIGHT_BULB', 'CLOCK', 'OTHER');

-- AlterTable: the fault type is no longer always asked for.
ALTER TABLE "HotelIssue" ALTER COLUMN "category" DROP NOT NULL;

-- AlterTable: rename the completion columns to match the renamed enum value.
ALTER TABLE "HotelIssue" RENAME COLUMN "resolvedAt" TO "completedAt";
ALTER TABLE "HotelIssue" RENAME COLUMN "resolvedByUserId" TO "completedByUserId";
ALTER TABLE "HotelIssue" RENAME CONSTRAINT "HotelIssue_resolvedByUserId_fkey" TO "HotelIssue_completedByUserId_fkey";

-- AlterTable: structured location, technician identity and name snapshots.
ALTER TABLE "HotelIssue" ADD COLUMN     "areaCategory" "IssueAreaCategory",
ADD COLUMN     "floorNumber" TEXT,
ADD COLUMN     "areaSubtype" "IssueAreaSubtype",
ADD COLUMN     "locationDetail" TEXT,
ADD COLUMN     "reportedByNameSnapshot" TEXT,
ADD COLUMN     "acceptedByNameSnapshot" TEXT,
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "technicianName" TEXT,
ADD COLUMN     "technicianPhone" TEXT,
ADD COLUMN     "completedByNameSnapshot" TEXT;

-- AlterTable: who created the order, resolved by the server from the open shift.
ALTER TABLE "BookingCreationProof" ADD COLUMN     "shiftSessionId" TEXT,
ADD COLUMN     "receptionistNameSnapshot" TEXT,
ADD COLUMN     "shiftType" "ShiftType";

-- CreateTable
CREATE TABLE "ReceptionShiftSession" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "shiftType" "ShiftType" NOT NULL,
    "receptionistName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "nominalEndAt" TIMESTAMP(3) NOT NULL,
    "graceEndAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionShiftSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionShiftSession_userId_closedAt_idx" ON "ReceptionShiftSession"("userId", "closedAt");

-- CreateIndex
CREATE INDEX "ReceptionShiftSession_branchId_startedAt_idx" ON "ReceptionShiftSession"("branchId", "startedAt");

-- CreateIndex
CREATE INDEX "ReceptionShiftSession_startedAt_idx" ON "ReceptionShiftSession"("startedAt");

-- CreateIndex
CREATE INDEX "ReceptionShiftSession_shiftType_idx" ON "ReceptionShiftSession"("shiftType");

-- CreateIndex: the concurrency authority. A receptionist has at most ONE open
-- session; a closed one is out of the index, so their history is unbounded.
CREATE UNIQUE INDEX "ReceptionShiftSession_one_open_per_user"
  ON "ReceptionShiftSession"("userId")
  WHERE "closedAt" IS NULL;

-- CreateIndex
CREATE INDEX "HotelIssue_status_createdAt_idx" ON "HotelIssue"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssue_branchId_createdAt_idx" ON "HotelIssue"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssue_areaCategory_idx" ON "HotelIssue"("areaCategory");

-- CreateIndex
CREATE INDEX "HotelIssue_completedAt_idx" ON "HotelIssue"("completedAt");

-- CreateIndex
CREATE INDEX "BookingCreationProof_status_reviewedAt_idx" ON "BookingCreationProof"("status", "reviewedAt");

-- CreateIndex
CREATE INDEX "BookingCreationProof_shiftSessionId_idx" ON "BookingCreationProof"("shiftSessionId");

-- CreateIndex
CREATE INDEX "BookingCreationProof_submittedByUserId_idx" ON "BookingCreationProof"("submittedByUserId");

-- AddForeignKey
ALTER TABLE "ReceptionShiftSession" ADD CONSTRAINT "ReceptionShiftSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionShiftSession" ADD CONSTRAINT "ReceptionShiftSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreationProof" ADD CONSTRAINT "BookingCreationProof_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
