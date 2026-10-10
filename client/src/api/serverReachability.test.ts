/**
 * When Kas decides the hotel server has gone away.
 *
 * TWO PROPERTIES, and both are about not lying to a receptionist standing in
 * front of a guest.
 *
 * A single dropped request must never blank the screen. Networks drop packets;
 * servers do not appear and disappear every few seconds. So one failure is a
 * blip and two in a row is a server — while recovery is immediate, because
 * making someone wait to be told the thing they can see working is working
 * would be its own kind of wrong.
 *
 * And a browser that is offline must not be reported as a dead server. Those
 * are different faults with different remedies: one sends someone to the Wi-Fi,
 * the other sends someone to the server room. Getting it backwards wastes the
 * exact minutes that matter.
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURES_BEFORE_UNAVAILABLE,
  INITIAL_PROBE_STATE,
  PROBE_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  nextProbeState,
  probeDelayMs,
  shouldProbe,
  shouldShowUnavailable,
  type ProbeState,
} from './serverReachability';

/** Folds a run of results, oldest first. */
const fold = (results: boolean[], from: ProbeState = INITIAL_PROBE_STATE): ProbeState =>
  results.reduce(nextProbeState, from);

/* ================================================================== */
/* Starting assumption                                                 */
/* ================================================================== */
describe('before anything has been probed', () => {
  it('assumes the server is fine', () => {
    // Starting UNREACHABLE would flash "server unavailable" over every page
    // load while the first probe is still in flight.
    expect(INITIAL_PROBE_STATE.reachability).toBe('REACHABLE');
    expect(shouldShowUnavailable(INITIAL_PROBE_STATE, true)).toBe(false);
  });
});

/* ================================================================== */
/* One blip is not an outage                                           */
/* ================================================================== */
describe('deciding the server is gone', () => {
  it('does not react to a single failure', () => {
    // THE PROPERTY. A dropped request mid-check-in must not throw a
    // full-screen page over the booking someone is reading.
    const state = fold([false]);
    expect(state.reachability).toBe('REACHABLE');
    expect(shouldShowUnavailable(state, true)).toBe(false);
  });

  it('reports the server as gone after consecutive failures', () => {
    const state = fold(Array(FAILURES_BEFORE_UNAVAILABLE).fill(false));
    expect(state.reachability).toBe('UNREACHABLE');
    expect(shouldShowUnavailable(state, true)).toBe(true);
  });

  it('counts only CONSECUTIVE failures', () => {
    // fail, succeed, fail — one blip either side of a success is not an
    // outage, and treating it as one would make the page flicker.
    const state = fold([false, true, false]);
    expect(state.reachability).toBe('REACHABLE');
  });

  it('stays gone while it keeps failing', () => {
    const state = fold(Array(10).fill(false));
    expect(state.reachability).toBe('UNREACHABLE');
  });
});

/* ================================================================== */
/* Recovery                                                            */
/* ================================================================== */
describe('coming back', () => {
  it('recovers on the FIRST success, with no threshold', () => {
    // Asymmetric on purpose: slow to alarm, immediate to forgive.
    const down = fold(Array(5).fill(false));
    expect(nextProbeState(down, true).reachability).toBe('REACHABLE');
  });

  it('forgets the failures it had counted', () => {
    const recovered = nextProbeState(fold([false, false]), true);
    expect(recovered.consecutiveFailures).toBe(0);
    // So the next single failure does not immediately re-trigger the page.
    expect(nextProbeState(recovered, false).reachability).toBe('REACHABLE');
  });

  it('needs no user action to recover', () => {
    // The page says it will close by itself; this is that promise, as data.
    let state = fold(Array(3).fill(false));
    expect(shouldShowUnavailable(state, true)).toBe(true);
    state = nextProbeState(state, true);
    expect(shouldShowUnavailable(state, true)).toBe(false);
  });
});

/* ================================================================== */
/* The other fault                                                     */
/* ================================================================== */
describe('a browser that is offline', () => {
  it('is never reported as a dead server', () => {
    // The offline banner already tells the operator the truth about their
    // network. Two explanations of one problem helps nobody.
    const down = fold(Array(5).fill(false));
    expect(shouldShowUnavailable(down, false)).toBe(false);
  });

  it('stops the probing entirely', () => {
    // Asking a question down an unplugged cable produces a failure that says
    // nothing about the server.
    expect(shouldProbe(false)).toBe(false);
    expect(shouldProbe(true)).toBe(true);
  });

  it('shows the page again once the network returns and the server is still down', () => {
    const down = fold(Array(5).fill(false));
    expect(shouldShowUnavailable(down, true)).toBe(true);
  });
});

/* ================================================================== */
/* Polling cadence                                                     */
/* ================================================================== */
describe('how often it asks', () => {
  it('asks more often while the server is down', () => {
    // The operator is watching this page; the sooner it clears, the better.
    expect(probeDelayMs('UNREACHABLE')).toBe(RETRY_INTERVAL_MS);
    expect(probeDelayMs('REACHABLE')).toBe(PROBE_INTERVAL_MS);
    expect(RETRY_INTERVAL_MS).toBeLessThan(PROBE_INTERVAL_MS);
  });

  it('does not hammer a healthy server', () => {
    // Eight branches polling a single machine adds up.
    expect(PROBE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});
