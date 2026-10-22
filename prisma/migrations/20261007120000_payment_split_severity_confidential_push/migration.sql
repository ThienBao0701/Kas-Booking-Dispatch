-- Payment split, issue severity, confidential upward reports, Web Push and the
-- password-reset audit. ADDITIVE ONLY: new enums, new nullable columns, new
-- tables, indexes, foreign keys and one CHECK. Nothing is dropped, renamed or
-- rewritten; every existing row keeps its values (older payments keep their
-- allocation columns NULL and are read as `amount` under `method`; older
-- requests, complaints and incidents keep severity NULL — "Chưa phân mức").

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('TECHNICAL_ASSIGNED', 'HOUSEKEEPING_ASSIGNED', 'HOUSEKEEPING_RECLEAN');

-- CreateEnum
CREATE TYPE "ConfidentialReportCategory" AS ENUM ('WORK_ENVIRONMENT', 'PROCESS_RULES', 'COLLEAGUES', 'OTHER_IMPORTANT');

-- CreateEnum
CREATE TYPE "AccountAuditAction" AS ENUM ('PASSWORD_RESET');

-- AlterTable
ALTER TABLE "CustomerComplaintReport" ADD COLUMN     "severity" "IssueSeverity";

-- AlterTable
ALTER TABLE "GuestRequestReport" ADD COLUMN     "severity" "IssueSeverity";

-- AlterTable
ALTER TABLE "HotelIssue" ADD COLUMN     "severity" "IssueSeverity";

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "kind" "NotificationKind",
ADD COLUMN     "link" TEXT,
ADD COLUMN     "pushedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReceptionPayment" ADD COLUMN     "cardAmount" INTEGER,
ADD COLUMN     "cashAmount" INTEGER,
ADD COLUMN     "debtAmount" INTEGER,
ADD COLUMN     "transferAmount" INTEGER;

-- CreateTable
CREATE TABLE "ConfidentialReport" (
    "id" TEXT NOT NULL,
    "senderUserId" INTEGER NOT NULL,
    "senderNameSnapshot" TEXT NOT NULL,
    "senderRole" "UserRole" NOT NULL,
    "senderBranchId" INTEGER,
    "category" "ConfidentialReportCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidentialReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfidentialReportRecipient" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ConfidentialReportRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAudit" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "action" "AccountAuditAction" NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConfidentialReport_createdAt_idx" ON "ConfidentialReport"("createdAt");

-- CreateIndex
CREATE INDEX "ConfidentialReport_senderUserId_idx" ON "ConfidentialReport"("senderUserId");

-- CreateIndex
CREATE INDEX "ConfidentialReportRecipient_userId_readAt_idx" ON "ConfidentialReportRecipient"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConfidentialReportRecipient_reportId_userId_key" ON "ConfidentialReportRecipient"("reportId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "AccountAudit_userId_createdAt_idx" ON "AccountAudit"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- AddForeignKey
ALTER TABLE "ConfidentialReport" ADD CONSTRAINT "ConfidentialReport_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfidentialReport" ADD CONSTRAINT "ConfidentialReport_senderBranchId_fkey" FOREIGN KEY ("senderBranchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfidentialReportRecipient" ADD CONSTRAINT "ConfidentialReportRecipient_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ConfidentialReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfidentialReportRecipient" ADD CONSTRAINT "ConfidentialReportRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAudit" ADD CONSTRAINT "AccountAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAudit" ADD CONSTRAINT "AccountAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One transaction, several methods: either no allocation at all (a row from
-- before split payments) or all four, none negative, summing to the total.
-- Summed as BIGINT so an out-of-range sum fails the check, not the arithmetic.
ALTER TABLE "ReceptionPayment" ADD CONSTRAINT "ReceptionPayment_allocations_balance" CHECK (
  ("cashAmount" IS NULL AND "transferAmount" IS NULL AND "cardAmount" IS NULL AND "debtAmount" IS NULL)
  OR (
    "cashAmount" IS NOT NULL AND "transferAmount" IS NOT NULL AND "cardAmount" IS NOT NULL AND "debtAmount" IS NOT NULL
    AND "cashAmount" >= 0 AND "transferAmount" >= 0 AND "cardAmount" >= 0 AND "debtAmount" >= 0
    AND "cashAmount"::BIGINT + "transferAmount" + "cardAmount" + "debtAmount" = "amount"
  )
);
