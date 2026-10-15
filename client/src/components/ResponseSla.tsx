/**
 * The Admin-sent → reception-started indicator.
 *
 * A read-out, not a mechanism: nothing in the application changes when this
 * runs out. It is deliberately NOT `ClaimCountdown`, which is the three-minute
 * deadline on work already started and whose expiry really does move the order.
 *
 * Each order renders its own instance, so every row keeps its own clock — there
 * is no shared page timer to get out of step with a list that reorders on poll.
 */
import { useEffect, useMemo, useState } from 'react';
import { Timer } from 'lucide-react';
import { formatSla, slaStateOf, type SlaInput } from '../lib/responseSla';

interface ResponseSlaProps extends SlaInput {
  /**
   * The server's clock when this payload was produced.
   *
   * Measured against once per payload, never per render: recomputing the offset
   * on every render cancels `Date.now()` out of the arithmetic and freezes the
   * display — the exact bug that stopped the claim countdown, kept fixed here by
   * construction rather than by memory.
   */
  serverNow?: string | null;
}

export function ResponseSla({ slaStartedAt, claimedAt, serverNow }: ResponseSlaProps) {
  const offsetMs = useMemo(
    () => (serverNow ? new Date(serverNow).getTime() - Date.now() : 0),
    [serverNow],
  );

  const [state, setState] = useState(() =>
    slaStateOf({ slaStartedAt, claimedAt }, Date.now() + offsetMs),
  );

  useEffect(() => {
    function tick() {
      setState(slaStateOf({ slaStartedAt, claimedAt }, Date.now() + offsetMs));
    }
    tick();
    // A finished measurement cannot change, so it costs no interval at all.
    if (claimedAt) return;
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [slaStartedAt, claimedAt, offsetMs]);

  if (state.kind === 'NONE') return null;

  if (state.kind === 'ANSWERED') {
    return (
      <span
        data-testid="response-sla"
        data-sla-state="ANSWERED"
        title="Thời gian từ lúc Admin gửi đến lúc chi nhánh bắt đầu xử lý"
        className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-600"
      >
        <Timer className="h-3 w-3" aria-hidden="true" />
        Phản hồi: {formatSla(state.responseMs)}
      </span>
    );
  }

  if (state.kind === 'OVERDUE') {
    return (
      <span
        data-testid="response-sla"
        data-sla-state="OVERDUE"
        title="Quá thời gian phản hồi 5 phút"
        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-red-700 ring-1 ring-inset ring-red-200"
      >
        TRỄ {formatSla(state.overdueMs)}
      </span>
    );
  }

  return (
    <span
      data-testid="response-sla"
      data-sla-state="WAITING"
      title="Thời gian còn lại để chi nhánh bắt đầu xử lý"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset ${
        state.remainingMs <= 60_000
          ? 'bg-amber-50 text-amber-800 ring-amber-200'
          : 'bg-slate-100 text-slate-600 ring-slate-200'
      }`}
    >
      <Timer className="h-3 w-3" aria-hidden="true" />
      {formatSla(state.remainingMs)}
    </span>
  );
}
