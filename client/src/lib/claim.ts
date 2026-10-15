/**
 * Claim ("CUT") helpers shared by the panel, the proof form and their tests.
 *
 * Kept out of the component file so Fast Refresh keeps working: a module that
 * exports both a component and plain values loses its refresh boundary.
 */
import type { ClaimFields } from '../api/bookings';

/**
 * The exact wording the operator asked for, shown before every submission.
 *
 * Lives here rather than inline so the claim panel and the proof form cannot
 * drift apart, and so a test can assert the sentence itself rather than a
 * paraphrase of it.
 */
export const DUPLICATE_WARNING =
  'Vui lòng kiểm tra đơn trước khi gửi để đảm bảo không bị trùng nhé.';

/** mm:ss, floored at 00:00. Lives here so the countdown file exports only a component. */
export function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export type ClaimState = 'UNCLAIMED' | 'MINE' | 'OTHERS' | 'EXPIRED';

/**
 * Where a claim stands for the current user, from the server's fields.
 *
 * Computed from the ABSOLUTE `claimExpiresAt`, so a stale polled list resolves
 * to EXPIRED rather than presenting an elapsed claim as though someone still
 * owned it. The server reaches the same conclusion independently on every
 * write; this is only what the screen should show.
 */
export function claimStateOf(
  booking: ClaimFields,
  currentUserId: number | undefined,
  now: number = Date.now(),
): ClaimState {
  if (booking.claimedByUserId === null || booking.claimExpiresAt === null) return 'UNCLAIMED';
  const expired = new Date(booking.claimExpiresAt).getTime() <= now;
  if (expired) return 'EXPIRED';
  return booking.claimedByUserId === currentUserId ? 'MINE' : 'OTHERS';
}
