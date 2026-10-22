-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "noteGeneratedAt" DATETIME;
ALTER TABLE "Booking" ADD COLUMN "noteVersion" TEXT;

-- AlterTable
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassBranchId" INTEGER;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassDisplayName" TEXT;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassId" TEXT;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassPmsCode" TEXT;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassResolvedAt" DATETIME;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassSourceText" TEXT;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassStatus" TEXT;
ALTER TABLE "BookingRoom" ADD COLUMN "roomClassVersionId" TEXT;

-- CreateTable
CREATE TABLE "BranchRoomMappingVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" INTEGER NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" INTEGER,
    "activatedByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "archivedAt" DATETIME,
    "changeReason" TEXT,
    CONSTRAINT "BranchRoomMappingVersion_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BranchRoomMappingVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BranchRoomMappingVersion_activatedByUserId_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BranchRoomClass" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "pmsCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BranchRoomClass_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BranchRoomClass_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BranchRoomMappingVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BranchRoomClassAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomClassId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SEED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BranchRoomClassAlias_roomClassId_fkey" FOREIGN KEY ("roomClassId") REFERENCES "BranchRoomClass" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingGuest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "nationality" TEXT,
    "identityNumber" TEXT,
    "identityType" TEXT,
    "note" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" INTEGER,
    "updatedByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingGuest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "actorUserId" INTEGER,
    "actorRole" TEXT,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingAuditEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BranchRoomMappingVersion_branchId_status_idx" ON "BranchRoomMappingVersion"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BranchRoomMappingVersion_branchId_versionNumber_key" ON "BranchRoomMappingVersion"("branchId", "versionNumber");

-- CreateIndex
CREATE INDEX "BranchRoomClass_branchId_idx" ON "BranchRoomClass"("branchId");

-- CreateIndex
CREATE INDEX "BranchRoomClass_versionId_active_idx" ON "BranchRoomClass"("versionId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "BranchRoomClass_versionId_normalizedName_key" ON "BranchRoomClass"("versionId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "BranchRoomClass_versionId_pmsCode_key" ON "BranchRoomClass"("versionId", "pmsCode");

-- CreateIndex
CREATE UNIQUE INDEX "BranchRoomClass_versionId_stableKey_key" ON "BranchRoomClass"("versionId", "stableKey");

-- CreateIndex
CREATE INDEX "BranchRoomClassAlias_roomClassId_idx" ON "BranchRoomClassAlias"("roomClassId");

-- CreateIndex
CREATE INDEX "BranchRoomClassAlias_branchId_idx" ON "BranchRoomClassAlias"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchRoomClassAlias_versionId_normalizedAlias_key" ON "BranchRoomClassAlias"("versionId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "BookingGuest_bookingId_idx" ON "BookingGuest"("bookingId");

-- CreateIndex
CREATE INDEX "BookingGuest_bookingId_isPrimary_idx" ON "BookingGuest"("bookingId", "isPrimary");

-- CreateIndex
CREATE INDEX "BookingAuditEvent_bookingId_createdAt_idx" ON "BookingAuditEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingAuditEvent_action_idx" ON "BookingAuditEvent"("action");

-- ===========================================================================
-- C.3.8 hardening + backfill.
--
-- This migration is ADDITIVE ONLY: it creates tables and nullable columns and
-- fills them in. No table is redefined, no row is deleted, and no existing
-- value is overwritten. Every existing branch, booking, room, night, user,
-- proof, note and upload survives untouched.
-- ===========================================================================

-- A branch may never have two ACTIVE room-mapping versions at once. The
-- activation transaction already archives the old version before promoting the
-- draft; this partial unique index makes the invariant impossible to violate
-- even under concurrent activations (the loser fails and rolls back).
-- Not expressible in the Prisma schema, so it is created here deliberately.
CREATE UNIQUE INDEX "BranchRoomMappingVersion_one_active_per_branch"
  ON "BranchRoomMappingVersion"("branchId")
  WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Backfill 1 — every existing booking gets a PRIMARY guest mirroring the
-- scalar customer fields it already had.
--
-- `Booking.customerName` / `Booking.phone` are deliberately left in place and
-- keep their values: they remain the denormalised mirror of the primary guest,
-- so every existing read path, note builder, export and proof comparison keeps
-- working with no change at all. Nothing is invented — an empty customerName
-- stays an empty guest name rather than being given a made-up value.
-- ---------------------------------------------------------------------------
INSERT INTO "BookingGuest" (
  "id", "bookingId", "fullName", "phone", "isPrimary", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))),
  b."id",
  b."customerName",
  b."phone",
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Booking" b
WHERE NOT EXISTS (SELECT 1 FROM "BookingGuest" g WHERE g."bookingId" = b."id");

-- ---------------------------------------------------------------------------
-- Backfill 2 — record what each existing room's type text was, and mark it
-- LEGACY.
--
-- A PMS code is deliberately NOT invented here. The pre-C.3.8 room codes came
-- from a global keyword table that had no notion of branch, so guessing a
-- branch-specific code for historical rows would be exactly the silent
-- rewriting this phase exists to prevent. LEGACY rows keep rendering through
-- the unchanged legacy abbreviation path, and an authorised user can resolve
-- them explicitly (with an audit event) whenever they choose.
-- ---------------------------------------------------------------------------
UPDATE "BookingRoom"
SET "roomClassSourceText" = "roomType",
    "roomClassStatus"     = 'LEGACY',
    "roomClassBranchId"   = (
      SELECT b."branchId" FROM "Booking" b WHERE b."id" = "BookingRoom"."bookingId"
    )
WHERE "roomClassStatus" IS NULL;
