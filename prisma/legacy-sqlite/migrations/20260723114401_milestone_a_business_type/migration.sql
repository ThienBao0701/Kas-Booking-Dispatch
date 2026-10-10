-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Booking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingCode" TEXT NOT NULL,
    "hotelName" TEXT,
    "branchId" INTEGER,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "sourcePlatform" TEXT NOT NULL DEFAULT 'BOOKING_COM',
    "businessType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "businessTypeConfidence" INTEGER,
    "businessTypeDetectionSource" TEXT,
    "businessTypeManuallyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "checkInDate" DATETIME,
    "checkInTime" TEXT,
    "checkOutDate" DATETIME,
    "checkOutTime" TEXT,
    "totalAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "paymentStatus" TEXT NOT NULL,
    "specialRequest" TEXT,
    "rawText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isLastMinute" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" DATETIME,
    "sentByUserId" INTEGER,
    "completedAt" DATETIME,
    "completedByUserId" INTEGER,
    "completionNote" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
    "reviewedByUserId" INTEGER,
    "reviewedAt" DATETIME,
    "parserVersion" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Booking" ("bookingCode", "branchId", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "createdByUserId", "currency", "customerName", "hotelName", "id", "isLastMinute", "parserVersion", "paymentStatus", "phone", "rawText", "reviewedAt", "reviewedByUserId", "sentAt", "sentByUserId", "sourcePlatform", "specialRequest", "status", "totalAmount", "updatedAt", "verificationStatus") SELECT "bookingCode", "branchId", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "createdByUserId", "currency", "customerName", "hotelName", "id", "isLastMinute", "parserVersion", "paymentStatus", "phone", "rawText", "reviewedAt", "reviewedByUserId", "sentAt", "sentByUserId", "sourcePlatform", "specialRequest", "status", "totalAmount", "updatedAt", "verificationStatus" FROM "Booking";
DROP TABLE "Booking";
ALTER TABLE "new_Booking" RENAME TO "Booking";
CREATE INDEX "Booking_bookingCode_idx" ON "Booking"("bookingCode");
CREATE INDEX "Booking_branchId_status_idx" ON "Booking"("branchId", "status");
CREATE INDEX "Booking_status_idx" ON "Booking"("status");
CREATE INDEX "Booking_branchId_verificationStatus_idx" ON "Booking"("branchId", "verificationStatus");
CREATE INDEX "Booking_verificationStatus_idx" ON "Booking"("verificationStatus");
CREATE INDEX "Booking_sourcePlatform_idx" ON "Booking"("sourcePlatform");
CREATE INDEX "Booking_businessType_idx" ON "Booking"("businessType");
CREATE INDEX "Booking_sentAt_idx" ON "Booking"("sentAt");
CREATE INDEX "Booking_checkInDate_idx" ON "Booking"("checkInDate");
CREATE INDEX "Booking_isLastMinute_idx" ON "Booking"("isLastMinute");
CREATE INDEX "Booking_customerName_idx" ON "Booking"("customerName");
CREATE INDEX "Booking_phone_idx" ON "Booking"("phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
