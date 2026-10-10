-- Operational uniqueness ignores WITHDRAWN bookings.
--
-- WHAT WAS WRONG
--
-- `Booking_one_operational_per_code_branch_checkin` was created in
-- 20260731010000_d1_concurrency_hardening to close a race: two Admins
-- dispatching the same reservation to the same branch at the same instant both
-- pass the application's SELECT and both insert. Its stated contract, in that
-- migration's own words, is that it "enforces exactly the rule the application
-- already states; it does not invent a new one."
--
-- The rule it mirrored was incomplete, in both places. Soft delete writes
-- `deletedAt` and NOTHING ELSE — the status stays exactly as it was — so an
-- order an Admin withdrew is still 'NEW' on the row and still inside this
-- index. Sending the same reservation again was refused because of a booking
-- that is in no queue, on no screen and in front of no receptionist.
--
-- WHY THE PREDICATE, AND NOT SOMETHING ELSE
--
-- There is no application-level way around a unique index: it physically
-- forbids the row. The alternatives were to hard-delete the withdrawn booking
-- (destroying the history soft delete exists to keep) or to move it out of the
-- index by changing its status (rewriting a historical record, and breaking the
-- `deletedAt IS NOT NULL` condition `redispatchDeletedBooking` depends on).
-- Narrowing the index is the only change that leaves history alone.
--
-- WHAT IS PRESERVED
--
-- The race this index closes is closed exactly as before: two concurrent
-- dispatches of the same live reservation still collide, because both rows
-- would have `deletedAt IS NULL`. DRAFT/READY are still excluded. `checkInDate`
-- is still nullable and PostgreSQL still treats NULLs as distinct.
--
-- SAFETY
--
-- The new predicate is strictly NARROWER than the old one — every row it
-- covers, the old index covered too. Recreating it therefore cannot fail on
-- data that already satisfied the existing constraint.
DROP INDEX IF EXISTS "Booking_one_operational_per_code_branch_checkin";

CREATE UNIQUE INDEX "Booking_one_operational_per_code_branch_checkin"
  ON "Booking"("bookingCode", "branchId", "checkInDate")
  WHERE "status" IN ('NEW', 'COMPLETED', 'ARCHIVED') AND "deletedAt" IS NULL;
