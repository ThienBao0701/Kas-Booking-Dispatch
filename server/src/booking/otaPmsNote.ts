/**
 * The operator's exact PMS note for Agoda and CTrip bookings.
 *
 * This is a STRING CONTRACT, not a formatting preference: the receptionist
 * pastes the result straight into the hotel system, so every space, underscore
 * and separator below is deliberate and pinned by exact-string tests.
 *
 *   Agoda,  card payment (CN):
 *     AGD 1756162808_1SUP_4DEM 2.728.024 CN
 *     GIÁ KHÁCH ĐẶT 4.507.750 KHONG AN SANG
 *
 *   Agoda,  hotel payment — ONE line, nothing appended:
 *     AGD 1756162808_1SUP_4DEM 2.728.024 THANH TOÁN TẠI KHÁCH SẠN
 *
 *   CTrip,  card payment (CN):
 *     CTRIP_1433813478564103_1DEL_5DEM 4.677.208 CN
 *     07.08 KHONG AN SANG
 *
 *   CTrip,  hotel payment — the SAME two lines:
 *     CTRIP_1433813478564103_1DEL_5DEM 4.677.208 THANH TOÁN TẠI KHÁCH SẠN
 *     07.08 KHONG AN SANG
 *
 * CTRIP'S SECOND LINE IS A DATE, NOT A PRICE. It carries the day the booking is
 * created — "07.08" is when the reservation was entered, never the check-in —
 * and it replaced the guest-booked price the note used to print. CTrip
 * therefore no longer needs a guest-booked price for its note at all, and both
 * payment modes get the same two lines. Agoda is untouched: its CN note still
 * carries GIÁ KHÁCH ĐẶT and its hotel-payment note is still a single line.
 *
 * Two prefix differences that are easy to get wrong and are asserted directly:
 *   - "AGD" is followed by a SPACE before the booking code.
 *   - "CTRIP" is followed IMMEDIATELY by an underscore, with no space.
 *
 * Booking.com notes are NOT produced here. That format is different, already
 * operational, and lives in `client/src/lib/pmsNote.ts`; nothing in this module
 * is reachable from the Booking.com path.
 */

/** Which platform's note layout to produce. */
export type OtaNoteSource = 'AGODA' | 'CTRIP';

/**
 * How the guest pays, as the operator words it.
 * CN            = settled by card/OTA; the note carries the guest-booked price.
 * HOTEL_PAYMENT = collected at the hotel; the note is a single line.
 */
export type OtaPaymentMode = 'CN' | 'HOTEL_PAYMENT';

/** The exact Vietnamese wording, confirmed by the operator: "TẠI" is included. */
export const OTA_PAYMENT_LABEL: Record<OtaPaymentMode, string> = {
  CN: 'CN',
  HOTEL_PAYMENT: 'THANH TOÁN TẠI KHÁCH SẠN',
};

/** The confirmed no-breakfast wording. */
export const NO_BREAKFAST_TEXT = 'KHONG AN SANG';

const HCM_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * The booking's creation day as CTrip's note prints it: "07.08" — dot-separated
 * DD.MM in Asia/Ho_Chi_Minh, the timezone the hotel actually works in.
 *
 * Read from the clock rather than the reservation because the note is built
 * once, at dispatch, and that IS the creation moment. It is not the check-in
 * date and must never be taken from one.
 */
export function hcmDayMonthDots(now: Date): string {
  const iso = new Date(now.getTime() + HCM_OFFSET_MS).toISOString().slice(0, 10);
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

/** One room line: how many rooms of one resolved internal code. */
export interface OtaNoteRoomLine {
  quantity: number;
  /** The branch's internal PMS code. Null when the mapping is unresolved. */
  pmsCode: string | null;
}

export interface OtaNoteInput {
  source: OtaNoteSource;
  bookingCode: string | null;
  rooms: OtaNoteRoomLine[];
  nights: number | null;
  /** What the branch receives. Agoda: Net rate. CTrip: Your payout. */
  branchPrice: number | null;
  /** What the guest paid. Agoda: Reference sell rate. CTrip: Original room rate. */
  guestBookedPrice: number | null;
  paymentMode: OtaPaymentMode;
  /**
   * Whether breakfast is included. Only `false` has confirmed note wording; a
   * `true` value has no approved phrase yet, so the note is refused rather than
   * inventing one.
   */
  breakfastIncluded: boolean;
  /**
   * When the booking is being created. CTrip's second line prints this as
   * DD.MM; every other layout ignores it. Injectable so the exact string stays
   * testable.
   */
  createdAt?: Date;
}

export type OtaNoteResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** VND with dot thousands separators: 2728024 -> "2.728.024". */
export function formatVndDots(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * "_2SUP_1DEL" — one fragment per room line, in the order given.
 *
 * Different room types are NEVER merged, even when they share a code by
 * coincidence: the operator reads the fragments as the physical room list.
 */
function roomFragments(rooms: OtaNoteRoomLine[]): string {
  return rooms.map((r) => `${r.quantity}${r.pmsCode}`).join('_');
}

/**
 * Builds the note, or explains exactly what is missing.
 *
 * Nothing is guessed: an absent price, an unresolved room mapping or a missing
 * booking code produces a refusal naming the field, because a note built on a
 * guess would be pasted into the hotel system as if it were fact.
 */
export function buildOtaPmsNote(input: OtaNoteInput): OtaNoteResult {
  const missing: string[] = [];

  if (!input.bookingCode || input.bookingCode.trim().length === 0) {
    missing.push(input.source === 'AGODA' ? 'Booking ID' : 'mã đặt phòng');
  }
  if (input.rooms.length === 0) missing.push('hạng phòng');
  if (input.rooms.some((r) => !r.pmsCode)) missing.push('mã hạng phòng nội bộ');
  if (input.rooms.some((r) => !Number.isInteger(r.quantity) || r.quantity <= 0)) {
    missing.push('số lượng phòng');
  }
  if (input.nights == null || input.nights <= 0) missing.push('số đêm');
  if (input.branchPrice == null) {
    missing.push(input.source === 'AGODA' ? 'Net rate' : 'Your payout');
  }
  // The guest-booked price is only ever RENDERED on an AGODA CN note, so that
  // is the only note it is REQUIRED for. CTrip's note prints the creation date
  // in its place and no longer reads the price at all — demanding it would
  // block a dispatch over a figure that appears nowhere.
  if (input.source === 'AGODA' && input.paymentMode === 'CN' && input.guestBookedPrice == null) {
    missing.push('Reference sell rate');
  }
  // No positive-breakfast wording has been approved. Refusing is the honest
  // outcome; inventing a phrase would put unapproved text in front of a guest.
  // CTrip now always prints a breakfast line, so it is checked for both modes.
  if (input.breakfastIncluded && (input.source === 'CTRIP' || input.paymentMode === 'CN')) {
    missing.push('nội dung ăn sáng (chưa được duyệt)');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Chưa đủ dữ liệu để tạo ghi chú: ${missing.join(', ')}.`,
    };
  }

  const prefix =
    input.source === 'AGODA'
      ? `AGD ${input.bookingCode}` // one space after AGD
      : `CTRIP_${input.bookingCode}`; // underscore immediately after CTRIP

  const line1 =
    `${prefix}_${roomFragments(input.rooms)}_${input.nights}DEM ` +
    `${formatVndDots(input.branchPrice!)} ${OTA_PAYMENT_LABEL[input.paymentMode]}`;

  // CTrip: the same two lines whichever way the guest pays. The second is the
  // creation day and the breakfast wording — a single "\n", so the two lines
  // are consecutive and never separated by a blank one.
  if (input.source === 'CTRIP') {
    const created = hcmDayMonthDots(input.createdAt ?? new Date());
    return { ok: true, text: `${line1}\n${created} ${NO_BREAKFAST_TEXT}` };
  }

  // Agoda, hotel payment: exactly one line — no guest-booked price, no
  // breakfast suffix, no trailing newline.
  if (input.paymentMode === 'HOTEL_PAYMENT') {
    return { ok: true, text: line1 };
  }

  const line2 = `GIÁ KHÁCH ĐẶT ${formatVndDots(input.guestBookedPrice!)} ${NO_BREAKFAST_TEXT}`;
  return { ok: true, text: `${line1}\n${line2}` };
}
