-- CreateTable
CREATE TABLE "DemoDataBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paramsJson" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Booking_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Booking_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Booking" ("bookingCode", "branchId", "businessType", "businessTypeConfidence", "businessTypeDetectionSource", "businessTypeManuallyConfirmed", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "createdByUserId", "currency", "customerName", "hotelName", "id", "isLastMinute", "parserVersion", "paymentStatus", "phone", "rawText", "reviewedAt", "reviewedByUserId", "sentAt", "sentByUserId", "sourcePlatform", "specialRequest", "status", "totalAmount", "updatedAt", "verificationStatus") SELECT "bookingCode", "branchId", "businessType", "businessTypeConfidence", "businessTypeDetectionSource", "businessTypeManuallyConfirmed", "checkInDate", "checkInTime", "checkOutDate", "checkOutTime", "completedAt", "completedByUserId", "completionNote", "createdAt", "createdByUserId", "currency", "customerName", "hotelName", "id", "isLastMinute", "parserVersion", "paymentStatus", "phone", "rawText", "reviewedAt", "reviewedByUserId", "sentAt", "sentByUserId", "sourcePlatform", "specialRequest", "status", "totalAmount", "updatedAt", "verificationStatus" FROM "Booking";
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
CREATE INDEX "Booking_isDemo_idx" ON "Booking"("isDemo");
CREATE INDEX "Booking_demoBatchId_idx" ON "Booking"("demoBatchId");
CREATE TABLE "new_HotelIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" INTEGER NOT NULL,
    "roomNumber" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photoStoredName" TEXT,
    "photoMimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reportedByUserId" INTEGER NOT NULL,
    "acceptedByUserId" INTEGER,
    "resolvedByUserId" INTEGER,
    "resolvedAt" DATETIME,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HotelIssue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_HotelIssue" ("acceptedByUserId", "branchId", "category", "createdAt", "description", "id", "photoMimeType", "photoStoredName", "reportedByUserId", "resolvedAt", "resolvedByUserId", "roomNumber", "status", "updatedAt") SELECT "acceptedByUserId", "branchId", "category", "createdAt", "description", "id", "photoMimeType", "photoStoredName", "reportedByUserId", "resolvedAt", "resolvedByUserId", "roomNumber", "status", "updatedAt" FROM "HotelIssue";
DROP TABLE "HotelIssue";
ALTER TABLE "new_HotelIssue" RENAME TO "HotelIssue";
CREATE INDEX "HotelIssue_branchId_status_idx" ON "HotelIssue"("branchId", "status");
CREATE INDEX "HotelIssue_status_idx" ON "HotelIssue"("status");
CREATE INDEX "HotelIssue_createdAt_idx" ON "HotelIssue"("createdAt");
CREATE INDEX "HotelIssue_reportedByUserId_idx" ON "HotelIssue"("reportedByUserId");
CREATE INDEX "HotelIssue_isDemo_idx" ON "HotelIssue"("isDemo");
CREATE INDEX "HotelIssue_demoBatchId_idx" ON "HotelIssue"("demoBatchId");
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "bookingId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("body", "bookingId", "createdAt", "id", "read", "readAt", "title", "userId") SELECT "body", "bookingId", "createdAt", "id", "read", "readAt", "title", "userId" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "Notification_isDemo_idx" ON "Notification"("isDemo");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
