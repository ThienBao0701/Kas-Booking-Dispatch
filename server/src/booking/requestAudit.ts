/**
 * Recording WHERE a booking change came from.
 *
 * `BookingStatusHistory` and `BookingCorrection` already answer who changed
 * what, when. What they could not answer was from which machine, session and
 * request — the questions that matter when a change is disputed or a session is
 * suspected of being shared.
 *
 * One row per REQUEST. A dispatch writes a status row and several correction
 * rows; they all reference the same context, so the same four values are not
 * copied across every audit table in the system.
 *
 * This is EVIDENCE, never identity. Nothing authorises against it: an address
 * may be shared or behind NAT, so it identifies a request, not a person. A
 * value the client did not send is stored as null rather than guessed.
 */
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { env } from '../config/env';

/** What a request tells us about its origin. */
export interface RequestOrigin {
  actorUserId: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  sessionId: string | null;
  correlationId: string | null;
  route: string | null;
}

/** Trims to a storable length without throwing on absent values. */
function bounded(value: string | undefined | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * Reads the origin of an Express request.
 *
 * `req.ip` already honours the configured `TRUST_PROXY` depth, so this does not
 * parse `x-forwarded-for` itself — doing so would let a client spoof its own
 * address by sending the header directly.
 */
export function readRequestOrigin(req: Request): RequestOrigin {
  return {
    actorUserId: req.currentUser?.id ?? null,
    ipAddress: bounded(req.ip, 100),
    userAgent: bounded(req.header('user-agent'), 500),
    sessionId: bounded(req.sessionID, 200),
    correlationId: bounded(req.requestId, 100),
    // The route PATTERN ("/bookings/:id/receive"), not the concrete path.
    // Storing the resolved path would embed a booking id in a field meant for
    // grouping — the id is already on the row this context is attached to —
    // and would make "how often is check-in used" unanswerable.
    route: bounded(`${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, 200),
  };
}

/**
 * Writes the context row for one request, inside the caller's transaction.
 *
 * Returns its id so the history rows written alongside can point at it. A
 * failure here would roll the whole change back, which is correct: a booking
 * change with no recorded provenance is not something to keep.
 */
export async function recordRequestOrigin(
  tx: Prisma.TransactionClient,
  origin: RequestOrigin,
  occurredAt: Date,
): Promise<string> {
  const row = await tx.requestAudit.create({
    data: {
      actorUserId: origin.actorUserId,
      occurredAt,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
      sessionId: origin.sessionId,
      correlationId: origin.correlationId,
      route: origin.route,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The build this server is running, or null when it was not configured.
 *
 * Deliberately not defaulted to "unknown" or to a timestamp: a booking that
 * records no build is honestly unattributed, whereas an invented value would
 * look like a real revision and send someone to the wrong commit.
 */
export function currentBuildId(): string | null {
  return env.APP_RELEASE_REF ?? null;
}
