-- "Nhập bù" for facility incidents: who actually entered a late incident report,
-- in what role, and why. The receptionist of the original shift stays the
-- reporter; createdAt stays the real entry time. Additive only: four nullable
-- columns, an index and a foreign key; no existing row changes.

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "enteredByNameSnapshot" TEXT,
ADD COLUMN     "enteredByRole" "UserRole",
ADD COLUMN     "enteredByUserId" INTEGER,
ADD COLUMN     "lateEntryReason" TEXT;

-- CreateIndex
CREATE INDEX "HotelIssue_enteredByUserId_idx" ON "HotelIssue"("enteredByUserId");

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_enteredByUserId_fkey" FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

