-- ===========================================================================
-- KAS — proof-lifecycle audit actions
--
-- ADDITIVE ONLY. Three new members on an existing enum; no table is created,
-- redefined or dropped, no column is altered, and no row is written, deleted
-- or rewritten. Every existing BookingAuditEvent row keeps its exact value.
--
-- WHY THIS IS ITS OWN MIGRATION FILE:
-- PostgreSQL allows ALTER TYPE ... ADD VALUE inside a transaction block (12+),
-- but the newly added label may NOT be used until that transaction commits.
-- Prisma runs each migration file in one transaction, so an enum addition must
-- never share a file with a statement that uses it. This file therefore adds
-- the labels and does nothing else; the application only ever writes them at
-- runtime, long after the migration has committed.
--
-- IF NOT EXISTS makes the statements idempotent, so re-running `migrate deploy`
-- against a database that already has them is a no-op rather than an error.
--
-- ROLLBACK: PostgreSQL cannot remove a value from an enum type. Rolling this
-- back therefore means rolling back the APPLICATION only — the extra labels are
-- inert for a build that never writes them, so an older release runs unchanged
-- against this schema. No backup restore is required for that direction.
-- ===========================================================================

ALTER TYPE "BookingAuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_PROOF_SUBMITTED';
ALTER TYPE "BookingAuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_PROOF_APPROVED';
ALTER TYPE "BookingAuditAction" ADD VALUE IF NOT EXISTS 'BOOKING_PROOF_REJECTED';
