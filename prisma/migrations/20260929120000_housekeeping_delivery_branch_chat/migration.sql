-- Housekeeping room inspections and their collection, hotel deliveries, branch
-- chat channels, incident edit history, and the "Công nợ" payment method.
--
-- EVERYTHING HERE IS ADDITIVE. No column is dropped, retyped or rewritten, no
-- existing row is touched, and every new column on an existing table has a
-- default.
--
-- 1. THREE NEW ENUM VALUES — UserRole.HOUSEKEEPING, ReceptionPaymentMethod.DEBT
--    and OperationalReportCategory.HOTEL_DELIVERY. PostgreSQL forbids USING a
--    value added by ALTER TYPE ... ADD VALUE in the transaction that added it;
--    nothing in this file does (the CHECK constraints below reference only enums
--    CREATED here).
--
-- 2. ONE CHANNEL PER BRANCH is a database rule. `ChatConversation_one_channel_per_branch`
--    is a partial unique index — the same device
--    `Booking_one_operational_per_code_branch_checkin` uses — because two
--    people opening the chat bubble on a branch's first message at the same
--    instant would both pass any application-level SELECT. Prisma cannot express
--    it, so it is created here.
--
-- 3. TWO CHECK CONSTRAINTS on `RoomIssueCollection` restate what the service
--    enforces: a COLLECTED row names its method, and an UNCOLLECTIBLE row has a
--    non-blank reason ("Không thu được" without a reason is the row an audit
--    stops on). A caller that bypasses the service still cannot store either.

-- CreateEnum
CREATE TYPE "HotelDeliveryDepartment" AS ENUM ('RECEPTION', 'HOUSEKEEPING', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "RoomIssueType" AS ENUM ('SMOKING', 'ODOR', 'DAMAGED_FACILITY', 'LOST_ITEM', 'UNREGISTERED_GUEST', 'OTHER');

-- CreateEnum
CREATE TYPE "RoomCollectionStatus" AS ENUM ('PENDING', 'COLLECTED', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "RoomCollectionMethod" AS ENUM ('CASH', 'TRANSFER', 'CARD');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'HOUSEKEEPING';

-- AlterEnum
ALTER TYPE "OperationalReportCategory" ADD VALUE 'HOTEL_DELIVERY';

-- AlterEnum
ALTER TYPE "ReceptionPaymentMethod" ADD VALUE 'DEBT';

-- AlterTable
ALTER TABLE "ChatConversation" ADD COLUMN     "branchChannel" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HotelIssueEdit" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelIssueEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatReadState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelDeliveryReport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "department" "HotelDeliveryDepartment" NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelDeliveryReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomInspection" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomInspectionIssue" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "type" "RoomIssueType" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" INTEGER,
    "voidedByNameSnapshot" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "RoomInspectionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomIssueCollection" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "RoomCollectionStatus" NOT NULL,
    "method" "RoomCollectionMethod",
    "reason" TEXT,
    "note" TEXT,
    "recordedByUserId" INTEGER NOT NULL,
    "recordedByNameSnapshot" TEXT NOT NULL,
    "shiftSessionId" TEXT,
    "shiftType" "ShiftType",
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomIssueCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomIssueCollectionEvent" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "RoomCollectionStatus" NOT NULL,
    "method" "RoomCollectionMethod",
    "reason" TEXT,
    "note" TEXT,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomIssueCollectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotelIssueEdit_issueId_createdAt_idx" ON "HotelIssueEdit"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "HotelIssueEdit_actorUserId_idx" ON "HotelIssueEdit"("actorUserId");

-- CreateIndex
CREATE INDEX "ChatReadState_userId_idx" ON "ChatReadState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatReadState_conversationId_userId_key" ON "ChatReadState"("conversationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "HotelDeliveryReport_reportId_key" ON "HotelDeliveryReport"("reportId");

-- CreateIndex
CREATE INDEX "HotelDeliveryReport_department_completedAt_idx" ON "HotelDeliveryReport"("department", "completedAt");

-- CreateIndex
CREATE INDEX "HotelDeliveryReport_completedAt_idx" ON "HotelDeliveryReport"("completedAt");

-- CreateIndex
CREATE INDEX "RoomInspection_branchId_createdAt_idx" ON "RoomInspection"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "RoomInspection_createdAt_idx" ON "RoomInspection"("createdAt");

-- CreateIndex
CREATE INDEX "RoomInspection_createdByUserId_idx" ON "RoomInspection"("createdByUserId");

-- CreateIndex
CREATE INDEX "RoomInspectionIssue_branchId_createdAt_idx" ON "RoomInspectionIssue"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "RoomInspectionIssue_inspectionId_idx" ON "RoomInspectionIssue"("inspectionId");

-- CreateIndex
CREATE INDEX "RoomInspectionIssue_type_idx" ON "RoomInspectionIssue"("type");

-- CreateIndex
CREATE UNIQUE INDEX "RoomIssueCollection_issueId_key" ON "RoomIssueCollection"("issueId");

-- CreateIndex
CREATE INDEX "RoomIssueCollection_status_idx" ON "RoomIssueCollection"("status");

-- CreateIndex
CREATE INDEX "RoomIssueCollection_updatedAt_idx" ON "RoomIssueCollection"("updatedAt");

-- CreateIndex
CREATE INDEX "RoomIssueCollectionEvent_issueId_createdAt_idx" ON "RoomIssueCollectionEvent"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatConversation_branchChannel_branchId_idx" ON "ChatConversation"("branchChannel", "branchId");

-- AddForeignKey
ALTER TABLE "HotelIssueEdit" ADD CONSTRAINT "HotelIssueEdit_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssueEdit" ADD CONSTRAINT "HotelIssueEdit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelDeliveryReport" ADD CONSTRAINT "HotelDeliveryReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspection" ADD CONSTRAINT "RoomInspection_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspection" ADD CONSTRAINT "RoomInspection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspectionIssue" ADD CONSTRAINT "RoomInspectionIssue_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "RoomInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspectionIssue" ADD CONSTRAINT "RoomInspectionIssue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInspectionIssue" ADD CONSTRAINT "RoomInspectionIssue_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomIssueCollection" ADD CONSTRAINT "RoomIssueCollection_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "RoomInspectionIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomIssueCollection" ADD CONSTRAINT "RoomIssueCollection_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomIssueCollectionEvent" ADD CONSTRAINT "RoomIssueCollectionEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "RoomInspectionIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomIssueCollectionEvent" ADD CONSTRAINT "RoomIssueCollectionEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One conversation per branch channel; question threads (branchChannel = false)
-- are unconstrained, exactly as before.
CREATE UNIQUE INDEX "ChatConversation_one_channel_per_branch"
  ON "ChatConversation" ("branchId")
  WHERE "branchChannel" = true;

ALTER TABLE "RoomIssueCollection"
  ADD CONSTRAINT "RoomIssueCollection_collected_has_method"
  CHECK ("status" <> 'COLLECTED' OR "method" IS NOT NULL);

ALTER TABLE "RoomIssueCollection"
  ADD CONSTRAINT "RoomIssueCollection_uncollectible_has_reason"
  CHECK ("status" <> 'UNCOLLECTIBLE' OR (length(btrim(coalesce("reason", ''))) > 0));
