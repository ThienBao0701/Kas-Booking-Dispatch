-- ===========================================================================
-- KAS — PostgreSQL 17 BASELINE (Phase D.1)
--
-- This is a FRESH baseline, not a translation of the SQLite pilot history.
-- The eleven SQLite migrations under prisma/legacy-sqlite/migrations are never
-- executed against PostgreSQL: they use SQLite's table-rebuild idiom
-- (PRAGMA defer_foreign_keys + CREATE new_X / DROP TABLE X / RENAME), which
-- PostgreSQL cannot parse and which would destroy data if it could.
--
-- Applying this single file to a COMPLETELY EMPTY PostgreSQL database yields
-- the exact schema the application expects:
--     npm.cmd run db:migrate           (prisma migrate deploy)
--
-- It is deterministic: re-generating it from prisma/schema.prisma with
--     prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- reproduces everything below the "GENERATED" line byte for byte.
--
-- Data is NOT part of this migration. Moving the SQLite pilot's rows across is
-- a separate, explicit, reversible step (npm.cmd run d1:transfer), because a
-- storage migration must never silently re-interpret business data.
-- ===========================================================================

-- ============================ GENERATED ====================================
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RECEPTIONIST');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'READY', 'NEW', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAY_BEFORE', 'PAY_AFTER');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('BOOKING_COM', 'AGODA');

-- CreateEnum
CREATE TYPE "BookingBusinessType" AS ENUM ('DIRECT', 'PARTNER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProofAnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProofComparisonOverallStatus" AS ENUM ('MATCH', 'WARNING', 'MISMATCH', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ProofReviewReason" AS ENUM ('WRONG_CUSTOMER_NAME', 'WRONG_BOOKING_CODE', 'WRONG_DATES', 'WRONG_ROOM_COUNT', 'WRONG_ROOM_TYPE', 'WRONG_PRICE', 'MISSING_ROOM', 'UNCLEAR_IMAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "BranchAliasSource" AS ENUM ('BOOKING_COM', 'AGODA', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "BranchAliasMatchMode" AS ENUM ('EXACT', 'SIMILARITY');

-- CreateEnum
CREATE TYPE "BranchChangeAction" AS ENUM ('BRANCH_CREATED', 'BRANCH_NUMBER_CHANGED', 'BRANCH_NAME_CHANGED', 'BRANCH_ADDRESS_CHANGED', 'BRANCH_BREAKFAST_CHANGED', 'BRANCH_CONTACT_CHANGED', 'BRANCH_ACTIVATED', 'BRANCH_DEACTIVATED', 'ALIAS_ADDED', 'ALIAS_RENAMED', 'ALIAS_ENABLED', 'ALIAS_DISABLED', 'ALIAS_REMOVED', 'ROOM_MAPPING_DRAFT_CREATED', 'ROOM_MAPPING_DRAFT_CANCELLED', 'ROOM_CLASS_ADDED', 'ROOM_CLASS_UPDATED', 'ROOM_CLASS_DEACTIVATED', 'ROOM_CLASS_REORDERED', 'ROOM_CLASS_ALIAS_ADDED', 'ROOM_CLASS_ALIAS_REMOVED', 'ROOM_MAPPING_VALIDATED', 'ROOM_MAPPING_ACTIVATED', 'ROOM_MAPPING_ACTIVATION_FAILED');

-- CreateEnum
CREATE TYPE "RoomMappingVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RoomClassAliasSource" AS ENUM ('SEED', 'ADMIN', 'PARSER');

-- CreateEnum
CREATE TYPE "RoomClassResolutionStatus" AS ENUM ('RESOLVED', 'MANUAL', 'UNRESOLVED', 'LEGACY');

-- CreateEnum
CREATE TYPE "BookingAuditAction" AS ENUM ('BOOKING_GUEST_ADDED', 'BOOKING_GUEST_UPDATED', 'BOOKING_GUEST_REMOVED', 'BOOKING_PRIMARY_GUEST_CHANGED', 'BOOKING_ROOM_MAPPING_REAPPLIED');

-- CreateEnum
CREATE TYPE "WarningSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('DOOR', 'AIR_CONDITIONER', 'TOILET', 'TV', 'WIFI', 'ELECTRICITY', 'WATER', 'FURNITURE', 'HOUSEKEEPING', 'GUEST_REQUEST', 'OTHER');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "branchId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "userId" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoDataBatch" (
    "id" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoDataBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" SERIAL NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchRoomMappingVersion" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "RoomMappingVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" INTEGER,
    "activatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "changeReason" TEXT,

    CONSTRAINT "BranchRoomMappingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchRoomClass" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "versionId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "pmsCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchRoomClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchRoomClassAlias" (
    "id" TEXT NOT NULL,
    "roomClassId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "source" "RoomClassAliasSource" NOT NULL DEFAULT 'SEED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchRoomClassAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingGuest" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAuditEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "action" "BookingAuditAction" NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "reason" TEXT,
    "actorUserId" INTEGER,
    "actorRole" "UserRole",
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchSourceAlias" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER NOT NULL,
    "source" "BranchAliasSource" NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "matchMode" "BranchAliasMatchMode" NOT NULL DEFAULT 'EXACT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchSourceAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchChangeLog" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "action" "BranchChangeAction" NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedByUserId" INTEGER,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "bookingCode" TEXT NOT NULL,
    "hotelName" TEXT,
    "branchId" INTEGER,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "sourcePlatform" "BookingSource" NOT NULL DEFAULT 'BOOKING_COM',
    "businessType" "BookingBusinessType" NOT NULL DEFAULT 'UNKNOWN',
    "businessTypeConfidence" INTEGER,
    "businessTypeDetectionSource" TEXT,
    "businessTypeManuallyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "checkInDate" TIMESTAMP(3),
    "checkInTime" TEXT,
    "checkOutDate" TIMESTAMP(3),
    "checkOutTime" TEXT,
    "totalAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "paymentStatus" "PaymentStatus" NOT NULL,
    "specialRequest" TEXT,
    "rawText" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "isLastMinute" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "sentByUserId" INTEGER,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" INTEGER,
    "completionNote" TEXT,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "parserVersion" TEXT,
    "createdByUserId" INTEGER,
    "noteGeneratedAt" TIMESTAMP(3),
    "noteVersion" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingCreationProof" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "storedFileName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "submissionNote" TEXT,
    "submittedByUserId" INTEGER,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ProofStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewReasonCode" "ProofReviewReason",
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingCreationProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingProofAnalysis" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "status" "ProofAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractedDataJson" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingProofAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingProofComparison" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "overallStatus" "ProofComparisonOverallStatus" NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingProofComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRoom" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "roomIndex" INTEGER NOT NULL,
    "roomType" TEXT,
    "roomSubtotal" INTEGER,
    "taxAmount" INTEGER,
    "feeAmount" INTEGER,
    "roomClassId" TEXT,
    "roomClassVersionId" TEXT,
    "roomClassBranchId" INTEGER,
    "roomClassDisplayName" TEXT,
    "roomClassPmsCode" TEXT,
    "roomClassSourceText" TEXT,
    "roomClassStatus" "RoomClassResolutionStatus",
    "roomClassResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingNightPrice" (
    "id" TEXT NOT NULL,
    "bookingRoomId" TEXT NOT NULL,
    "stayDate" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "manuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "isEstimated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingNightPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingExtractWarning" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "WarningSeverity" NOT NULL DEFAULT 'WARNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingExtractWarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingStatusHistory" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "oldStatus" "BookingStatus",
    "newStatus" "BookingStatus" NOT NULL,
    "changedByUserId" INTEGER,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "BookingStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "bookingId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelIssue" (
    "id" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "roomNumber" TEXT,
    "category" "IssueCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "photoStoredName" TEXT,
    "photoMimeType" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'NEW',
    "reportedByUserId" INTEGER NOT NULL,
    "acceptedByUserId" INTEGER,
    "resolvedByUserId" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_branchId_idx" ON "User"("branchId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

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

-- CreateIndex
CREATE INDEX "Booking_bookingCode_idx" ON "Booking"("bookingCode");

-- CreateIndex
CREATE INDEX "Booking_branchId_status_idx" ON "Booking"("branchId", "status");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "Booking_branchId_verificationStatus_idx" ON "Booking"("branchId", "verificationStatus");

-- CreateIndex
CREATE INDEX "Booking_verificationStatus_idx" ON "Booking"("verificationStatus");

-- CreateIndex
CREATE INDEX "Booking_sourcePlatform_idx" ON "Booking"("sourcePlatform");

-- CreateIndex
CREATE INDEX "Booking_businessType_idx" ON "Booking"("businessType");

-- CreateIndex
CREATE INDEX "Booking_sentAt_idx" ON "Booking"("sentAt");

-- CreateIndex
CREATE INDEX "Booking_checkInDate_idx" ON "Booking"("checkInDate");

-- CreateIndex
CREATE INDEX "Booking_isLastMinute_idx" ON "Booking"("isLastMinute");

-- CreateIndex
CREATE INDEX "Booking_customerName_idx" ON "Booking"("customerName");

-- CreateIndex
CREATE INDEX "Booking_phone_idx" ON "Booking"("phone");

-- CreateIndex
CREATE INDEX "Booking_isDemo_idx" ON "Booking"("isDemo");

-- CreateIndex
CREATE INDEX "Booking_demoBatchId_idx" ON "Booking"("demoBatchId");

-- CreateIndex
CREATE INDEX "BookingCreationProof_bookingId_idx" ON "BookingCreationProof"("bookingId");

-- CreateIndex
CREATE INDEX "BookingCreationProof_status_idx" ON "BookingCreationProof"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreationProof_bookingId_attemptNumber_key" ON "BookingCreationProof"("bookingId", "attemptNumber");

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_proofId_idx" ON "BookingProofAnalysis"("proofId");

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_proofId_status_idx" ON "BookingProofAnalysis"("proofId", "status");

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_createdAt_idx" ON "BookingProofAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "BookingProofComparison_proofId_idx" ON "BookingProofComparison"("proofId");

-- CreateIndex
CREATE INDEX "BookingProofComparison_bookingId_idx" ON "BookingProofComparison"("bookingId");

-- CreateIndex
CREATE INDEX "BookingProofComparison_createdAt_idx" ON "BookingProofComparison"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingProofComparison_analysisId_comparisonVersion_key" ON "BookingProofComparison"("analysisId", "comparisonVersion");

-- CreateIndex
CREATE INDEX "BookingRoom_bookingId_idx" ON "BookingRoom"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRoom_bookingId_roomIndex_key" ON "BookingRoom"("bookingId", "roomIndex");

-- CreateIndex
CREATE INDEX "BookingNightPrice_bookingRoomId_idx" ON "BookingNightPrice"("bookingRoomId");

-- CreateIndex
CREATE INDEX "BookingNightPrice_stayDate_idx" ON "BookingNightPrice"("stayDate");

-- CreateIndex
CREATE UNIQUE INDEX "BookingNightPrice_bookingRoomId_stayDate_key" ON "BookingNightPrice"("bookingRoomId", "stayDate");

-- CreateIndex
CREATE INDEX "BookingExtractWarning_bookingId_idx" ON "BookingExtractWarning"("bookingId");

-- CreateIndex
CREATE INDEX "BookingExtractWarning_code_idx" ON "BookingExtractWarning"("code");

-- CreateIndex
CREATE INDEX "BookingStatusHistory_bookingId_idx" ON "BookingStatusHistory"("bookingId");

-- CreateIndex
CREATE INDEX "BookingStatusHistory_changedAt_idx" ON "BookingStatusHistory"("changedAt");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_isDemo_idx" ON "Notification"("isDemo");

-- CreateIndex
CREATE INDEX "HotelIssue_branchId_status_idx" ON "HotelIssue"("branchId", "status");

-- CreateIndex
CREATE INDEX "HotelIssue_status_idx" ON "HotelIssue"("status");

-- CreateIndex
CREATE INDEX "HotelIssue_createdAt_idx" ON "HotelIssue"("createdAt");

-- CreateIndex
CREATE INDEX "HotelIssue_reportedByUserId_idx" ON "HotelIssue"("reportedByUserId");

-- CreateIndex
CREATE INDEX "HotelIssue_isDemo_idx" ON "HotelIssue"("isDemo");

-- CreateIndex
CREATE INDEX "HotelIssue_demoBatchId_idx" ON "HotelIssue"("demoBatchId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomMappingVersion" ADD CONSTRAINT "BranchRoomMappingVersion_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomMappingVersion" ADD CONSTRAINT "BranchRoomMappingVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomMappingVersion" ADD CONSTRAINT "BranchRoomMappingVersion_activatedByUserId_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomClass" ADD CONSTRAINT "BranchRoomClass_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomClass" ADD CONSTRAINT "BranchRoomClass_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BranchRoomMappingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchRoomClassAlias" ADD CONSTRAINT "BranchRoomClassAlias_roomClassId_fkey" FOREIGN KEY ("roomClassId") REFERENCES "BranchRoomClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAuditEvent" ADD CONSTRAINT "BookingAuditEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAuditEvent" ADD CONSTRAINT "BookingAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchSourceAlias" ADD CONSTRAINT "BranchSourceAlias_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchChangeLog" ADD CONSTRAINT "BranchChangeLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchChangeLog" ADD CONSTRAINT "BranchChangeLog_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreationProof" ADD CONSTRAINT "BookingCreationProof_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreationProof" ADD CONSTRAINT "BookingCreationProof_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreationProof" ADD CONSTRAINT "BookingCreationProof_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProofAnalysis" ADD CONSTRAINT "BookingProofAnalysis_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "BookingCreationProof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProofComparison" ADD CONSTRAINT "BookingProofComparison_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProofComparison" ADD CONSTRAINT "BookingProofComparison_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "BookingCreationProof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProofComparison" ADD CONSTRAINT "BookingProofComparison_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "BookingProofAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRoom" ADD CONSTRAINT "BookingRoom_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingNightPrice" ADD CONSTRAINT "BookingNightPrice_bookingRoomId_fkey" FOREIGN KEY ("bookingRoomId") REFERENCES "BookingRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingExtractWarning" ADD CONSTRAINT "BookingExtractWarning_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStatusHistory" ADD CONSTRAINT "BookingStatusHistory_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStatusHistory" ADD CONSTRAINT "BookingStatusHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelIssue" ADD CONSTRAINT "HotelIssue_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================= HAND-WRITTEN INVARIANTS ===========================
-- Everything below this line is NOT expressible in the Prisma schema language
-- and is therefore maintained here deliberately. Re-generating the block above
-- must never delete it.
-- ===========================================================================

-- C.3.8 INVARIANT: a branch may never have two ACTIVE room-mapping versions.
--
-- Carried over verbatim in meaning from the SQLite pilot
-- (prisma/legacy-sqlite/migrations/20260728093914_c38_branch_room_class_versioning).
-- PostgreSQL partial unique indexes are strictly stronger here than SQLite's
-- were: under genuinely concurrent activations from two Admin sessions the
-- second INSERT/UPDATE blocks on the index and then fails, so the loser rolls
-- back instead of producing a second ACTIVE row. The activation transaction in
-- roomMappingService.activateDraft archives before it promotes precisely so
-- that the winner never trips this index itself.
--
-- The predicate compares against the enum type, not a bare string literal.
CREATE UNIQUE INDEX "BranchRoomMappingVersion_one_active_per_branch"
  ON "BranchRoomMappingVersion"("branchId")
  WHERE "status" = 'ACTIVE'::"RoomMappingVersionStatus";