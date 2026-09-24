/**
 * Reception shift arithmetic, in Asia/Ho_Chi_Minh.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE: the handover prompt fires at the shift's
 * nominal end plus ten minutes — not ten minutes after check-in, and not the
 * instant the shift runs out. The cases are written to the SECOND on both sides
 * of each boundary, because "around ten past" is exactly the kind of requirement
 * that passes a vague test and fails at 22:09:59 in production.
 *
 * No database and no HTTP: this is pure time arithmetic, so it is tested as pure
 * time arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { hcmWallClockToUtc, nextHcmDay } from '../src/lib/clock';
import {
  GRACE_MINUTES,
  SHIFT_CODES,
  isPromptDue,
  shiftBoundaries,
  shiftBusinessDate,
  shiftDefinition,
} from '../src/shift/shiftTypes';

/** 06:00 HCM on a day == 23:00 UTC the PREVIOUS day. */
const hcm = (day: string, hhmm: string) => hcmWallClockToUtc(day, hhmm);

describe('the HCM wall-clock primitive', () => {
  it('converts a wall-clock time to the right UTC instant', () => {
    // UTC+7, fixed: 06:00 on the 17th is 23:00 UTC on the 16th.
    expect(hcm('2026-09-17', '06:00').toISOString()).toBe('2026-09-16T23:00:00.000Z');
    expect(hcm('2026-09-17', '14:00').toISOString()).toBe('2026-09-17T07:00:00.000Z');
    expect(hcm('2026-09-17', '22:00').toISOString()).toBe('2026-09-17T15:00:00.000Z');
    expect(hcm('2026-09-17', '18:00').toISOString()).toBe('2026-09-17T11:00:00.000Z');
  });

  it('rolls to the next day across a month end', () => {
    expect(nextHcmDay('2026-09-30')).toBe('2026-10-01');
    expect(nextHcmDay('2026-12-31')).toBe('2027-01-01');
    // A leap year, because February is where date arithmetic goes wrong.
    expect(nextHcmDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('every shift is defined exactly once', () => {
  it('offers the five shifts the hotel actually runs', () => {
    expect(SHIFT_CODES).toEqual(['A', 'B', 'C', 'A4', 'C4']);
  });

  it('uses a ten-minute grace everywhere', () => {
    expect(GRACE_MINUTES).toBe(10);
    for (const code of SHIFT_CODES) {
      expect(shiftDefinition(code).graceMinutes).toBe(10);
    }
  });

  it('marks exactly the overnight shifts as crossing midnight', () => {
    expect(shiftDefinition('A').crossesMidnight).toBe(false);
    expect(shiftDefinition('B').crossesMidnight).toBe(false);
    expect(shiftDefinition('A4').crossesMidnight).toBe(false);
    expect(shiftDefinition('C').crossesMidnight).toBe(true);
    expect(shiftDefinition('C4').crossesMidnight).toBe(true);
  });
});

describe('a shift knows when it ends and when it may prompt again', () => {
  // CASE 1 — Ca A: 06:00 → 14:00, prompt at 14:10.
  it('Ca A checked in at 06:00 ends at 14:00 and prompts at 14:10', () => {
    const { nominalEndAt, graceEndAt } = shiftBoundaries('A', hcm('2026-09-17', '06:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-17', '14:00').toISOString());
    expect(graceEndAt.toISOString()).toBe(hcm('2026-09-17', '14:10').toISOString());
  });

  // CASE 2 — Ca B: 14:00 → 22:00, prompt at 22:10.
  it('Ca B ends at 22:00 and prompts at 22:10', () => {
    const { nominalEndAt, graceEndAt } = shiftBoundaries('B', hcm('2026-09-17', '14:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-17', '22:00').toISOString());
    expect(graceEndAt.toISOString()).toBe(hcm('2026-09-17', '22:10').toISOString());
  });

  // CASE 3 — Ca C crosses midnight: 22:00 → 06:00 the NEXT day.
  it('Ca C started at 22:00 ends at 06:00 the next day and prompts at 06:10', () => {
    const { nominalEndAt, graceEndAt } = shiftBoundaries('C', hcm('2026-09-17', '22:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-18', '06:00').toISOString());
    expect(graceEndAt.toISOString()).toBe(hcm('2026-09-18', '06:10').toISOString());
  });

  // CASE 4 — Ca A4: 06:00 → 18:00, prompt at 18:10.
  it('Ca A4 ends at 18:00 and prompts at 18:10', () => {
    const { nominalEndAt, graceEndAt } = shiftBoundaries('A4', hcm('2026-09-17', '06:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-17', '18:00').toISOString());
    expect(graceEndAt.toISOString()).toBe(hcm('2026-09-17', '18:10').toISOString());
  });

  // CASE 5 — Ca C4 crosses midnight: 18:00 → 06:00 the NEXT day.
  it('Ca C4 started at 18:00 ends at 06:00 the next day and prompts at 06:10', () => {
    const { nominalEndAt, graceEndAt } = shiftBoundaries('C4', hcm('2026-09-17', '18:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-18', '06:00').toISOString());
    expect(graceEndAt.toISOString()).toBe(hcm('2026-09-18', '06:10').toISOString());
  });

  /**
   * CASE 6 — A LATE CHECK-IN DOES NOT EXTEND THE SHIFT.
   *
   * Somebody who checks in to Ca C at 01:30, well after it began, is on the shift
   * that ends at 06:00 THAT MORNING — not 06:00 the following day. Anchoring the
   * end to "the shift's end time on the check-in day, or the next day if that has
   * already passed" is what makes this land; anchoring it to the calendar day of
   * check-in alone would produce a twenty-eight-hour shift.
   */
  it('a late check-in to Ca C still ends at the NEXT 06:00, not 06:00 a day later', () => {
    const { nominalEndAt } = shiftBoundaries('C', hcm('2026-09-18', '01:30'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-18', '06:00').toISOString());
  });

  it('a late check-in to Ca A at 13:55 still ends at 14:00 the same day', () => {
    const { nominalEndAt } = shiftBoundaries('A', hcm('2026-09-17', '13:55'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-17', '14:00').toISOString());
  });

  /**
   * CASE 7 — CHECKING IN EXACTLY AT THE END TIME.
   *
   * 14:00 is the end of Ca A. Someone selecting Ca A at exactly 14:00 means the
   * NEXT Ca A, not a shift that is already over — otherwise they would be
   * prompted to choose again ten minutes later, having just chosen.
   */
  it('checking in exactly at the shift end belongs to the next one', () => {
    const { nominalEndAt } = shiftBoundaries('A', hcm('2026-09-17', '14:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-09-18', '14:00').toISOString());
  });

  it('crosses a month end without special-casing it', () => {
    const { nominalEndAt } = shiftBoundaries('C', hcm('2026-09-30', '22:00'));
    expect(nominalEndAt.toISOString()).toBe(hcm('2026-10-01', '06:00').toISOString());
  });
});

/**
 * THE 10-MINUTE RULE, TO THE SECOND.
 *
 * Every case the specification names is asserted on BOTH sides of the boundary,
 * so a test cannot pass by being approximately right.
 */
describe('the prompt fires at the grace end and not a second earlier', () => {
  const cases = [
    { shift: 'A' as const, checkIn: ['2026-09-17', '06:00'] as const, quiet: ['2026-09-17', '14:09:59'] as const, due: ['2026-09-17', '14:10:00'] as const },
    { shift: 'B' as const, checkIn: ['2026-09-17', '14:00'] as const, quiet: ['2026-09-17', '22:09:59'] as const, due: ['2026-09-17', '22:10:00'] as const },
    { shift: 'C' as const, checkIn: ['2026-09-17', '22:00'] as const, quiet: ['2026-09-18', '06:09:59'] as const, due: ['2026-09-18', '06:10:00'] as const },
    { shift: 'A4' as const, checkIn: ['2026-09-17', '06:00'] as const, quiet: ['2026-09-17', '18:09:59'] as const, due: ['2026-09-17', '18:10:00'] as const },
    { shift: 'C4' as const, checkIn: ['2026-09-17', '18:00'] as const, quiet: ['2026-09-18', '06:09:59'] as const, due: ['2026-09-18', '06:10:00'] as const },
  ];

  /** Seconds matter here, so the helper takes "HH:MM:SS". */
  const at = (day: string, hhmmss: string) =>
    new Date(Date.parse(`${day}T${hhmmss}.000Z`) - 7 * 60 * 60 * 1000);

  for (const c of cases) {
    it(`Ca ${c.shift} stays quiet at ${c.quiet[1]} and prompts at ${c.due[1]}`, () => {
      const { graceEndAt } = shiftBoundaries(c.shift, hcm(c.checkIn[0], c.checkIn[1]));

      expect(isPromptDue(graceEndAt, at(c.quiet[0], c.quiet[1]))).toBe(false);
      expect(isPromptDue(graceEndAt, at(c.due[0], c.due[1]))).toBe(true);
    });
  }

  it('stays quiet for the whole shift, not just near the end', () => {
    const { graceEndAt } = shiftBoundaries('A', hcm('2026-09-17', '06:00'));
    // Ten minutes after CHECK-IN — the mistake this rule exists to prevent.
    expect(isPromptDue(graceEndAt, hcm('2026-09-17', '06:10'))).toBe(false);
    expect(isPromptDue(graceEndAt, hcm('2026-09-17', '10:00'))).toBe(false);
    expect(isPromptDue(graceEndAt, hcm('2026-09-17', '13:59'))).toBe(false);
    // And at the nominal end itself there is still grace left.
    expect(isPromptDue(graceEndAt, hcm('2026-09-17', '14:00'))).toBe(false);
  });

  it('stays due once it is due — it does not lapse', () => {
    const { graceEndAt } = shiftBoundaries('B', hcm('2026-09-17', '14:00'));
    expect(isPromptDue(graceEndAt, hcm('2026-09-18', '09:00'))).toBe(true);
  });

  /**
   * A and A4 both start at 06:00; C and C4 both end at 06:00. So the SELECTED
   * shift, not the clock, has to decide — and these two produce different
   * answers from the same check-in instant, which is the proof.
   */
  it('A and A4 chosen at the same instant prompt at different times', () => {
    const start = hcm('2026-09-17', '06:00');
    const a = shiftBoundaries('A', start);
    const a4 = shiftBoundaries('A4', start);

    expect(a.graceEndAt.toISOString()).toBe(hcm('2026-09-17', '14:10').toISOString());
    expect(a4.graceEndAt.toISOString()).toBe(hcm('2026-09-17', '18:10').toISOString());
    expect(a.graceEndAt.getTime()).not.toBe(a4.graceEndAt.getTime());

    // At 14:10 the Ca A receptionist is asked again; the Ca A4 one is not.
    const fourTen = hcm('2026-09-17', '14:10');
    expect(isPromptDue(a.graceEndAt, fourTen)).toBe(true);
    expect(isPromptDue(a4.graceEndAt, fourTen)).toBe(false);
  });
});

/**
 * THE DAY A SHIFT BELONGS TO — what the Admin report groups by.
 *
 * A night shift's entries after midnight belong to the night it began; reading
 * the day off the entry would file one shift under two dates.
 */
describe('shiftBusinessDate', () => {
  it('is the calendar day for a same-day shift', () => {
    expect(shiftBusinessDate('A', hcm('2026-09-19', '06:03'))).toBe('2026-09-19');
    expect(shiftBusinessDate('B', hcm('2026-09-19', '21:50'))).toBe('2026-09-19');
    expect(shiftBusinessDate('A4', hcm('2026-09-19', '06:00'))).toBe('2026-09-19');
  });

  it('keeps Ca C on the day it began, for an on-time check-in', () => {
    expect(shiftBusinessDate('C', hcm('2026-09-19', '22:05'))).toBe('2026-09-19');
  });

  it('keeps a LATE Ca C check-in after midnight on the same night', () => {
    // The same rule that gives both check-ins the same 06:00 end.
    expect(shiftBusinessDate('C', hcm('2026-09-20', '01:30'))).toBe('2026-09-19');
  });

  it('does the same for the long night shift', () => {
    expect(shiftBusinessDate('C4', hcm('2026-09-19', '18:02'))).toBe('2026-09-19');
    expect(shiftBusinessDate('C4', hcm('2026-09-20', '03:00'))).toBe('2026-09-19');
  });

  it('crosses a month boundary correctly', () => {
    expect(shiftBusinessDate('C', hcm('2026-10-01', '02:00'))).toBe('2026-09-30');
  });
});
