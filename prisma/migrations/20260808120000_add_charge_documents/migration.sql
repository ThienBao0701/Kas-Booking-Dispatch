-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('CHUA_XU_LY', 'DA_BI_CHARGE', 'CHARGE_THAT_BAI');

-- CreateEnum
CREATE TYPE "ChargeAttachmentCategory" AS ENUM ('GUEST_IMAGE', 'CHARGE_DOCUMENT', 'CARD_IMAGE');

-- CreateEnum
CREATE TYPE "ChargeAuditAction" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'CARD_REVEALED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'BOOKING_DEPARTMENT';

-- CreateTable
CREATE TABLE "ChargeDocument" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "bookingId" TEXT,
    "guestName" TEXT NOT NULL,
    "bookingCode" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "cardNumberCipher" TEXT NOT NULL,
    "cardLast4" TEXT NOT NULL,
    "cardExpiry" TEXT NOT NULL,
    "cardKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "checkIn" TIMESTAMP(3) NOT NULL,
    "checkOut" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'CHUA_XU_LY',
    "chargedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeDocumentAttachment" (
    "id" TEXT NOT NULL,
    "chargeDocumentId" TEXT NOT NULL,
    "category" "ChargeAttachmentCategory" NOT NULL,
    "storedFileName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedByUserId" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargeDocumentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeDocumentAudit" (
    "id" TEXT NOT NULL,
    "chargeDocumentId" TEXT NOT NULL,
    "action" "ChargeAuditAction" NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actorUserId" INTEGER,
    "actorRole" "UserRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargeDocumentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargeDocument_branchId_idx" ON "ChargeDocument"("branchId");

-- CreateIndex
CREATE INDEX "ChargeDocument_status_idx" ON "ChargeDocument"("status");

-- CreateIndex
CREATE INDEX "ChargeDocument_chargedAt_idx" ON "ChargeDocument"("chargedAt");

-- CreateIndex
CREATE INDEX "ChargeDocument_bookingCode_idx" ON "ChargeDocument"("bookingCode");

-- CreateIndex
CREATE INDEX "ChargeDocument_checkIn_idx" ON "ChargeDocument"("checkIn");

-- CreateIndex
CREATE INDEX "ChargeDocument_createdAt_idx" ON "ChargeDocument"("createdAt");

-- CreateIndex
CREATE INDEX "ChargeDocumentAttachment_chargeDocumentId_idx" ON "ChargeDocumentAttachment"("chargeDocumentId");

-- CreateIndex
CREATE INDEX "ChargeDocumentAttachment_chargeDocumentId_category_idx" ON "ChargeDocumentAttachment"("chargeDocumentId", "category");

-- CreateIndex
CREATE INDEX "ChargeDocumentAudit_chargeDocumentId_createdAt_idx" ON "ChargeDocumentAudit"("chargeDocumentId", "createdAt");

-- CreateIndex
CREATE INDEX "ChargeDocumentAudit_action_idx" ON "ChargeDocumentAudit"("action");

-- AddForeignKey
ALTER TABLE "ChargeDocument" ADD CONSTRAINT "ChargeDocument_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocument" ADD CONSTRAINT "ChargeDocument_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocument" ADD CONSTRAINT "ChargeDocument_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocument" ADD CONSTRAINT "ChargeDocument_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocumentAttachment" ADD CONSTRAINT "ChargeDocumentAttachment_chargeDocumentId_fkey" FOREIGN KEY ("chargeDocumentId") REFERENCES "ChargeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocumentAttachment" ADD CONSTRAINT "ChargeDocumentAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocumentAudit" ADD CONSTRAINT "ChargeDocumentAudit_chargeDocumentId_fkey" FOREIGN KEY ("chargeDocumentId") REFERENCES "ChargeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeDocumentAudit" ADD CONSTRAINT "ChargeDocumentAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "BranchOtaRoomMapping_branchId_platform_normalizedOtaRoomName_ke" RENAME TO "BranchOtaRoomMapping_branchId_platform_normalizedOtaRoomNam_key";

