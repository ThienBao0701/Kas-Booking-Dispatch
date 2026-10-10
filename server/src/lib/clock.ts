/**
 * Business time. Dispatch decisions (notably "last minute") must be made in the
 * property's timezone on the server, never trusting the browser. Vietnam uses
 * Asia/Ho_Chi_Minh, a fixed UTC+7 with no daylight saving, so a constant offset
 * is exact and dependency-free.
 *
 * A tiny injectable clock keeps time deterministic in tests: production uses the
 * system clock; a test can pin "now" with {@link setClock} / {@link resetClock}.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

let activeClock: Clock = systemClock;

export function getClock(): Clock {
  return activeClock;
}

/** Test-only: pin the clock. Always pair with {@link resetClock} in teardown. */
export function setClock(clock: Clock): void {
  activeClock = clock;
}

export function resetClock(): void {
  activeClock = systemClock;
}

export const HCM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The calendar date in Asia/Ho_Chi_Minh for an instant, as ISO "YYYY-MM-DD". */
export function hcmDateOnly(instant: Date): string {
  return new Date(instant.getTime() + HCM_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The UTC instant of a wall-clock time on a calendar day in Asia/Ho_Chi_Minh.
 *
 * The inverse of {@link hcmDateOnly}, and the primitive reception shifts are
 * built from: "Ca A ends at 14:00" is a wall-clock fact, and it has to become a
 * real instant before it can be compared with `now` or stored.
 *
 * Because the offset is constant, this is exact arithmetic rather than a
 * timezone lookup — and a shift that crosses midnight needs no special case,
 * since 22:00 on day D and 06:00 on day D+1 are simply two instants eight hours
 * apart. `day` is "YYYY-MM-DD"; `hhmm` is 24-hour "HH:MM".
 */
export function hcmWallClockToUtc(day: string, hhmm: string): Date {
  return new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - HCM_OFFSET_MS);
}

/** The ISO day that follows an ISO "YYYY-MM-DD", in the same calendar. */
export function nextHcmDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A booking is "last minute" when its check-in date equals today in
 * Asia/Ho_Chi_Minh at the moment it is dispatched. Check-in dates are stored at
 * UTC midnight, so their date-only form is the intended calendar day.
 */
export function isLastMinute(checkInDate: Date | null | undefined, now: Date): boolean {
  if (!checkInDate) return false;
  return checkInDate.toISOString().slice(0, 10) === hcmDateOnly(now);
}
