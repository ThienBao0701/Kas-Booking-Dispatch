-- ===========================================================================
-- KAS — removing a booking from the queues without destroying what happened
--
-- ADDITIVE ONLY. Two nullable columns and one index on Booking. Nothing is
-- dropped, renamed, re-typed or back-filled. Every existing booking reads NULL,
-- which is correct: none of them has been deleted.
--
-- WHY SOFT DELETE, AND NOT `DELETE FROM "Booking"`:
--
-- 25 relations cascade from Booking. A row deletion would take with it
-- BookingAuditEvent, BookingCorrection (which is append-only by design),
-- BookingStatusHistory, BookingCreationProof and the uploaded proof images,
-- BookingGuest, BookingRoom, BookingExtractWarning and BookingProofComparison.
--
-- Those are precisely the records that prove what happened — who dispatched a
-- reservation, what a branch was told, what an Admin corrected and what the
-- receptionist submitted as evidence that they created it. A hotel deleting a
-- booking wants it gone from the queues; it does not want the only proof that
-- a branch did its job to disappear with it, and nobody would notice until the
-- day that proof was needed.
--
-- So the row stays and every operational query filters `deletedAt IS NULL`.
-- The booking vanishes from reception, history and search; the audit trail is
-- untouched and still reachable.
--
-- `deletedByUserId` is nullable and ON DELETE SET NULL by Prisma's default for
-- an optional relation: removing a user account must not remove the record that
-- a deletion happened.
-- ===========================================================================

ALTER TABLE "Booking" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "deletedByUserId" INTEGER;

-- Every operational list filters on this, so it is indexed rather than scanned.
CREATE INDEX "Booking_deletedAt_idx" ON "Booking"("deletedAt");

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_deletedByUserId_fkey"
  FOREIGN KEY ("deletedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
