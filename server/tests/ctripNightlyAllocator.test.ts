/**
 * The CTrip nightly allocator.
 *
 * Many CTrip confirmations state a payout, a check-in and a check-out and no
 * per-night breakdown. The parser reports that honestly, which left dispatched
 * CTrip bookings with no nightly rows at all.
 *
 * THE PROPERTY EVERYTHING ELSE SERVES: the allocated nights sum to EXACTLY the
 * stated total. A rounding scheme that loses a dong per night is a rounding
 * scheme that loses money on every reconciliation, so the sum is asserted
 * directly and then again across a thousand generated totals.
 *
 * The second property is honesty: an allocated night is marked `isEstimated`,
 * a night CTrip stated is not, and no other platform is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  CTRIP_INVALID_STAY,
  CTRIP_MISSING_TOTAL_RATE,
  allocateCtripNightly,
  splitEvenly,
} from '../src/booking/ctripNightly';

const base = {
  source: 'CTRIP',
  nightlyRates: [] as { stayDate: string; amount: number | null }[],
  checkIn: '2026-08-10',
  checkOut: '2026-08-13',
  total: 3_000_000,
};

const amounts = (r: ReturnType<typeof allocateCtripNightly>) => r.nights.map((n) => n.amount);
const sum = (values: (number | null)[]) => values.reduce<number>((t, v) => t + (v ?? 0), 0);

/* ================================================================== */
/* The worked examples from the hotfix report                          */
/* ================================================================== */
describe('the three stated cases', () => {
  it('3 nights / 3,000,000 splits evenly', () => {
    const r = allocateCtripNightly(base);
    expect(amounts(r)).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it('3 nights / 2,500,000 puts the remainder on the last night', () => {
    const r = allocateCtripNightly({ ...base, total: 2_500_000 });
    expect(amounts(r)).toEqual([833_333, 833_333, 833_334]);
    expect(sum(amounts(r))).toBe(2_500_000);
  });

  it('5 nights / 4,999,999 puts the whole remainder on the last night', () => {
    const r = allocateCtripNightly({ ...base, checkOut: '2026-08-15', total: 4_999_999 });
    expect(amounts(r)).toEqual([999_999, 999_999, 999_999, 999_999, 1_000_003]);
    expect(sum(amounts(r))).toBe(4_999_999);
  });
});

/* ================================================================== */
/* The sum is exact, always                                            */
/* ================================================================== */
describe('the total is never lost or invented', () => {
  it('sums to the total for every night count from 1 to 30', () => {
    for (let nights = 1; nights <= 30; nights += 1) {
      const parts = splitEvenly(1_234_567, nights);
      expect(parts).toHaveLength(nights);
      expect(sum(parts)).toBe(1_234_567);
    }
  });

  it('sums to the total across a thousand awkward amounts', () => {
    for (let total = 999_000; total < 1_000_000; total += 1) {
      for (const nights of [1, 2, 3, 7]) {
        expect(sum(splitEvenly(total, nights))).toBe(total);
      }
    }
  });

  it('produces whole numbers only — no floating point anywhere', () => {
    for (const total of [2_500_000, 4_999_999, 1, 7, 123_457]) {
      for (const part of splitEvenly(total, 3)) {
        expect(Number.isInteger(part)).toBe(true);
      }
    }
  });

  it('handles a total smaller than the night count without going negative', () => {
    // 2 VND over 3 nights: two nights of 0 and the remainder on the last.
    const parts = splitEvenly(2, 3);
    expect(sum(parts)).toBe(2);
    for (const part of parts) expect(part).toBeGreaterThanOrEqual(0);
  });

  it('keeps a zero total at zero rather than inventing money', () => {
    expect(splitEvenly(0, 3)).toEqual([0, 0, 0]);
  });
});

/* ================================================================== */
/* Dates                                                               */
/* ================================================================== */
describe('the nights it produces', () => {
  it('covers each stay date, excluding check-out', () => {
    const r = allocateCtripNightly(base);
    expect(r.nights.map((n) => n.stayDate)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('handles a single-night stay', () => {
    const r = allocateCtripNightly({ ...base, checkOut: '2026-08-11', total: 750_000 });
    expect(amounts(r)).toEqual([750_000]);
    expect(r.nights.map((n) => n.stayDate)).toEqual(['2026-08-10']);
  });

  it('crosses a month boundary correctly', () => {
    const r = allocateCtripNightly({
      ...base,
      checkIn: '2026-08-30',
      checkOut: '2026-09-02',
      total: 900_000,
    });
    expect(r.nights.map((n) => n.stayDate)).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
  });
});

/* ================================================================== */
/* Marked as estimated                                                 */
/* ================================================================== */
describe('an allocated night is never mistaken for a stated one', () => {
  it('marks every allocated night as estimated', () => {
    const r = allocateCtripNightly(base);
    expect(r.allocated).toBe(true);
    for (const night of r.nights) expect(night.isEstimated).toBe(true);
  });

  it('leaves nights the email stated untouched and not estimated', () => {
    const stated = [
      { stayDate: '2026-08-10', amount: 1_200_000 },
      { stayDate: '2026-08-11', amount: 800_000 },
    ];
    const r = allocateCtripNightly({ ...base, nightlyRates: stated });
    expect(r.allocated).toBe(false);
    expect(amounts(r)).toEqual([1_200_000, 800_000]);
    for (const night of r.nights) expect(night.isEstimated).toBe(false);
  });

  it('does not re-derive an uneven stated split into an average', () => {
    // 1,200,000 + 800,000 is not 1,000,000 twice. What CTrip said wins.
    const stated = [
      { stayDate: '2026-08-10', amount: 1_200_000 },
      { stayDate: '2026-08-11', amount: 800_000 },
    ];
    const r = allocateCtripNightly({ ...base, nightlyRates: stated, total: 2_000_000 });
    expect(amounts(r)).toEqual([1_200_000, 800_000]);
  });

  it('leaves a stated night whose amount is unknown as unknown', () => {
    const stated = [{ stayDate: '2026-08-10', amount: null }];
    const r = allocateCtripNightly({ ...base, nightlyRates: stated });
    expect(amounts(r)).toEqual([null]);
    expect(r.allocated).toBe(false);
  });
});

/* ================================================================== */
/* It refuses rather than guesses                                      */
/* ================================================================== */
describe('when it cannot divide honestly', () => {
  it('warns and allocates nothing without a total', () => {
    const r = allocateCtripNightly({ ...base, total: null });
    expect(r.nights).toEqual([]);
    expect(r.allocated).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual([CTRIP_MISSING_TOTAL_RATE]);
  });

  it('warns and allocates nothing when check-out precedes check-in', () => {
    const r = allocateCtripNightly({ ...base, checkIn: '2026-08-13', checkOut: '2026-08-10' });
    expect(r.nights).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual([CTRIP_INVALID_STAY]);
  });

  it('warns on a zero-night stay', () => {
    const r = allocateCtripNightly({ ...base, checkOut: '2026-08-10' });
    expect(r.nights).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual([CTRIP_INVALID_STAY]);
  });

  it('warns when the dates are missing entirely', () => {
    expect(allocateCtripNightly({ ...base, checkIn: null }).warnings.map((w) => w.code)).toEqual([
      CTRIP_INVALID_STAY,
    ]);
    expect(allocateCtripNightly({ ...base, checkOut: null }).warnings.map((w) => w.code)).toEqual([
      CTRIP_INVALID_STAY,
    ]);
  });

  it('reports the missing stay before the missing total', () => {
    // Both are wrong; the dates are the more fundamental problem and the
    // operator should be sent there first.
    const r = allocateCtripNightly({ ...base, checkIn: null, total: null });
    expect(r.warnings.map((w) => w.code)).toEqual([CTRIP_INVALID_STAY]);
  });
});

/* ================================================================== */
/* Other platforms                                                     */
/* ================================================================== */
describe('no other platform is affected', () => {
  it('never allocates for Agoda, even with an empty nightly list', () => {
    const r = allocateCtripNightly({ ...base, source: 'AGODA' });
    expect(r.nights).toEqual([]);
    expect(r.allocated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('never allocates for Booking.com', () => {
    const r = allocateCtripNightly({ ...base, source: 'BOOKING_COM' });
    expect(r.nights).toEqual([]);
    expect(r.allocated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('passes an Agoda booking’s stated nights straight through', () => {
    const stated = [{ stayDate: '2026-08-10', amount: 1_000_000 }];
    const r = allocateCtripNightly({ ...base, source: 'AGODA', nightlyRates: stated });
    expect(amounts(r)).toEqual([1_000_000]);
    expect(r.nights[0]!.isEstimated).toBe(false);
  });
});
