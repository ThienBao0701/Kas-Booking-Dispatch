-- RECEPTION OPERATIONAL REPORTING V3 — "Báo cáo vấn đề".
--
-- WHAT THIS DOES: four enums, seven tables, three columns on an existing one.
-- Every statement is a CREATE or an additive ALTER. There is no DROP, no DELETE,
-- no TRUNCATE and no column made NOT NULL on an existing table, so no row that
-- exists before this migration can be changed or lost by it.
--
-- WHY THERE IS NO BACKFILL
--
-- `ReceptionOperationalReport` starts empty, and it must. Nothing in the
-- existing data records who took a guest's bag, what cash was in a drawer at
-- 06:00, or which complaint was made on which shift — that is exactly the
-- information this feature exists to begin capturing. Manufacturing rows from
-- what is already here would put invented operational history, with invented
-- shift attribution and invented amounts, beside the real kind; a cash report
-- that silently contains fabricated opening balances is worse than one that
-- starts on the day the feature shipped.
--
-- `ReceptionShiftSession.openingCash` is therefore nullable, and NULL means
-- "not counted" rather than zero. Sessions that ran before today keep NULL and
-- report no ending cash, which is the truth about them.
--
-- WHY `FacilityIssueReport` HAS ONE MEANINGFUL COLUMN
--
-- It points at `HotelIssue` and copies nothing from it. The reception journal's
-- "Sự cố cơ sở vật chất" entry IS the existing incident, seen from the desk
-- that raised it; duplicating the area, status or technician here would create a
-- second maintenance record that goes stale the moment Bộ phận kỹ thuật touches
-- the first. RESTRICT on that FK for the same reason the reference exists: the
-- journal entry must not vanish if an incident is ever deleted.
--
-- WHY `createdAt` HAS NO DEFAULT
--
-- Deliberately not `DEFAULT now()`. The Admin period report filters on it, and a
-- timestamp only PostgreSQL can produce is one the application's own business
-- clock cannot pin — which made an earlier feature's report silently change
-- behaviour when the date rolled over. Every row here is stamped by the server
-- from the injected clock. `updatedAt` keeps Prisma's own @updatedAt handling.

-- CreateEnum
CREATE TYPE "OperationalReportCategory" AS ENUM ('PAYMENT', 'GUEST_REQUEST', 'FACILITY_ISSUE', 'CUSTOMER_COMPLAINT', 'ROOM_SERVICE');

-- CreateEnum
CREATE TYPE "ReceptionPaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CARD');

-- CreateEnum
CREATE TYPE "RoomServiceType" AS ENUM ('ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReceptionReportAuditAction" AS ENUM ('EDIT', 'VOID', 'OPENING_CASH');

-- AlterTable
ALTER TABLE "ReceptionShiftSession" ADD COLUMN     "openingCash" INTEGER,
ADD COLUMN     "openingCashSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReceptionOperationalReport" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "shiftSessionId" TEXT,
    "shiftType" "ShiftType",
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "category" "OperationalReportCategory" NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" INTEGER,
    "voidedByNameSnapshot" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionOperationalReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionPayment" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "ezCode" TEXT,
    "source" TEXT,
    "guestName" TEXT,
    "roomNumber" TEXT,
    "method" "ReceptionPaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "receivable" INTEGER NOT NULL DEFAULT 0,
    "expense" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "ReceptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestRequestReport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "note" TEXT,
    "acceptedByUserId" INTEGER,
    "acceptedByNameSnapshot" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedShiftSessionId" TEXT,
    "acceptedShiftType" "ShiftType",

    CONSTRAINT "GuestRequestReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityIssueReport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,

    CONSTRAINT "FacilityIssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerComplaintReport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "CustomerComplaintReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomServiceReport" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "serviceType" "RoomServiceType" NOT NULL,
    "guestName" TEXT NOT NULL,
    "phone" TEXT,
    "roomNumber" TEXT,
    "roomClass" TEXT,
    "fromRoomClass" TEXT,
    "toRoomClass" TEXT,
    "serviceName" TEXT,
    "price" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "RoomServiceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionReportAudit" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "reportId" TEXT,
    "shiftSessionId" TEXT,
    "action" "ReceptionReportAuditAction" NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "actorShiftType" "ShiftType",
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionReportAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_branchId_category_createdAt_idx" ON "ReceptionOperationalReport"("branchId", "category", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_shiftSessionId_createdAt_idx" ON "ReceptionOperationalReport"("shiftSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_branchId_createdAt_idx" ON "ReceptionOperationalReport"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_category_createdAt_idx" ON "ReceptionOperationalReport"("category", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_createdAt_idx" ON "ReceptionOperationalReport"("createdAt");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_createdByUserId_idx" ON "ReceptionOperationalReport"("createdByUserId");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_voidedAt_idx" ON "ReceptionOperationalReport"("voidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionPayment_reportId_key" ON "ReceptionPayment"("reportId");

-- CreateIndex
CREATE INDEX "ReceptionPayment_method_idx" ON "ReceptionPayment"("method");

-- CreateIndex
CREATE UNIQUE INDEX "GuestRequestReport_reportId_key" ON "GuestRequestReport"("reportId");

-- CreateIndex
CREATE INDEX "GuestRequestReport_acceptedAt_idx" ON "GuestRequestReport"("acceptedAt");

-- CreateIndex
CREATE INDEX "GuestRequestReport_acceptedByUserId_idx" ON "GuestRequestReport"("acceptedByUserId");

-- CreateIndex
CREATE INDEX "GuestRequestReport_acceptedShiftSessionId_idx" ON "GuestRequestReport"("acceptedShiftSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityIssueReport_reportId_key" ON "FacilityIssueReport"("reportId");

-- CreateIndex
CREATE INDEX "FacilityIssueReport_issueId_idx" ON "FacilityIssueReport"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerComplaintReport_reportId_key" ON "CustomerComplaintReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomServiceReport_reportId_key" ON "RoomServiceReport"("reportId");

-- CreateIndex
CREATE INDEX "RoomServiceReport_serviceType_idx" ON "RoomServiceReport"("serviceType");

-- CreateIndex
CREATE INDEX "ReceptionReportAudit_reportId_createdAt_idx" ON "ReceptionReportAudit"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionReportAudit_branchId_createdAt_idx" ON "ReceptionReportAudit"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionReportAudit_shiftSessionId_idx" ON "ReceptionReportAudit"("shiftSessionId");

-- CreateIndex
CREATE INDEX "ReceptionReportAudit_actorUserId_idx" ON "ReceptionReportAudit"("actorUserId");

-- CreateIndex
CREATE INDEX "ReceptionReportAudit_action_idx" ON "ReceptionReportAudit"("action");

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionPayment" ADD CONSTRAINT "ReceptionPayment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestRequestReport" ADD CONSTRAINT "GuestRequestReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestRequestReport" ADD CONSTRAINT "GuestRequestReport_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestRequestReport" ADD CONSTRAINT "GuestRequestReport_acceptedShiftSessionId_fkey" FOREIGN KEY ("acceptedShiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityIssueReport" ADD CONSTRAINT "FacilityIssueReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityIssueReport" ADD CONSTRAINT "FacilityIssueReport_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerComplaintReport" ADD CONSTRAINT "CustomerComplaintReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomServiceReport" ADD CONSTRAINT "RoomServiceReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionReportAudit" ADD CONSTRAINT "ReceptionReportAudit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionReportAudit" ADD CONSTRAINT "ReceptionReportAudit_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReceptionOperationalReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionReportAudit" ADD CONSTRAINT "ReceptionReportAudit_shiftSessionId_fkey" FOREIGN KEY ("shiftSessionId") REFERENCES "ReceptionShiftSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionReportAudit" ADD CONSTRAINT "ReceptionReportAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

