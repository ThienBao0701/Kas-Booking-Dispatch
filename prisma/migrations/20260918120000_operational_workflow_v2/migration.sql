-- KAS OPERATIONAL WORKFLOW V2
--
-- Five connected changes, one migration. Every statement here is ADDITIVE or a
-- relaxation: three new tables, new nullable columns on two existing ones, and
-- one NOT NULL dropped. Nothing is renamed, nothing is dropped, and no existing
-- row is rewritten — so every incident, conversation and shift already in the
-- database survives this untouched.
--
-- WHAT IS DELIBERATELY NOT HERE: A BACKFILL.
--
-- `TechnicalRepairAttempt` starts empty, including for incidents that are
-- already IN_PROGRESS or COMPLETED. Their acceptance and completion are recorded
-- on HotelIssue's own columns and the reports read them from there; manufacturing
-- attempt rows out of those columns would put invented history — an attempt
-- number nobody counted, an outcome nobody recorded — beside the real kind.
-- `ChatConversation.category` is left NULL on existing threads for the same
-- reason: their subject is free text, and classifying it now would be a guess
-- stored as a fact.
--
-- ORDER MATTERS in exactly one place: ShiftHandoverNote carries a foreign key to
-- ShiftHandover, so the tables are created before any constraint references them
-- (Prisma's generated layout already does this — tables first, then indexes,
-- then foreign keys).

-- CreateEnum
CREATE TYPE "RepairOutcome" AS ENUM ('COMPLETED', 'CANNOT_REPAIR');

-- CreateEnum
CREATE TYPE "ChatCategory" AS ENUM ('ROOM', 'WORK_ENVIRONMENT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "HandoverPriority" AS ENUM ('NORMAL', 'HIGH');

-- AlterTable
ALTER TABLE "ChatConversation" ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "anonymous" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "category" "ChatCategory",
ADD COLUMN     "handledAt" TIMESTAMP(3),
ADD COLUMN     "handledByUserId" INTEGER,
ADD COLUMN     "senderNameSnapshot" TEXT,
ADD COLUMN     "shiftSessionId" TEXT,
ADD COLUMN     "shiftType" "ShiftType",
ALTER COLUMN "subject" DROP NOT NULL;

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "shiftSessionId" TEXT,
ADD COLUMN     "shiftType" "ShiftType";

-- CreateTable
CREATE TABLE "ShiftHandover" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "outgoingShiftSessionId" TEXT NOT NULL,
    "incomingShiftSessionId" TEXT NOT NULL,
    "outgoingUserId" INTEGER NOT NULL,
    "outgoingNameSnapshot" TEXT NOT NULL,
    "outgoingShiftType" "ShiftType" NOT NULL,
    "incomingUserId" INTEGER,
    "incomingNameSnapshot" TEXT NOT NULL,
    "incomingShiftType" "ShiftType" NOT NULL,
    "actualHandoverAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalRepairAttempt" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "technicianUserId" INTEGER,
    "technicianNameSnapshot" TEXT NOT NULL,
    "technicianPhone" TEXT NOT NULL,
    "acceptedByNameSnapshot" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "RepairOutcome",
    "outcomeAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalRepairAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftHandoverNote" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "shiftSessionId" TEXT,
    "handoverId" TEXT,
    "outgoingUserId" INTEGER NOT NULL,
    "outgoingNameSnapshot" TEXT NOT NULL,
    "outgoingShiftType" "ShiftType" NOT NULL,
    "incomingNameSnapshot" TEXT,
    "incomingShiftType" "ShiftType",
    "content" TEXT NOT NULL,
    "priority" "HandoverPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftHandoverNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiftHandover_outgoingShiftSessionId_key" ON "ShiftHandover"("outgoingShiftSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftHandover_incomingShiftSessionId_key" ON "ShiftHandover"("incomingShiftSessionId");

-- CreateIndex
CREATE INDEX "ShiftHandover_branchId_actualHandoverAt_idx" ON "ShiftHandover"("branchId", "actualHandoverAt");

-- CreateIndex
CREATE INDEX "ShiftHandover_actualHandoverAt_idx" ON "ShiftHandover"("actualHandoverAt");

-- CreateIndex
CREATE INDEX "ShiftHandover_outgoingUserId_idx" ON "ShiftHandover"("outgoingUserId");

-- CreateIndex
CREATE INDEX "ShiftHandover_incomingUserId_idx" ON "ShiftHandover"("incomingUserId");

-- CreateIndex
CREATE INDEX "TechnicalRepairAttempt_issueId_acceptedAt_idx" ON "TechnicalRepairAttempt"("issueId", "acceptedAt");

-- CreateIndex
CREATE INDEX "TechnicalRepairAttempt_outcome_outcomeAt_idx" ON "TechnicalRepairAttempt"("outcome", "outcomeAt");

-- CreateIndex
CREATE INDEX "TechnicalRepairAttempt_technicianUserId_idx" ON "TechnicalRepairAttempt"("technicianUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalRepairAttempt_issueId_attemptNumber_key" ON "TechnicalRepairAttempt"("issueId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ShiftHandoverNote_branchId_createdAt_idx" ON "ShiftHandoverNote"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "ShiftHandoverNote_createdAt_idx" ON "ShiftHandoverNote"("createdAt");

-- CreateIndex
CREATE INDEX "ShiftHandoverNote_shiftSessionId_idx" ON "ShiftHandoverNote"("shiftSessionId");

-- CreateIndex
CREATE INDEX "ShiftHandoverNote_handoverId_idx" ON "ShiftHandoverNote"("handoverId");

-- CreateIndex
CREATE INDEX "ShiftHandoverNote_outgoingUserId_idx" ON "ShiftHandoverNote"("outgoingUserId");

-- CreateIndex
CREATE INDEX "ChatConversation_category_createdAt_idx" ON "ChatConversation"("category", "createdAt");

-- CreateIndex
CREATE INDEX "ChatConversation_anonymous_createdAt_idx" ON "ChatConversation"("anonymous", "createdAt");

-- CreateIndex
CREATE INDEX "ChatConversation_shiftSessionId_idx" ON "ChatConversation"("shiftSessionId");

-- CreateIndex
CREATE INDEX "HotelIssue_shiftSessionId_idx" ON "HotelIssue"("shiftSessionId");

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_handledByUserId_fkey" FOREIGN KEY ("handledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_outgoingShiftSessionId_fkey" FOREIGN KEY ("outgoingShiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_incomingShiftSessionId_fkey" FOREIGN KEY ("incomingShiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_outgoingUserId_fkey" FOREIGN KEY ("outgoingUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_incomingUserId_fkey" FOREIGN KEY ("incomingUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalRepairAttempt" ADD CONSTRAINT "TechnicalRepairAttempt_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalRepairAttempt" ADD CONSTRAINT "TechnicalRepairAttempt_technicianUserId_fkey" FOREIGN KEY ("technicianUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandoverNote" ADD CONSTRAINT "ShiftHandoverNote_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandoverNote" ADD CONSTRAINT "ShiftHandoverNote_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandoverNote" ADD CONSTRAINT "ShiftHandoverNote_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "ShiftHandover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftHandoverNote" ADD CONSTRAINT "ShiftHandoverNote_outgoingUserId_fkey" FOREIGN KEY ("outgoingUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- CONCURRENCY: ONE OPEN REPAIR ATTEMPT PER INCIDENT
-- ============================================================================
--
-- Prisma's schema language cannot express a PARTIAL unique index, so this is
-- written by hand — the same as `ReceptionShiftSession_one_open_per_user` in the
-- previous migration, and for the same reason.
--
-- An attempt is OPEN while `outcomeAt IS NULL`. Two technicians pressing
-- "Tiếp nhận" on the same incident in the same instant both pass an application
-- level "is it still NEW?" check; this index means the second INSERT is refused
-- by PostgreSQL, so one of them gets a clear conflict instead of the incident
-- silently acquiring two live attempts with two different technicians.
--
-- Closed attempts are not covered by the index at all, which is what allows the
-- unlimited attempt history the "Không sửa được" flow depends on.
CREATE UNIQUE INDEX "TechnicalRepairAttempt_one_open_per_issue"
  ON "TechnicalRepairAttempt"("issueId")
  WHERE "outcomeAt" IS NULL;
