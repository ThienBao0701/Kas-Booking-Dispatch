-- ===========================================================================
-- KAS — where a booking change came from
--
-- ADDITIVE ONLY. One new table, one nullable column on each of two existing
-- history tables, and two columns on Booking. Nothing is dropped, renamed,
-- re-typed or back-filled. Every existing history row reads NULL for its
-- context, which is honest: those changes were made before this was recorded.
--
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON EACH HISTORY ROW:
-- one request produces MANY history rows — a dispatch writes a status row and
-- several correction rows. Copying the IP, user agent, session and correlation
-- id onto each would duplicate the same four values across every audit table in
-- the system, and every table added later would have to remember to carry them.
-- One row per REQUEST, referenced by whatever it caused.
--
-- WHAT THIS IS NOT:
-- it is evidence, never identity. Nothing authorises against it. An IP may be
-- shared or NAT'd, so it identifies a request, not a person.
--
-- Booking gains `parserCommit` and `reviewBuildId`: the BUILD that produced the
-- extraction, beside the rule versions it already records. Both are written
-- once at dispatch and never updated, like `parserVersion` and `rawTextSha256`.
--
-- IF NOT EXISTS makes every statement idempotent, so re-running
-- `migrate deploy` against a database that already has them is a no-op.
--
-- ROLLBACK: dropping these is safe for an older build, which neither reads nor
-- writes them. All are nullable and never back-filled, so an older release runs
-- unchanged against this schema with no rollback required.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "RequestAudit" (
    "id" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" TEXT,
    "correlationId" TEXT,
    "route" TEXT,

    CONSTRAINT "RequestAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RequestAudit_actorUserId_idx" ON "RequestAudit"("actorUserId");
CREATE INDEX IF NOT EXISTS "RequestAudit_occurredAt_idx" ON "RequestAudit"("occurredAt");
CREATE INDEX IF NOT EXISTS "RequestAudit_correlationId_idx" ON "RequestAudit"("correlationId");

DO $$ BEGIN
  ALTER TABLE "RequestAudit" ADD CONSTRAINT "RequestAudit_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "BookingStatusHistory" ADD COLUMN IF NOT EXISTS "requestAuditId" TEXT;
ALTER TABLE "BookingCorrection"    ADD COLUMN IF NOT EXISTS "requestAuditId" TEXT;

-- ON DELETE SET NULL: removing a context must never remove the business event
-- it describes. History outlives its provenance.
DO $$ BEGIN
  ALTER TABLE "BookingStatusHistory" ADD CONSTRAINT "BookingStatusHistory_requestAuditId_fkey"
    FOREIGN KEY ("requestAuditId") REFERENCES "RequestAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "BookingCorrection" ADD CONSTRAINT "BookingCorrection_requestAuditId_fkey"
    FOREIGN KEY ("requestAuditId") REFERENCES "RequestAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "parserCommit" TEXT;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "reviewBuildId" TEXT;
