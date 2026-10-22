/**
 * Polls the health endpoint and reports whether the server is answering.
 *
 * The thin imperative half of `serverReachability.ts`: this owns the timer, the
 * fetch and the abort, and every decision it makes comes from there.
 *
 * It probes `/api/health` RELATIVELY, so an installed app asks whatever origin
 * it was installed from. That is what keeps a client honest — there is no
 * configured address to get wrong, and a PWA installed from the server can only
 * ever talk back to the server.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  INITIAL_PROBE_STATE,
  PROBE_TIMEOUT_MS,
  nextProbeState,
  probeDelayMs,
  shouldProbe,
  shouldShowUnavailable,
  type ProbeState,
} from './serverReachability';

/** One probe. True when the server answered at all — 503 included. */
export async function probeServer(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch('/api/health', {
      signal: controller.signal,
      // Never a cached answer: a service worker replaying yesterday's 200 would
      // report a healthy server that has been off since this morning.
      cache: 'no-store',
      credentials: 'same-origin',
    });
    clearTimeout(timer);
    // ANY response means the server is there. A 503 is Kas saying its database
    // is down, which the app itself surfaces properly — it is emphatically not
    // "cannot reach the server", and showing this page for it would send an
    // operator to check the network instead of the database.
    return response.status < 500 || response.status === 503;
  } catch {
    return false;
  }
}

export function useServerReachable() {
  const [state, setState] = useState<ProbeState>(INITIAL_PROBE_STATE);
  const [retrying, setRetrying] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  // Held in a ref so the scheduling effect does not restart on every probe.
  const stateRef = useRef(state);
  stateRef.current = state;

  const runProbe = useCallback(async () => {
    if (!shouldProbe(typeof navigator === 'undefined' || navigator.onLine)) return;
    const ok = await probeServer();
    setState((current) => nextProbeState(current, ok));
  }, []);

  const retry = useCallback(() => {
    setRetrying(true);
    void runProbe().finally(() => setRetrying(false));
  }, [runProbe]);

  useEffect(() => {
    const goOnline = () => {
      setBrowserOnline(true);
      // The network coming back is the most likely moment for the server to be
      // reachable again, so ask immediately rather than waiting out the timer.
      void runProbe();
    };
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [runProbe]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      timer = setTimeout(() => {
        void runProbe().finally(() => {
          if (!cancelled) schedule();
        });
      }, probeDelayMs(stateRef.current.reachability));
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runProbe]);

  return {
    unavailable: shouldShowUnavailable(state, browserOnline),
    retrying,
    retry,
  };
}
