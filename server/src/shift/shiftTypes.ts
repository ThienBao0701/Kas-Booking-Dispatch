/**
 * THE reception shift definitions, and the only place their clock times exist.
 *
 * Every question about a shift — when does it end, when may we ask for the next
 * one, does it cross midnight — is answered from this table. Nothing else in the
 * codebase may hardcode 06:00, 14:00, 22:00 or 18:00; if a second copy appears,
 * the two drift and the handover prompt starts firing at the wrong minute on one
 * screen but not another.
 *
 * WHY A SHIFT IS CHOSEN AND NEVER INFERRED
 *
 * A and A4 both start at 06:00. C and C4 both end at 06:00. At 06:00 the clock
 * therefore cannot tell you which shift a receptionist is on, and at 06:00 the
 * next day it cannot tell you which one is ending. The receptionist picks, once,
 * at check-in; from then on the SESSION decides, not the clock. There is
 * deliberately no "guess the current shift" function here.
 *
 * THE GRACE RULE
 *
 *   nextShiftPromptAt = nominal shift end + GRACE_MINUTES
 *
 * It is anchored to the SHIFT'S END, never to "now". Anchoring it to the moment
 * of check-in would re-prompt ten minutes into every shift; anchoring it to the
 * nominal end alone would re-prompt the instant a shift expired, while the
 * outgoing receptionist is still finishing an order. Ca A selected at 06:00 is
 * therefore quiet until 14:10:00 exactly — 14:09:59 is still within grace.
 */
import { hcmDateOnly, hcmWallClockToUtc, nextHcmDay } from '../lib/clock';
import type { ShiftType } from '@prisma/client';

/** The grace period AFTER a shift's nominal end, before the next prompt. */
export const GRACE_MINUTES = 10;

const GRACE_MS = GRACE_MINUTES * 60 * 1000;

export interface ShiftDefinition {
  code: ShiftType;
  /** Vietnamese label as operators say it. */
  name: string;
  /** Wall-clock "HH:MM" in Asia/Ho_Chi_Minh. */
  startLocalTime: string;
  endLocalTime: string;
  /** True when the end time falls on the day AFTER the start. */
  crossesMidnight: boolean;
  graceMinutes: number;
}

/**
 * Declared in the order they are offered at check-in: the three standard eight
 * hour shifts first, then the two twelve-hour ones.
 */
export const SHIFT_DEFINITIONS: readonly ShiftDefinition[] = [
  { code: 'A', name: 'Ca A', startLocalTime: '06:00', endLocalTime: '14:00', crossesMidnight: false, graceMinutes: GRACE_MINUTES },
  { code: 'B', name: 'Ca B', startLocalTime: '14:00', endLocalTime: '22:00', crossesMidnight: false, graceMinutes: GRACE_MINUTES },
  { code: 'C', name: 'Ca C', startLocalTime: '22:00', endLocalTime: '06:00', crossesMidnight: true, graceMinutes: GRACE_MINUTES },
  { code: 'A4', name: 'Ca A4', startLocalTime: '06:00', endLocalTime: '18:00', crossesMidnight: false, graceMinutes: GRACE_MINUTES },
  { code: 'C4', name: 'Ca C4', startLocalTime: '18:00', endLocalTime: '06:00', crossesMidnight: true, graceMinutes: GRACE_MINUTES },
] as const;

const BY_CODE = new Map<ShiftType, ShiftDefinition>(SHIFT_DEFINITIONS.map((s) => [s.code, s]));

/** Every shift code, for validation and test parametrisation. */
export const SHIFT_CODES: readonly ShiftType[] = SHIFT_DEFINITIONS.map((s) => s.code);

export function shiftDefinition(code: ShiftType): ShiftDefinition {
  const found = BY_CODE.get(code);
  // Unreachable through the API (zod rejects first); a guard, not a code path.
  if (!found) throw new Error(`Unknown shift type: ${String(code)}`);
  return found;
}

/** "06:00 – 14:00", for the shift indicator and the reports. */
export function shiftWindowLabel(code: ShiftType): string {
  const s = shiftDefinition(code);
  return `${s.startLocalTime} – ${s.endLocalTime}`;
}

export interface ShiftBoundaries {
  /** The shift's nominal end as a real instant. */
  nominalEndAt: Date;
  /** `nominalEndAt` + the grace period — when the next prompt may appear. */
  graceEndAt: Date;
}

/**
 * The boundaries of the shift a receptionist is checking in to AT `startedAt`.
 *
 * WHY THE END IS DERIVED FROM THE CHECK-IN INSTANT AND NOT FROM "TODAY"
 *
 * Someone checking in to Ca C at 22:05 on the 17th, and someone checking in late
 * to the same Ca C at 01:30 on the 18th, are on the SAME shift and must get the
 * SAME 06:00-on-the-18th end. Using the HCM calendar day of the check-in instant
 * alone would give the second person an end of 06:00 on the 19th — a shift
 * nearly thirty hours long.
 *
 * So the rule is: take the shift's end wall-clock time on the check-in day; if
 * that instant is not strictly after the check-in, it belongs to the next day.
 * This is exactly what "crosses midnight" means, expressed as arithmetic instead
 * of as a flag, and it lands correctly for a late check-in on a same-day shift
 * too (checking in to Ca A at 13:55 still ends at 14:00 that day).
 */
export function shiftBoundaries(code: ShiftType, startedAt: Date): ShiftBoundaries {
  const def = shiftDefinition(code);
  const day = hcmDateOnly(startedAt);

  let nominalEndAt = hcmWallClockToUtc(day, def.endLocalTime);
  if (nominalEndAt.getTime() <= startedAt.getTime()) {
    nominalEndAt = hcmWallClockToUtc(nextHcmDay(day), def.endLocalTime);
  }

  return { nominalEndAt, graceEndAt: new Date(nominalEndAt.getTime() + GRACE_MS) };
}

/**
 * The HCM calendar day a shift BELONGS to: the day it nominally starts.
 *
 * Ca C of the 22nd runs 22:00 on the 22nd to 06:00 on the 23rd, and every
 * record entered on it — at 23:40 or at 02:15 — belongs under "22/09". Reading
 * the day off each record's own timestamp would split one shift across two
 * dates, and one receptionist's night across two headings.
 *
 * Built on {@link shiftBoundaries}, so a late check-in (Ca C at 01:30) lands on
 * the same day as an on-time one — the same rule that gives both the same end.
 * For a shift that crosses midnight the end is on the following day; 24 hours
 * before it is the start's calendar day, exactly, because the offset is fixed.
 */
export function shiftBusinessDate(code: ShiftType, startedAt: Date): string {
  const { nominalEndAt } = shiftBoundaries(code, startedAt);
  if (!shiftDefinition(code).crossesMidnight) return hcmDateOnly(nominalEndAt);
  return hcmDateOnly(new Date(nominalEndAt.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * Has the grace period run out, so the application may ask for the next shift?
 *
 * STRICTLY `>=`: the specification is that Ca A prompts AT 14:10:00 and stays
 * quiet at 14:09:59. The boundary instant itself belongs to the new prompt.
 */
export function isPromptDue(graceEndAt: Date, now: Date): boolean {
  return now.getTime() >= graceEndAt.getTime();
}
