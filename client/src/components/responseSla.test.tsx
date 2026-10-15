/**
 * The Admin-sent → reception-started response indicator.
 *
 * Two layers are covered: the pure state function, where the 5:00 boundary can
 * be asserted to the millisecond, and the rendered badge, where what matters is
 * that it keeps ticking without a refresh and stops dead once the order is
 * claimed.
 *
 * This is NOT the claim countdown. `claimWorkflow.test.tsx` owns that one — the
 * three-minute deadline whose expiry actually moves the order — and nothing here
 * touches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ResponseSla } from './ResponseSla';
import { SLA_WINDOW_MS, formatSla, slaStateOf } from '../lib/responseSla';

const T0 = new Date('2026-08-13T05:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0.getTime() + offsetMs).toISOString();
const at = (offsetMs: number) => T0.getTime() + offsetMs;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ================================================================== */
/* The rule, to the millisecond                                        */
/* ================================================================== */

describe('slaStateOf', () => {
  const sent = { slaStartedAt: iso(0), claimedAt: null };

  it('is a five-minute window', () => {
    expect(SLA_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('counts down from 05:00 at the moment of dispatch', () => {
    const s = slaStateOf(sent, at(0));
    expect(s).toEqual({ kind: 'WAITING', remainingMs: SLA_WINDOW_MS });
    expect(formatSla((s as { remainingMs: number }).remainingMs)).toBe('05:00');
  });

  it('shows 04:00 remaining after one minute', () => {
    const s = slaStateOf(sent, at(60_000));
    expect(formatSla((s as { remainingMs: number }).remainingMs)).toBe('04:00');
  });

  it('is still within SLA at 04:59', () => {
    const s = slaStateOf(sent, at(4 * 60_000 + 59_000));
    expect(s.kind).toBe('WAITING');
    expect(formatSla((s as { remainingMs: number }).remainingMs)).toBe('00:01');
  });

  it('reaches exactly 00:00 at 5:00, and is NOT yet late', () => {
    const s = slaStateOf(sent, at(SLA_WINDOW_MS));
    expect(s.kind).toBe('WAITING');
    expect(formatSla((s as { remainingMs: number }).remainingMs)).toBe('00:00');
  });

  it('is overdue one second later', () => {
    const s = slaStateOf(sent, at(SLA_WINDOW_MS + 1_000));
    expect(s.kind).toBe('OVERDUE');
    expect(formatSla((s as { overdueMs: number }).overdueMs)).toBe('00:01');
  });

  it('keeps counting up while overdue', () => {
    expect(formatSla((slaStateOf(sent, at(SLA_WINDOW_MS + 17_000)) as { overdueMs: number }).overdueMs)).toBe('00:17');
    expect(formatSla((slaStateOf(sent, at(SLA_WINDOW_MS + 61_000)) as { overdueMs: number }).overdueMs)).toBe('01:01');
    expect(formatSla((slaStateOf(sent, at(SLA_WINDOW_MS + 155_000)) as { overdueMs: number }).overdueMs)).toBe('02:35');
  });

  it('stops the moment the order is claimed, and the answer no longer depends on now', () => {
    const claimed = { slaStartedAt: iso(0), claimedAt: iso(7 * 60_000 + 35_000) };
    const a = slaStateOf(claimed, at(8 * 60_000));
    const b = slaStateOf(claimed, at(90 * 60_000));

    expect(a).toEqual({ kind: 'ANSWERED', responseMs: 455_000 });
    expect(b).toEqual(a); // an hour later, the same measurement
    expect(formatSla(455_000)).toBe('07:35');
  });

  it('measures the response as claimedAt − slaStartedAt', () => {
    const s = slaStateOf({ slaStartedAt: iso(0), claimedAt: iso(180_000) }, at(999_999));
    expect(s).toEqual({ kind: 'ANSWERED', responseMs: 180_000 });
  });

  it('shows nothing for an order that was never dispatched', () => {
    expect(slaStateOf({ slaStartedAt: null, claimedAt: null }, at(0))).toEqual({ kind: 'NONE' });
  });
});

/* ================================================================== */
/* The badge                                                           */
/* ================================================================== */

describe('the indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(T0);
  });

  it('ticks down without a refresh', async () => {
    render(<ResponseSla slaStartedAt={iso(0)} claimedAt={null} serverNow={iso(0)} />);

    const badge = screen.getByTestId('response-sla');
    expect(badge).toHaveTextContent('05:00');

    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(badge).toHaveTextContent('04:57'));

    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(badge).toHaveTextContent('04:54'));
  });

  it('crosses into TRỄ on its own', async () => {
    // Opens with four seconds left, so the crossing happens live.
    render(
      <ResponseSla slaStartedAt={iso(-(SLA_WINDOW_MS - 4_000))} claimedAt={null} serverNow={iso(0)} />,
    );

    const badge = screen.getByTestId('response-sla');
    expect(badge).toHaveAttribute('data-sla-state', 'WAITING');

    await vi.advanceTimersByTimeAsync(6_000);
    await waitFor(() => expect(badge).toHaveAttribute('data-sla-state', 'OVERDUE'));
    expect(badge.textContent).toContain('TRỄ');
  });

  it('opens already overdue when the order has been waiting', async () => {
    render(
      <ResponseSla slaStartedAt={iso(-(SLA_WINDOW_MS + 120_000))} claimedAt={null} serverNow={iso(0)} />,
    );

    const badge = screen.getByTestId('response-sla');
    expect(badge).toHaveAttribute('data-sla-state', 'OVERDUE');
    expect(badge).toHaveTextContent('TRỄ 02:00');
  });

  it('opens with the finished measurement when the order is already claimed', () => {
    render(
      <ResponseSla slaStartedAt={iso(-600_000)} claimedAt={iso(-150_000)} serverNow={iso(0)} />,
    );

    const badge = screen.getByTestId('response-sla');
    expect(badge).toHaveAttribute('data-sla-state', 'ANSWERED');
    expect(badge).toHaveTextContent('Phản hồi: 07:30');
  });

  it('does not move once claimed', async () => {
    render(<ResponseSla slaStartedAt={iso(-600_000)} claimedAt={iso(-150_000)} serverNow={iso(0)} />);
    const badge = screen.getByTestId('response-sla');
    const before = badge.textContent;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(badge.textContent).toBe(before);
  });

  it('uses the SERVER clock, so a wound-back PC cannot flatter the response', () => {
    // The machine is ten minutes behind the server.
    vi.setSystemTime(new Date(T0.getTime() - 600_000));
    render(<ResponseSla slaStartedAt={iso(-120_000)} claimedAt={null} serverNow={iso(0)} />);

    // Two minutes gone, three remaining — not the twelve the local clock implies.
    expect(screen.getByTestId('response-sla')).toHaveTextContent('03:00');
  });

  it('renders nothing when there is no dispatch to measure from', () => {
    render(<ResponseSla slaStartedAt={null} claimedAt={null} serverNow={iso(0)} />);
    expect(screen.queryByTestId('response-sla')).toBeNull();
  });

  it('gives each order its own independent timer', async () => {
    render(
      <>
        <div data-testid="a">
          <ResponseSla slaStartedAt={iso(-60_000)} claimedAt={null} serverNow={iso(0)} />
        </div>
        <div data-testid="b">
          <ResponseSla slaStartedAt={iso(-(SLA_WINDOW_MS + 120_000))} claimedAt={null} serverNow={iso(0)} />
        </div>
        <div data-testid="c">
          <ResponseSla slaStartedAt={iso(-600_000)} claimedAt={iso(-420_000)} serverNow={iso(0)} />
        </div>
      </>,
    );

    // One counting down, one overdue, one finished — all at the same instant.
    expect(screen.getByTestId('a').textContent).toContain('04:00');
    expect(screen.getByTestId('b').textContent).toContain('TRỄ 02:00');
    expect(screen.getByTestId('c').textContent).toContain('Phản hồi: 03:00');

    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toContain('03:58'));
    // The finished one has not moved.
    expect(screen.getByTestId('c').textContent).toContain('Phản hồi: 03:00');
  });
});
