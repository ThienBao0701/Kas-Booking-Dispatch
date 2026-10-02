/**
 * The 3-minute claim countdown.
 *
 * THE DEADLINE IS THE SERVER'S, NOT THIS COMPONENT'S. It receives an absolute
 * `claimExpiresAt` and renders `expiry - now`, ticking once a second purely to
 * repaint. It never starts, extends or resets a timer, which is what makes a
 * refresh, a second tab and a reopened browser all show the same number.
 *
 * ── WHY A SERVER OFFSET ───────────────────────────────────────────────────
 * A browser clock that is wrong — or deliberately wound back — would otherwise
 * inflate the remaining time. The claim response carries `serverNow`, and the
 * offset between it and the local clock is applied to every tick, so the
 * displayed value tracks the server's idea of now rather than the machine's.
 *
 * AND IT IS ONLY DECORATION. Running out here does not release anything: the
 * server refuses a late submission against the stored deadline regardless of
 * what this component shows. If the two ever disagree, the server is right.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatRemaining } from '../lib/claim';

interface ClaimCountdownProps {
  /** Absolute server instant the claim lapses. */
  expiresAt: string;
  /**
   * The server's clock at the moment the surrounding payload was produced.
   * Omitted when unknown, in which case the local clock is trusted — still
   * correct for display, and never authoritative for the actual deadline.
   */
  serverNow?: string | null;
  /** Fired once, when the displayed value first reaches zero. */
  onExpired?: () => void;
}

export function ClaimCountdown({ expiresAt, serverNow, onExpired }: ClaimCountdownProps) {
  const expiryMs = new Date(expiresAt).getTime();

  /*
    THE OFFSET IS MEASURED ONCE PER PAYLOAD, NEVER PER RENDER.

    This line was the bug that froze the countdown. Computing
    `serverNow - Date.now()` on every render and then subtracting it again in
    `expiry - (Date.now() + offset)` cancels `Date.now()` out completely:

        expiry - (now + (serverNow - now))  ==  expiry - serverNow

    which is a constant. The display sat at its opening value until F5, and it
    did so ONLY when the server sent `serverNow` — so it looked fine in any test
    that omitted it and was broken in the real application, which always sends it.

    Anchoring the measurement to the payload keeps both properties: the offset
    still corrects a wrong PC clock, and `Date.now()` still advances inside it,
    so the number actually moves. Re-measuring when a poll delivers a fresh
    `serverNow` re-synchronises with the server without ever restarting the
    countdown, because the deadline it counts to is absolute.
  */
  const offsetMs = useMemo(
    () => (serverNow ? new Date(serverNow).getTime() - Date.now() : 0),
    [serverNow],
  );

  const [remaining, setRemaining] = useState(() => expiryMs - (Date.now() + offsetMs));

  useEffect(() => {
    let fired = false;
    function tick() {
      const next = expiryMs - (Date.now() + offsetMs);
      setRemaining(next);
      if (next <= 0 && !fired) {
        fired = true;
        onExpired?.();
      }
    }
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
    // `onExpired` is intentionally not a dependency: callers pass an inline
    // closure, and re-subscribing every render would restart the interval a
    // second at a time and make the display stutter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryMs, offsetMs]);

  const expired = remaining <= 0;

  /*
    THE DIGITS AND NOTHING ELSE — 03:00 counting to 00:00.

    No "Thời gian còn lại" heading, no "Bạn đã CẮT lúc", no "Hết hạn lúc". Those
    restate in three sentences what the number already says, and a receptionist
    creating a reservation against the clock reads one thing off this screen.
    `formatRemaining` floors at 00:00, so an elapsed claim shows 00:00 rather
    than counting into negatives.
  */
  return (
    <span
      data-testid="claim-countdown"
      aria-label="Thời gian còn lại"
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold tabular-nums ring-1 ring-inset ${
        expired
          ? 'bg-rose-50 text-rose-700 ring-rose-200'
          : remaining <= 30_000
            ? 'bg-amber-50 text-amber-800 ring-amber-200'
            : 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      }`}
    >
      {formatRemaining(remaining)}
    </span>
  );
}
