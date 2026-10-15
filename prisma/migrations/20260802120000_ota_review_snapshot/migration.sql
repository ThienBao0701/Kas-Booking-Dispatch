-- ===========================================================================
-- KAS — the OTA review snapshot on a booking
--
-- ADDITIVE ONLY. Ten nullable columns on an existing table and one new table.
-- Nothing is dropped, renamed, re-typed or back-filled, and no existing column
-- changes meaning. Every existing row reads NULL for the new columns and owns
-- no correction rows, which is exactly right: those bookings were never
-- reviewed through the OTA screen.
--
-- BOOKING.COM IS UNAFFECTED. Every column here is written only by the OTA
-- dispatch path; a Booking.com booking leaves all of them NULL and behaves
-- exactly as it does today.
--
-- WHY `otaBookingStatus` IS NOT THE `status` COLUMN:
-- it is the PLATFORM's word for the reservation (CONFIRMED / AMENDED /
-- CANCELLED). The `status` column is this system's operational lifecycle.
-- They answer different questions and are deliberately stored apart, exactly
-- as the reservation's expected dates are stored apart from the actual ones.
--
-- WHY A SHA-256 AND NOT ANOTHER COPY OF THE BODY:
-- `rawText` already holds the pasted text once. The hash lets two dispatches of
-- the same mail be recognised as the same source without storing the body a
-- second time.
--
-- BookingCorrection is APPEND-ONLY by intent: rows are written once at dispatch
-- and never updated or deleted, so the parser's original reading survives even
-- if the booking is edited later. No UPDATE or DELETE grant is implied here;
-- the application simply never issues one.
--
-- IF NOT EXISTS makes every statement idempotent, so re-running
-- `migrate deploy` against a database that already has them is a no-op.
--
-- ROLLBACK: dropping these is safe for an older application build, which
-- neither reads nor writes them. Because the columns are nullable and never
-- back-filled, an older release runs unchanged against this schema with no
-- rollback required at all.
-- ===========================================================================

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "sourcePropertyId" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "otaBookingStatus" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "ratePlanName" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationPolicy" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "countryOfResidence" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "websiteLanguage" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentType" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "benefitsIncluded" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reviewVersion" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "rawTextSha256" TEXT;

CREATE TABLE IF NOT EXISTS "BookingCorrection" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "correctedByUserId" INTEGER,
    "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BookingCorrection_bookingId_idx" ON "BookingCorrection"("bookingId");
CREATE INDEX IF NOT EXISTS "BookingCorrection_correctedAt_idx" ON "BookingCorrection"("correctedAt");

-- Deleting a booking removes its corrections; removing a USER never removes
-- history, matching how every other actor reference on Booking behaves.
DO $$ BEGIN
  ALTER TABLE "BookingCorrection" ADD CONSTRAINT "BookingCorrection_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BookingCorrection" ADD CONSTRAINT "BookingCorrection_correctedByUserId_fkey"
    FOREIGN KEY ("correctedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
