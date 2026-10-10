-- AlterEnum
ALTER TYPE "BookingAuditAction" ADD VALUE 'BOOKING_CLAIMED';
ALTER TYPE "BookingAuditAction" ADD VALUE 'BOOKING_RESENT';
ALTER TYPE "BookingAuditAction" ADD VALUE 'BOOKING_CLAIM_EXPIRED';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "claimedByUserId" INTEGER,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimExpiresAt" TIMESTAMP(3),
ADD COLUMN     "claimCycle" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "senderUserId" INTEGER NOT NULL,
    "recipientUserId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_claimExpiresAt_idx" ON "Booking"("claimExpiresAt");

-- CreateIndex
CREATE INDEX "Booking_claimedByUserId_idx" ON "Booking"("claimedByUserId");

-- CreateIndex
CREATE INDEX "Reminder_recipientUserId_readAt_idx" ON "Reminder"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Reminder_recipientUserId_createdAt_idx" ON "Reminder"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Reminder_senderUserId_idx" ON "Reminder"("senderUserId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
