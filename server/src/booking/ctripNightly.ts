/**
 * Nightly allocation for CTrip reservations that state only a total.
 *
 * Many CTrip confirmations carry a payout, a check-in and a check-out, and no
 * per-night breakdown at all. The parser reports that honestly — `nightlyRates`
 * comes back empty — which left a dispatched CTrip booking with no nightly rows
 * for the branch to work from.
 *
 * This spreads the stated total across the stay AFTER the review and BEFORE the
 * write. It is deliberately not in the parser: the parser's job is to report
 * what the email said, and an allocated night is not something the email said.
 * Every allocated night is marked `isEstimated`, so a derived figure is never
 * mistaken for one CTrip stated.
 *
 * THE ARITHMETIC RULE: the allocated nights must sum to EXACTLY the total.
 * Integer arithmetic throughout, no floating point anywhere — a stay of
 * 2,500,000 over three nights is 833,333 + 833,333 + 833,334, not three nights
 * of 833,333.33 that quietly lose a dong. The remainder always lands on the
 * LAST night: a fixed, predictable place, so the same input always produces the
 * same rows and an operator reconciling a folio knows where to look.
 *
 * It never runs for Agoda or Booking.com, and never touches a reservation whose
 * email did state its nights.
 */

/** A night as the dispatcher writes it. */
export interface AllocatedNight {
  /** ISO "YYYY-MM-DD". */
  stayDate: string;
  amount: number | null;
  /** True only when this module derived the amount rather than reading it. */
  isEstimated: boolean;
}

export interface AllocationWarning {
  code: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
}

export interface AllocationResult {
  nights: AllocatedNight[];
  warnings: AllocationWarning[];
  /** True when this module produced the nights. */
  allocated: boolean;
}

export const CTRIP_MISSING_TOTAL_RATE = 'CTRIP_MISSING_TOTAL_RATE';
export const CTRIP_INVALID_STAY = 'CTRIP_INVALID_STAY';

export interface AllocationInput {
  /** The dispatched platform. Anything but CTRIP is returned untouched. */
  source: string;
  /** What the parser found. A non-empty list is never modified. */
  nightlyRates: readonly { stayDate: string; amount: number | null }[];
  /** ISO "YYYY-MM-DD". */
  checkIn: string | null;
  /** ISO "YYYY-MM-DD", exclusive — the guest does not sleep on it. */
  checkOut: string | null;
  /** The branch payout. Whole VND. */
  total: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Whole nights between two ISO dates, or null when either is unusable. */
function nightsBetween(checkIn: string, checkOut: string): number | null {
  const from = Date.parse(`${checkIn}T00:00:00.000Z`);
  const to = Date.parse(`${checkOut}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

/** The stay dates, one per night, check-out excluded. */
function stayDates(checkIn: string, nights: number): string[] {
  const start = new Date(`${checkIn}T00:00:00.000Z`);
  const out: string[] = [];
  for (let i = 0; i < nights; i += 1) {
    const day = new Date(start.getTime() + i * MS_PER_DAY);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Splits `total` into `nights` whole parts that sum to exactly `total`.
 *
 * Exported for its own tests: this is the part where a rounding mistake would
 * silently lose or invent money, so it is checked directly across a wide range
 * of totals rather than only through the dispatcher.
 */
export function splitEvenly(total: number, nights: number): number[] {
  const base = Math.trunc(total / nights);
  const parts = new Array<number>(nights).fill(base);
  // Whatever integer division dropped goes on the last night, so the sum is
  // exact by construction rather than by luck.
  parts[nights - 1] = total - base * (nights - 1);
  return parts;
}

/**
 * Allocates nightly rows for a CTrip reservation that has none.
 *
 * Returns the input untouched for every other case: another platform, or an
 * email that already stated its nights. The caller can therefore apply this
 * unconditionally without branching on the platform itself.
 */
export function allocateCtripNightly(input: AllocationInput): AllocationResult {
  const untouched: AllocationResult = {
    nights: input.nightlyRates.map((n) => ({
      stayDate: n.stayDate,
      amount: n.amount,
      // Straight from the email: never an estimate, whatever else happens here.
      isEstimated: false,
    })),
    warnings: [],
    allocated: false,
  };

  if (input.source !== 'CTRIP') return untouched;
  // An email that stated its nights is authoritative. Re-deriving them from the
  // total would overwrite what CTrip actually said with an average.
  if (input.nightlyRates.length > 0) return untouched;

  if (input.checkIn === null || input.checkOut === null) {
    return {
      nights: [],
      warnings: [
        {
          code: CTRIP_INVALID_STAY,
          severity: 'WARNING',
          message: 'Không có ngày nhận/trả phòng nên không thể chia giá từng đêm.',
        },
      ],
      allocated: false,
    };
  }

  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (nights === null || nights <= 0) {
    return {
      nights: [],
      warnings: [
        {
          code: CTRIP_INVALID_STAY,
          severity: 'WARNING',
          message: 'Số đêm lưu trú không hợp lệ nên không thể chia giá từng đêm.',
        },
      ],
      allocated: false,
    };
  }

  if (input.total === null) {
    return {
      nights: [],
      warnings: [
        {
          code: CTRIP_MISSING_TOTAL_RATE,
          severity: 'WARNING',
          message: 'Không có tổng giá nên không thể chia giá từng đêm.',
        },
      ],
      allocated: false,
    };
  }

  const dates = stayDates(input.checkIn, nights);
  const parts = splitEvenly(input.total, nights);

  return {
    nights: dates.map((stayDate, i) => ({
      stayDate,
      amount: parts[i]!,
      // Derived here, not stated by CTrip. This flag is the only thing standing
      // between an estimate and a figure someone might reconcile against.
      isEstimated: true,
    })),
    warnings: [],
    allocated: true,
  };
}
