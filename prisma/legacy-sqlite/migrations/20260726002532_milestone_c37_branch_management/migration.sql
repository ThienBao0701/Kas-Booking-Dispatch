-- CreateTable
CREATE TABLE "BranchSourceAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "branchId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "matchMode" TEXT NOT NULL DEFAULT 'EXACT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BranchSourceAlias_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BranchChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedByUserId" INTEGER,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BranchChangeLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BranchChangeLog_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Branch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "hotelName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "branchNumber" INTEGER NOT NULL DEFAULT 0,
    "breakfastIncluded" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    "email" TEXT,
    "contactName" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Branch" ("active", "address", "code", "createdAt", "hotelName", "id", "updatedAt") SELECT "active", "address", "code", "createdAt", "hotelName", "id", "updatedAt" FROM "Branch";
DROP TABLE "Branch";
ALTER TABLE "new_Branch" RENAME TO "Branch";
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill: give every pre-existing branch a human-readable branch number.
-- `id` is used only as a one-off deterministic, collision-free source of values;
-- from here on branchNumber is an independent, Admin-editable field (and the
-- seed fills in the operator's intended 1..8 for the originally seeded codes).
-- 0 means "never numbered", so this never overwrites an existing number.
UPDATE "Branch" SET "branchNumber" = "id" WHERE "branchNumber" = 0;

-- CreateIndex
CREATE INDEX "BranchSourceAlias_source_normalizedAlias_idx" ON "BranchSourceAlias"("source", "normalizedAlias");

-- CreateIndex
CREATE INDEX "BranchSourceAlias_source_active_idx" ON "BranchSourceAlias"("source", "active");

-- CreateIndex
CREATE INDEX "BranchSourceAlias_branchId_idx" ON "BranchSourceAlias"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchSourceAlias_branchId_source_normalizedAlias_key" ON "BranchSourceAlias"("branchId", "source", "normalizedAlias");

-- CreateIndex
CREATE INDEX "BranchChangeLog_branchId_changedAt_idx" ON "BranchChangeLog"("branchId", "changedAt");

-- CreateIndex
CREATE INDEX "BranchChangeLog_changedAt_idx" ON "BranchChangeLog"("changedAt");
