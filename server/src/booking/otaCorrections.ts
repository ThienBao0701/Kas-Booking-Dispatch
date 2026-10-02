/**
 * What the Admin changed on the review screen before dispatching.
 *
 * The review returns the values that will actually be sent; the parser holds
 * what the email really said. Where those differ, an Admin overrode something,
 * and that fact is worth keeping for as long as the booking exists: "the mail
 * said 875,000 and we dispatched 900,000" is the first question anyone asks
 * when a figure is disputed.
 *
 * Comparison is against the UNCORRECTED parse, so the rows record the Admin's
 * decision rather than the state of the form. Descriptive fields are excluded
 * deliberately: they are not editable on the review screen, so a difference
 * there would be a parser inconsistency, not a correction.
 */
import type { OtaReview } from './otaReview';

export interface BookingCorrectionInput {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** The parse as it stood BEFORE any Admin override. */
export interface UncorrectedReview {
  bookingCode: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  branchId: number | null;
  branchPrice: number | null;
  guestBookedPrice: number | null;
  rooms: { otaRoomName: string | null; quantity: number; pmsCode: string | null }[];
}

const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Every field the Admin changed, as append-only correction rows.
 *
 * Returns an empty list when nothing was overridden, which is the common case:
 * a clean reservation is dispatched exactly as parsed.
 */
export function collectCorrections(
  parsed: UncorrectedReview,
  review: OtaReview,
): BookingCorrectionInput[] {
  const corrections: BookingCorrectionInput[] = [];

  const compare = (field: string, before: string | null, after: string | null): void => {
    if (before !== after) corrections.push({ field, oldValue: before, newValue: after });
  };

  compare('bookingCode', text(parsed.bookingCode), text(review.bookingCode));
  compare('guestName', text(parsed.guestName), text(review.guestName));
  compare('checkIn', text(parsed.checkIn), text(review.checkIn));
  compare('checkOut', text(parsed.checkOut), text(review.checkOut));
  compare('branchId', text(parsed.branchId), text(review.branchId));
  compare('branchPrice', text(parsed.branchPrice), text(review.branchPrice));
  compare('guestBookedPrice', text(parsed.guestBookedPrice), text(review.guestBookedPrice));

  // Room lines are compared position by position. A line the Admin ADDED has no
  // "before", and one they removed has no "after" — both are recorded rather
  // than silently ignored, because either changes what the branch is told.
  const lineCount = Math.max(parsed.rooms.length, review.rooms.length);
  for (let i = 0; i < lineCount; i += 1) {
    const before = parsed.rooms[i];
    const after = review.rooms[i];
    compare(`rooms[${i}].otaRoomName`, text(before?.otaRoomName ?? null), text(after?.otaRoomName ?? null));
    compare(`rooms[${i}].quantity`, text(before?.quantity ?? null), text(after?.quantity ?? null));
    compare(`rooms[${i}].pmsCode`, text(before?.pmsCode ?? null), text(after?.pmsCode ?? null));
  }

  return corrections;
}
