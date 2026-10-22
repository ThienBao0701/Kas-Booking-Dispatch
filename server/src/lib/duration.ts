/**
 * How long something took, in words, in Vietnamese.
 *
 * WHY THE SERVER FORMATS THIS AND NOT THE BROWSER
 *
 * The same number has to read identically on the Technical card, on the Admin
 * monitor and in the exported PDF. The PDF is built here, so if the browser
 * formatted the other two they would be two implementations of one rule — and
 * the report and the screen it was printed from would eventually disagree about
 * whether 90 minutes is "1 giờ 30 phút" or "2 giờ".
 *
 * The DURATION ITSELF is also the server's: it is always `end - start` over two
 * stored instants, never a number a client sent. A browser that can name its own
 * repair times can name a four-minute job as forty seconds.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Seconds between two instants, or null when the pair is incomplete.
 *
 * Clamped at zero. A negative duration means the clock moved backwards between
 * two writes; rendering "-3 phút" would put an impossible number in an audit
 * report, and silently dropping it would hide that it happened, so it reads as
 * an instantaneous 0 and the two timestamps beside it remain visible.
 */
export function durationSeconds(
  start: Date | null | undefined,
  end: Date | null | undefined,
): number | null {
  if (!start || !end) return null;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

/**
 * "45 giây" · "4 phút" · "1 giờ 30 phút" · "2 giờ".
 *
 * The three bands are the specified ones: seconds below a minute, whole minutes
 * below an hour, hours-and-minutes above. A whole number of hours drops the
 * "0 phút" rather than printing it.
 */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const total = Math.max(0, Math.floor(seconds));

  if (total < MINUTE) return `${total} giây`;
  if (total < HOUR) return `${Math.floor(total / MINUTE)} phút`;

  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  return minutes === 0 ? `${hours} giờ` : `${hours} giờ ${minutes} phút`;
}
