/**
 * The Admin-sent → reception-started response SLA.
 *
 * ── THIS IS NOT THE CLAIM COUNTDOWN ───────────────────────────────────────
 * `lib/claim.ts` owns a different clock: once a receptionist presses CẮT they
 * have three minutes to create the reservation, and letting it lapse hands the
 * order back to an Admin. That timer is a deadline on WORK ALREADY STARTED.
 *
 * This one measures the gap BEFORE that: how long an order sat in front of
 * reception before anybody started on it. It starts when the Admin dispatches,
 * it stops the instant the order is claimed, and running out of it changes
 * nothing about the order — it is a service-level indicator, not a mechanism.
 *
 * The two are deliberately separate files with separate windows and separate
 * components, so a change to one can never quietly move the other.
 */

/** Five minutes, the agreed window for reception to start on a new order. */
export const SLA_WINDOW_MS = 5 * 60 * 1000;

export type SlaState =
  /** Sent, nobody has started, still inside the window. */
  | { kind: 'WAITING'; remainingMs: number }
  /** Sent, nobody has started, the window has passed. */
  | { kind: 'OVERDUE'; overdueMs: number }
  /** Somebody started; the clock has stopped at this duration. */
  | { kind: 'ANSWERED'; responseMs: number }
  /** Nothing to measure — never dispatched. */
  | { kind: 'NONE' };

export interface SlaInput {
  /** When the order was most recently put in front of reception. */
  slaStartedAt: string | null | undefined;
  /** When reception took it. `null` while nobody has. */
  claimedAt: string | null | undefined;
}

/**
 * Where an order stands against its response window.
 *
 * `now` is passed in rather than read here so the caller can supply a
 * server-corrected clock — the same discipline the claim countdown uses.
 *
 * Once `claimedAt` exists the answer no longer depends on `now` at all: the
 * measurement is finished and fixed, which is what makes it stable across
 * refreshes, re-renders and polls.
 */
export function slaStateOf(input: SlaInput, now: number): SlaState {
  if (!input.slaStartedAt) return { kind: 'NONE' };
  const started = new Date(input.slaStartedAt).getTime();
  if (Number.isNaN(started)) return { kind: 'NONE' };

  if (input.claimedAt) {
    const claimed = new Date(input.claimedAt).getTime();
    if (!Number.isNaN(claimed)) {
      // Clamped at zero: a claim recorded a hair before the dispatch it belongs
      // to (clock skew across a resend) must not render as a negative duration.
      return { kind: 'ANSWERED', responseMs: Math.max(0, claimed - started) };
    }
  }

  const elapsed = now - started;
  // Exactly at the window the countdown reads 00:00 and is not yet late; one
  // millisecond later it is. The boundary belongs to the branch, not against it.
  if (elapsed < SLA_WINDOW_MS) return { kind: 'WAITING', remainingMs: SLA_WINDOW_MS - elapsed };
  if (elapsed === SLA_WINDOW_MS) return { kind: 'WAITING', remainingMs: 0 };
  return { kind: 'OVERDUE', overdueMs: elapsed - SLA_WINDOW_MS };
}

/** mm:ss, floored at 00:00, counting past an hour rather than wrapping. */
export function formatSla(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
