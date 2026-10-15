-- ===========================================================================
-- KAS — branch platform identities (one current hotel name per platform)
--
-- ADDITIVE ONLY. Two new tables and two new enum TYPES. Nothing existing is
-- altered: `BranchSourceAlias` keeps every row, every column and every index,
-- so this migration is reversible by dropping the new objects alone and an
-- older application build runs unchanged against this schema.
--
-- NO DATA IS WRITTEN HERE. Populating the identities from the legacy aliases
-- (and applying the operator-supplied Booking.com names) is a separate,
-- idempotent, testable seed step — `seedPlatformIdentities` — because a data
-- migration that has to CHOOSE between competing historical values must be
-- observable and re-runnable, not buried in DDL.
--
-- New enum TYPES are created here rather than new VALUES on an existing type,
-- so the PostgreSQL restriction that a freshly added enum label cannot be used
-- in the same transaction does not apply.
--
-- THE TWO CONSTRAINTS THAT CARRY THE SAFETY MODEL:
--   BranchPlatformIdentity_branchId_platform_key
--       one current identity per (branch, platform) — a second create cannot
--       silently coexist with the first.
--   BranchPlatformIdentity_platform_normalizedName_key
--       a normalised name resolves to exactly ONE branch on a platform — two
--       concurrent requests cannot both claim the same hotel name, so a
--       booking can never route two ways.
-- Both are enforced by the database, not by application checks, because two
-- application writers under READ COMMITTED can interleave a check and a write.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "OtaPlatform" AS ENUM ('BOOKING_COM', 'AGODA', 'CTRIP', 'TRIPADVISOR', 'TRAVELOKA');

-- CreateEnum
CREATE TYPE "PlatformIdentityAction" AS ENUM ('IDENTITY_CREATED', 'IDENTITY_UPDATED', 'IDENTITY_DELETED', 'IDENTITY_MIGRATED', 'IDENTITY_CONFIRMED');

-- CreateTable
CREATE TABLE "BranchPlatformIdentity" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "platform" "OtaPlatform" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "identityNeedsConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" INTEGER,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchPlatformIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchPlatformIdentityEvent" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "platform" "OtaPlatform" NOT NULL,
    "action" "PlatformIdentityAction" NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "actorUserId" INTEGER,
    "actorRole" "UserRole",
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchPlatformIdentityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BranchPlatformIdentity_branchId_platform_key" ON "BranchPlatformIdentity"("branchId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "BranchPlatformIdentity_platform_normalizedName_key" ON "BranchPlatformIdentity"("platform", "normalizedName");

-- CreateIndex
CREATE INDEX "BranchPlatformIdentity_platform_normalizedName_idx" ON "BranchPlatformIdentity"("platform", "normalizedName");

-- CreateIndex
CREATE INDEX "BranchPlatformIdentity_branchId_idx" ON "BranchPlatformIdentity"("branchId");

-- CreateIndex
CREATE INDEX "BranchPlatformIdentityEvent_branchId_createdAt_idx" ON "BranchPlatformIdentityEvent"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "BranchPlatformIdentityEvent_platform_createdAt_idx" ON "BranchPlatformIdentityEvent"("platform", "createdAt");

-- CreateIndex
CREATE INDEX "BranchPlatformIdentityEvent_action_idx" ON "BranchPlatformIdentityEvent"("action");

-- AddForeignKey
ALTER TABLE "BranchPlatformIdentity" ADD CONSTRAINT "BranchPlatformIdentity_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPlatformIdentityEvent" ADD CONSTRAINT "BranchPlatformIdentityEvent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPlatformIdentityEvent" ADD CONSTRAINT "BranchPlatformIdentityEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
