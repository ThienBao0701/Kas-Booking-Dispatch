-- Housekeeping warehouses, continued — ADDITIVE ONLY, on the warehouse tables.
--
--   * "Báo hỏng" may name the technical incident it relates to (issueId), as it
--     already may name its housekeeping work item (taskId). Nullable: a report
--     with no suitable source needs none. Existing reports keep their values.
--   * "Khai báo tồn đầu kỳ": a count marks itself as the opening count of items
--     with no stock history (opening). Existing counts read false.

-- AlterTable
ALTER TABLE "InventoryCount" ADD COLUMN     "opening" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InventoryDamageReport" ADD COLUMN     "issueId" TEXT;

-- CreateIndex
CREATE INDEX "InventoryDamageReport_issueId_idx" ON "InventoryDamageReport"("issueId");

-- AddForeignKey
ALTER TABLE "InventoryDamageReport" ADD CONSTRAINT "InventoryDamageReport_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "HotelIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

