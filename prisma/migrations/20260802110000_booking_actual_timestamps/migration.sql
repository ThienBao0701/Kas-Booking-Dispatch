-- ===========================================================================
-- KAS — actual operational timestamps on a booking
--
-- ADDITIVE ONLY. Nine nullable columns and four foreign keys on an existing
-- table. Nothing is dropped, renamed, re-typed or back-filled, and no existing
-- column changes meaning. Every existing row reads NULL for all of them, which
-- is exactly right: those bookings were never received, checked in or checked
-- out through this workflow.
--
-- WHY THESE ARE NEW COLUMNS RATHER THAN REUSED ONES:
-- `checkInDate` / `checkOutDate` are what the OTA RESERVATION EXPECTS. The
-- columns added here are what ACTUALLY happened, recorded by the receptionist.
-- Overloading the reservation dates would erase the difference between "the
-- reservation says the guest arrives today" and "the guest arrived" — and with
-- it any way to detect a no-show, a late arrival or an early departure. They
-- are therefore kept strictly separate.
--
-- The enum labels these columns accompany were added in the PRECEDING
-- migration, because a new enum label may not be used in the transaction that
-- adds it. Nothing here writes a status value, so the two files are safe in
-- either order, but they are kept apart to preserve that rule.
--
-- IF NOT EXISTS makes every statement idempotent, so re-running
-- `migrate deploy` against a database that already has them is a no-op.
--
-- ROLLBACK: dropping these columns is safe for an older application build,
-- which neither reads nor writes them. Because they are nullable and never
-- back-filled, an older release runs unchanged against this schema with no
-- rollback required at all.
-- ===========================================================================

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "receivedByUserId" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "actualCheckInAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "checkedInByUserId" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "actualCheckOutAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "checkedOutByUserId" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancelledByUserId" INTEGER;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;

-- The actor references match the existing sentBy / completedBy pattern:
-- ON DELETE SET NULL, so removing a user never removes operational history.
DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_receivedByUserId_fkey"
    FOREIGN KEY ("receivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_checkedInByUserId_fkey"
    FOREIGN KEY ("checkedInByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_checkedOutByUserId_fkey"
    FOREIGN KEY ("checkedOutByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Booking" ADD CONSTRAINT "Booking_cancelledByUserId_fkey"
    FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
