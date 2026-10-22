-- ===========================================================================
-- KAS — operational booking states
--
-- ADDITIVE ONLY. Five new members on an existing enum. No table is created,
-- redefined or dropped, no column is altered, and no row is written, deleted
-- or rewritten. Every existing Booking row keeps its exact status.
--
-- NOTHING IS REDEFINED:
-- DRAFT, READY, NEW, COMPLETED and ARCHIVED keep the meanings they have today.
-- In particular NEW still means "dispatched, awaiting the branch" — it is NOT
-- being repurposed as a pre-review state. Booking.com continues to run
-- DRAFT -> READY -> NEW -> COMPLETED -> ARCHIVED and never enters the states
-- added here, so its behaviour is unchanged.
--
-- The operational path is NEW -> RECEIVED -> CHECKED_IN -> CHECKED_OUT ->
-- COMPLETED. Proof approval remains an INDEPENDENT workflow and is not
-- redefined by these states.
--
-- WHY THIS IS ITS OWN MIGRATION FILE:
-- PostgreSQL allows ALTER TYPE ... ADD VALUE inside a transaction block (12+),
-- but the newly added label may NOT be used until that transaction commits.
-- Prisma runs each migration file in one transaction, so an enum addition must
-- never share a file with a statement that uses it. This file therefore adds
-- the labels and does nothing else; the application only writes them at
-- runtime, long after the migration has committed. The columns that accompany
-- this feature are added in the NEXT migration for the same reason.
--
-- IF NOT EXISTS makes each statement idempotent, so re-running `migrate deploy`
-- against a database that already has them is a no-op rather than an error.
--
-- ROLLBACK: PostgreSQL cannot remove a value from an enum type. Rolling this
-- back means rolling back the APPLICATION only — the extra labels are inert to
-- a build that never writes them, so an older release runs unchanged against
-- this schema. No backup restore is required for that direction. (If bookings
-- have already reached one of these states, an older build cannot render them;
-- that is a data question for the operator, not something a migration decides.)
-- ===========================================================================

ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CHECKED_IN';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CHECKED_OUT';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'NO_SHOW';
