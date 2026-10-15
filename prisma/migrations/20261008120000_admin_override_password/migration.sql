-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountAuditAction" ADD VALUE 'ADMIN_OVERRIDE_LOGIN';
ALTER TYPE "AccountAuditAction" ADD VALUE 'ADMIN_OVERRIDE_SET';
ALTER TYPE "AccountAuditAction" ADD VALUE 'ADMIN_OVERRIDE_CLEARED';

-- CreateTable
CREATE TABLE "AdminOverrideCredential" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "passwordHash" TEXT NOT NULL,
    "setByUserId" INTEGER NOT NULL,
    "setByNameSnapshot" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminOverrideCredential_pkey" PRIMARY KEY ("id"),
    -- At most one override password, ever: the row is always id 1.
    CONSTRAINT "AdminOverrideCredential_singleton" CHECK ("id" = 1)
);

-- AddForeignKey
ALTER TABLE "AdminOverrideCredential" ADD CONSTRAINT "AdminOverrideCredential_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
