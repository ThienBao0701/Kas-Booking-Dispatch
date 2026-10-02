/**
 * Is the hotel server answering?
 *
 * WHY THIS IS SEPARATE FROM THE OFFLINE INDICATOR. Those are two different
 * faults with two different remedies. `navigator.onLine` reports the network
 * INTERFACE: a receptionist whose Wi-Fi dropped needs to hear about Wi-Fi. This
 * reports the SERVER: a receptionist whose machine is perfectly online but whose
 * server is off needs to hear that somebody should go and look at the server.
 * Telling them "you are offline" when they are not sends them to reset a router
 * that was never the problem.
 *
 * WHY THE THRESHOLD. A single dropped request must never throw a full-screen
 * page over a receptionist mid-check-in. One failure is a blip; two in a row is
 * a server. Recovery is the other way round — ONE success clears it, because
 * making somebody wait thirty seconds to be told the thing they can already see
 * is working would be its own kind of wrong.
 *
 * Pure functions, no DOM, no timers, so the rule is testable without a browser.
 */

/** Consecutive failed probes before the page is shown. */
export const FAILURES_BEFORE_UNAVAILABLE = 2;

/** How often to probe while things look fine. */
export const PROBE_INTERVAL_MS = 20_000;

/** How often to probe while the server is down — sooner, so recovery is quick. */
export const RETRY_INTERVAL_MS = 5_000;

/** How long a single probe may take before it counts as a failure. */
export const PROBE_TIMEOUT_MS = 4_000;

export type Reachability = 'REACHABLE' | 'UNREACHABLE';

export interface ProbeState {
  reachability: Reachability;
  /** Failures since the last success. Reset by any success. */
  consecutiveFailures: number;
}

/**
 * The starting point: assume the server is fine.
 *
 * Optimistic on purpose. The alternative — start UNREACHABLE and prove
 * otherwise — would flash a "server unavailable" page over every single page
 * load while the first probe is in flight, which is both wrong and alarming.
 */
export const INITIAL_PROBE_STATE: ProbeState = {
  reachability: 'REACHABLE',
  consecutiveFailures: 0,
};

/** Folds one probe result into the state. */
export function nextProbeState(current: ProbeState, ok: boolean): ProbeState {
  if (ok) return INITIAL_PROBE_STATE;

  const consecutiveFailures = current.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    reachability:
      consecutiveFailures >= FAILURES_BEFORE_UNAVAILABLE ? 'UNREACHABLE' : current.reachability,
  };
}

/**
 * Should another probe be sent?
 *
 * Not while the BROWSER is offline. There is no point asking a server a question
 * down a cable that is unplugged, the answer would be a failure that says
 * nothing about the server, and the offline banner is already telling the
 * operator the truth about their network.
 */
export function shouldProbe(browserOnline: boolean): boolean {
  return browserOnline;
}

/** How long until the next probe, given what the last one found. */
export function probeDelayMs(reachability: Reachability): number {
  return reachability === 'UNREACHABLE' ? RETRY_INTERVAL_MS : PROBE_INTERVAL_MS;
}

/**
 * Whether the full-screen page should be showing.
 *
 * The browser being offline suppresses it: that is the offline banner's fault to
 * report, and stacking two different explanations of one problem in front of a
 * receptionist helps nobody.
 */
export function shouldShowUnavailable(state: ProbeState, browserOnline: boolean): boolean {
  return state.reachability === 'UNREACHABLE' && browserOnline;
}
