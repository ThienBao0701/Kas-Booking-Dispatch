-- CreateTable
CREATE TABLE "BookingExtractWarning" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingExtractWarning_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "parserVersion" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Booking" ("bookingCode", "branchId", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "currency", "customerName", "hotelName", "id", "isLastMinute", "paymentStatus", "phone", "rawText", "sentAt", "sentByUserId", "specialRequest", "status", "totalAmount", "updatedAt") SELECT "bookingCode", "branchId", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "currency", "customerName", "hotelName", "id", "isLastMinute", "paymentStatus", "phone", "rawText", "sentAt", "sentByUserId", "specialRequest", "status", "totalAmount", "updatedAt" FROM "Booking";
DROP TABLE "Booking";
ALTER TABLE "new_Booking" RENAME TO "Booking";
CREATE INDEX "Booking_bookingCode_idx" ON "Booking"("bookingCode");
CREATE INDEX "Booking_branchId_status_idx" ON "Booking"("branchId", "status");
CREATE INDEX "Booking_status_idx" ON "Booking"("status");
CREATE INDEX "Booking_sentAt_idx" ON "Booking"("sentAt");
CREATE INDEX "Booking_checkInDate_idx" ON "Booking"("checkInDate");
CREATE INDEX "Booking_isLastMinute_idx" ON "Booking"("isLastMinute");
CREATE INDEX "Booking_customerName_idx" ON "Booking"("customerName");
CREATE INDEX "Booking_phone_idx" ON "Booking"("phone");
CREATE TABLE "new_BookingNightPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingRoomId" TEXT NOT NULL,
    "stayDate" DATETIME NOT NULL,
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "manuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "isEstimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingNightPrice_bookingRoomId_fkey" FOREIGN KEY ("bookingRoomId") REFERENCES "BookingRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookingNightPrice" ("amount", "bookingRoomId", "createdAt", "currency", "id", "manuallyCorrected", "stayDate", "updatedAt") SELECT "amount", "bookingRoomId", "createdAt", "currency", "id", "manuallyCorrected", "stayDate", "updatedAt" FROM "BookingNightPrice";
DROP TABLE "BookingNightPrice";
ALTER TABLE "new_BookingNightPrice" RENAME TO "BookingNightPrice";
CREATE INDEX "BookingNightPrice_bookingRoomId_idx" ON "BookingNightPrice"("bookingRoomId");
CREATE INDEX "BookingNightPrice_stayDate_idx" ON "BookingNightPrice"("stayDate");
CREATE UNIQUE INDEX "BookingNightPrice_bookingRoomId_stayDate_key" ON "BookingNightPrice"("bookingRoomId", "stayDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BookingExtractWarning_bookingId_idx" ON "BookingExtractWarning"("bookingId");

-- CreateIndex
CREATE INDEX "BookingExtractWarning_code_idx" ON "BookingExtractWarning"("code");
