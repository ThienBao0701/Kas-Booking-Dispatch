-- HOUSEKEEPING WAREHOUSES — Kho Linens, Kho Amenities, Kho đồ dùng, thiết bị.
--
-- ADDITIVE ONLY: new enums and tables, their indexes and foreign keys. No
-- existing table, column or row is changed, and no opening balance is created:
-- a branch's stock starts when its manager adds items and receives deliveries.
--
-- The balance table is a projection of the movement ledger, written in the same
-- transaction as each movement; the CHECK constraints keep every balance and
-- quantity non-negative under any number of concurrent writers.

-- CreateEnum
CREATE TYPE "InventoryWarehouse" AS ENUM ('LINEN', 'AMENITY', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "InventoryStockState" AS ENUM ('AVAILABLE', 'DIRTY', 'IN_LAUNDRY', 'ISSUED', 'DAMAGED');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIPT', 'ROOM_ISSUE', 'DIRTY_COLLECTED', 'LAUNDRY_SENT', 'LAUNDRY_RETURNED', 'STOCK_ISSUED', 'STOCK_RETURNED', 'DAMAGE', 'DAMAGE_REVERSAL', 'COUNT_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InventoryTransferKind" AS ENUM ('LAUNDRY_SEND', 'LAUNDRY_RETURN', 'STOCK_ISSUE', 'STOCK_RETURN');

-- CreateEnum
CREATE TYPE "InventoryDamageStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'REJECTED');

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "name" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "code" TEXT,
    "unit" TEXT NOT NULL,
    "catalogKey" TEXT,
    "lowStockThreshold" INTEGER,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "itemId" TEXT NOT NULL,
    "state" "InventoryStockState" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("itemId","state")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "state" "InventoryStockState" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "reason" TEXT,
    "roomNumber" TEXT,
    "workDate" TEXT,
    "taskId" TEXT,
    "receiptId" TEXT,
    "countId" TEXT,
    "transferId" TEXT,
    "damageReportId" TEXT,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceipt" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "requestId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "InventoryReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCount" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "requestId" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdByRole" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "state" "InventoryStockState" NOT NULL,
    "systemQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "reason" TEXT,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "kind" "InventoryTransferKind" NOT NULL,
    "requestId" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" INTEGER NOT NULL,
    "createdByNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "InventoryTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryDamageReport" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromState" "InventoryStockState" NOT NULL,
    "reason" TEXT NOT NULL,
    "roomNumber" TEXT,
    "taskId" TEXT,
    "requestId" TEXT NOT NULL,
    "status" "InventoryDamageStatus" NOT NULL DEFAULT 'PENDING',
    "reportedByUserId" INTEGER NOT NULL,
    "reportedByNameSnapshot" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "reviewedByUserId" INTEGER,
    "reviewedByNameSnapshot" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,

    CONSTRAINT "InventoryDamageReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryItem_branchId_warehouse_idx" ON "InventoryItem"("branchId", "warehouse");

-- CreateIndex
CREATE INDEX "InventoryMovement_branchId_createdAt_idx" ON "InventoryMovement"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_itemId_createdAt_idx" ON "InventoryMovement"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_taskId_idx" ON "InventoryMovement"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_sourceKey_itemId_state_key" ON "InventoryMovement"("sourceKey", "itemId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceipt_requestId_key" ON "InventoryReceipt"("requestId");

-- CreateIndex
CREATE INDEX "InventoryReceipt_branchId_createdAt_idx" ON "InventoryReceipt"("branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceiptLine_receiptId_itemId_key" ON "InventoryReceiptLine"("receiptId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCount_requestId_key" ON "InventoryCount"("requestId");

-- CreateIndex
CREATE INDEX "InventoryCount_branchId_createdAt_idx" ON "InventoryCount"("branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountLine_countId_itemId_state_key" ON "InventoryCountLine"("countId", "itemId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_requestId_key" ON "InventoryTransfer"("requestId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_branchId_createdAt_idx" ON "InventoryTransfer"("branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransferLine_transferId_itemId_key" ON "InventoryTransferLine"("transferId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDamageReport_requestId_key" ON "InventoryDamageReport"("requestId");

-- CreateIndex
CREATE INDEX "InventoryDamageReport_branchId_status_reportedAt_idx" ON "InventoryDamageReport"("branchId", "status", "reportedAt");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HousekeepingRoomTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "InventoryReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_damageReportId_fkey" FOREIGN KEY ("damageReportId") REFERENCES "InventoryDamageReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "InventoryReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HousekeepingRoomTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- No balance below zero, ever; quantities on documents are positive.
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_quantities_non_negative" CHECK ("systemQuantity" >= 0 AND "countedQuantity" >= 0);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_delta_non_zero" CHECK ("delta" <> 0 AND "balanceAfter" >= 0);

-- One ACTIVE item per branch, warehouse, name and variant; per code; and per
-- "Dọn phòng" field — an archived item keeps its history and frees its name.
CREATE UNIQUE INDEX "InventoryItem_active_name_variant"
  ON "InventoryItem" ("branchId", "warehouse", lower("name"), "variant")
  WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "InventoryItem_active_code"
  ON "InventoryItem" ("branchId", lower("code"))
  WHERE "archivedAt" IS NULL AND "code" IS NOT NULL;
CREATE UNIQUE INDEX "InventoryItem_active_catalog_key"
  ON "InventoryItem" ("branchId", "catalogKey")
  WHERE "archivedAt" IS NULL AND "catalogKey" IS NOT NULL;
