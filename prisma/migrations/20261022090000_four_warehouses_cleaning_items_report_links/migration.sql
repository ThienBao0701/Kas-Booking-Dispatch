-- Housekeeping: four warehouses with server item codes, the room-cleaning item
-- list, Housekeeping reports that name their room / work item and wait for
-- Reception to name the guest. ADDITIVE: no row is deleted, no balance or
-- movement is touched, no stock is invented.
--
--   * Two more warehouses (CHEMICAL_TOOLS 1, GUEST_SUPPLIES 2; LINEN is 3,
--     AMENITY 4). EQUIPMENT stays: its items wait to be classified.
--   * Item codes ("3.001") become the server's: every item of a mapped
--     warehouse (LINEN, AMENITY) is numbered in creation order per branch; a
--     code typed by hand before is kept in the item's note ("Mã cũ: …"). An
--     EQUIPMENT item gets its code when it is classified. The sequence row
--     remembers the last number, so a number is never handed out twice.
--   * InventoryItem.cleaningOrder: the branch's "Dọn phòng" list (null: not in it).
--   * GuestRequestReport.guestName may be empty (Reception names the guest later).
--   * ReceptionOperationalReport.taskId: the work item a report was made from.

-- AlterEnum
ALTER TYPE "InventoryWarehouse" ADD VALUE 'CHEMICAL_TOOLS';
ALTER TYPE "InventoryWarehouse" ADD VALUE 'GUEST_SUPPLIES';

-- AlterTable
ALTER TABLE "GuestRequestReport" ALTER COLUMN "guestName" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "cleaningOrder" INTEGER;

-- AlterTable
ALTER TABLE "ReceptionOperationalReport" ADD COLUMN     "taskId" TEXT;

-- CreateTable
CREATE TABLE "InventoryCodeSequence" (
    "branchId" INTEGER NOT NULL,
    "warehouse" "InventoryWarehouse" NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "InventoryCodeSequence_pkey" PRIMARY KEY ("branchId","warehouse")
);

-- Backfill: a hand-typed code is kept in the note, then every code is the server's.
UPDATE "InventoryItem"
SET "note" = CASE WHEN "note" IS NULL OR "note" = '' THEN 'Mã cũ: ' || "code" ELSE "note" || ' · Mã cũ: ' || "code" END,
    "code" = NULL
WHERE "code" IS NOT NULL;

WITH numbered AS (
  SELECT "id", "warehouse", row_number() OVER (PARTITION BY "branchId", "warehouse" ORDER BY "createdAt", "id") AS n
  FROM "InventoryItem"
  WHERE "warehouse" IN ('LINEN', 'AMENITY')
)
UPDATE "InventoryItem" AS i
SET "code" = (CASE numbered."warehouse" WHEN 'LINEN' THEN '3' ELSE '4' END) || '.' ||
             (CASE WHEN numbered.n < 1000 THEN lpad(numbered.n::text, 3, '0') ELSE numbered.n::text END)
FROM numbered
WHERE i."id" = numbered."id";

INSERT INTO "InventoryCodeSequence" ("branchId", "warehouse", "lastNumber")
SELECT "branchId", "warehouse", count(*)::integer
FROM "InventoryItem"
WHERE "warehouse" IN ('LINEN', 'AMENITY')
GROUP BY "branchId", "warehouse";

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_branchId_code_key" ON "InventoryItem"("branchId", "code");

-- CreateIndex
CREATE INDEX "ReceptionOperationalReport_taskId_idx" ON "ReceptionOperationalReport"("taskId");

-- AddForeignKey
ALTER TABLE "ReceptionOperationalReport" ADD CONSTRAINT "ReceptionOperationalReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HousekeepingRoomTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCodeSequence" ADD CONSTRAINT "InventoryCodeSequence_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
