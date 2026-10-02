-- CreateTable
CREATE TABLE "HotelIssue" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HotelIssue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HotelIssue_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "HotelIssue_branchId_status_idx" ON "HotelIssue"("branchId", "status");

-- CreateIndex
CREATE INDEX "HotelIssue_status_idx" ON "HotelIssue"("status");

-- CreateIndex
CREATE INDEX "HotelIssue_createdAt_idx" ON "HotelIssue"("createdAt");

-- CreateIndex
CREATE INDEX "HotelIssue_reportedByUserId_idx" ON "HotelIssue"("reportedByUserId");
