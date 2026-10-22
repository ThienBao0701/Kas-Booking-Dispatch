-- ===========================================================================
-- KAS — D.1 concurrency hardening
--
-- The baseline migration reproduces exactly what the SQLite pilot had. This
-- one adds what moving to PostgreSQL — and to genuinely concurrent writers
-- across eight branches — makes necessary.
--
-- Both invariants below were previously "enforced by the service". That was
-- adequate under SQLite, which serialises every writer, so a read-then-write
-- sequence inside one process could not interleave with another's. PostgreSQL
-- runs those writers in parallel, so an application-only rule is no longer a
-- rule at all (D.1 §6: "Do not rely only on application validation for
-- critical uniqueness").
--
-- ADDITIVE ONLY: no table is redefined, no column is dropped, no row is
-- deleted or rewritten.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- INVARIANT: exactly one PRIMARY guest per booking.
--
-- THE RACE THIS CLOSES: `setPrimaryGuest` clears the current primary and then
-- promotes the chosen guest. Two Admins promoting two different guests at the
-- same moment both clear (seeing the pre-update snapshot under READ
-- COMMITTED), then both promote — leaving a booking with two primary guests
-- and a `Booking.customerName` mirror that matches neither reliably.
--
-- With this index the second transaction fails on commit of its promotion and
-- rolls back whole, so the booking keeps exactly one primary guest and the
-- audit trail keeps exactly one BOOKING_PRIMARY_GUEST_CHANGED event.
--
-- The clear-then-promote order inside the existing transaction is what keeps
-- the WINNER from tripping the index on itself.
CREATE UNIQUE INDEX "BookingGuest_one_primary_per_booking"
  ON "BookingGuest"("bookingId")
  WHERE "isPrimary";

-- ---------------------------------------------------------------------------
-- INVARIANT: no two OPERATIONAL bookings share (code, branch, check-in date).
--
-- THE RACE THIS CLOSES: `sendBooking` already refuses to dispatch a booking
-- when a matching operational one exists — but it checks with a SELECT and
-- then dispatches, so two Admins dispatching the same reservation to the same
-- branch at the same instant both find nothing and both succeed. A branch then
-- receives the same guest twice.
--
-- This index enforces exactly the rule the application already states; it does
-- not invent a new one. In particular it deliberately does NOT make
-- `bookingCode` globally unique: DRAFT/READY rows are excluded entirely, so an
-- Admin can still extract the same code twice and be warned rather than
-- blocked, which is the documented behaviour of the extraction flow.
--
-- `checkInDate` is nullable and PostgreSQL treats NULLs as distinct, so rows
-- without a check-in date are not constrained. That matches the application:
-- `sendBooking` validates a check-in date before a booking may be dispatched.
--
-- CUTOVER PRE-CHECK: if the live pilot database already contains duplicate
-- operational bookings this statement FAILS and the migration stops. That is
-- deliberate — such rows are an operational problem a human must resolve, not
-- something a migration may silently delete or merge. `npm.cmd run d1:verify`
-- reports them before any cutover is attempted.
CREATE UNIQUE INDEX "Booking_one_operational_per_code_branch_checkin"
  ON "Booking"("bookingCode", "branchId", "checkInDate")
  WHERE "status" IN ('NEW', 'COMPLETED', 'ARCHIVED');
