/**
 * Generates the receptionist-ready PMS note — the short plain-text line the
 * receptionist pastes when creating the reservation in the external hotel
 * system. Everything here is pure and deterministic (the current date is
 * injected) so the exact output can be unit-tested.
 *
 * BOOKING.COM ONLY. Agoda and CTrip notes have a different format entirely and
 * are generated once on the server at dispatch, then stored — see
 * `server/src/booking/otaPmsNote.ts`. Nothing here is reachable from an OTA
 * booking, which is what keeps "PAY BEFORE CHECK-IN" off a source that never
 * says it.
 *
 * Layout:
 *   LINE 1: BK <CODE>_<ROOM_ABBR>_<NIGHTS> ĐÊM <TOTAL> <PAY> CI
 *   LINE 2: [ĂN SÁNG ]<DD/MM> <CONTACT>[ <ARRIVAL>]
 */
import type { BusinessType, PaymentStatus } from '../api/bookings';
import { formatAmountCopy, hcmDayMonth, nightCount } from './format';

const NO_CODE_MESSAGE = 'Chưa có mã Booking để tạo ghi chú.';

/**
 * The room fields the note actually reads.
 *
 * Named separately from `RoomView` so an UNSENT Booking.com review — which has
 * no booking, and therefore no row ids — can be previewed by the same builder
 * that reception uses on a stored one. `RoomView` satisfies it, so every
 * existing caller is unaffected.
 */
export interface NoteRoom {
  roomType: string | null;
  roomClassPmsCode?: string | null;
  /** Only the count is read — see `noteNights`. */
  nights: readonly unknown[];
}

/**
 * The booking fields the note reads, and nothing else.
 *
 * Widening the parameter rather than making the review screen fabricate a whole
 * `BookingDetail`: a preview that had to invent an id, a status and a dozen
 * verification fields to print two lines would be claiming things that are not
 * true. `BookingDetail` is assignable to this, so reception's path is untouched.
 */
export interface PmsNoteInput {
  bookingCode: string | null;
  rooms: readonly NoteRoom[];
  checkInDate: string | null;
  checkOutDate: string | null;
  totalAmount: number | null;
  paymentStatus: PaymentStatus;
  branch?: { breakfastIncluded?: boolean } | null;
  specialRequest: string | null;
  phone: string | null;
  businessType?: BusinessType;
}

/** Lower-cases and strips Vietnamese diacritics (incl. đ) for keyword matching. */
const COMBINING_MARKS = /[̀-ͯ]/g;
function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '').replace(/đ/g, 'd');
}

/**
 * LEGACY room-type abbreviations, most-specific first. Room *class* keywords
 * (standard/superior/deluxe/suite/family) are checked before *bed* keywords
 * (twin/double) so "Phòng Tiêu Chuẩn Giường Đôi" resolves to STAN, not DBL.
 *
 * Since C.3.8 this table is only the FALLBACK. A room whose branch room class
 * was resolved carries an immutable `roomClassPmsCode` snapshot, and that code
 * always wins — see {@link roomAbbreviation}. This global, branch-agnostic
 * table is kept solely so bookings that predate the mapping (or whose room name
 * could not be resolved deterministically) keep producing exactly the note they
 * produced before, rather than losing their code.
 */
const ROOM_ABBREVIATIONS: ReadonlyArray<{ keys: string[]; abbr: string }> = [
  { keys: ['standard', 'tieu chuan'], abbr: 'STAN' },
  { keys: ['superior'], abbr: 'SUP' },
  { keys: ['deluxe'], abbr: 'DLX' },
  { keys: ['suite'], abbr: 'SUITE' },
  { keys: ['family', 'gia dinh'], abbr: 'FAM' },
  { keys: ['twin', 'hai giuong don'], abbr: 'TWIN' },
  { keys: ['double', 'giuong doi'], abbr: 'DBL' },
];

/** A single room type → abbreviation, with a safe readable fallback. */
export function abbreviateRoomType(roomType: string | null | undefined): string {
  const folded = fold((roomType ?? '').trim());
  if (folded.length === 0) return 'PHONG';
  for (const { keys, abbr } of ROOM_ABBREVIATIONS) {
    if (keys.some((k) => folded.includes(k))) return abbr;
  }
  // Unknown type: never return empty — take the first word's letters, upper-cased.
  const firstWord = folded.replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/)[0] ?? '';
  return (firstWord.slice(0, 4) || 'PHONG').toUpperCase();
}

/**
 * The PMS code for ONE room.
 *
 * The branch-specific snapshot taken when the booking was created always wins.
 * That is what makes a note stable: the code was resolved against the booking's
 * own branch at the time, stored on the row, and is never recomputed — so an
 * Admin activating a new room-class mapping cannot change what an existing
 * booking prints.
 *
 * Only a room with no snapshot (pre-C.3.8, or a name that could not be resolved
 * deterministically) falls back to the legacy keyword table.
 */
export function roomAbbreviation(room: NoteRoom): string {
  const snapshot = room.roomClassPmsCode?.trim();
  if (snapshot) return snapshot;
  return abbreviateRoomType(room.roomType);
}

/**
 * The room-abbreviation segment for a whole booking.
 *
 * QUANTITY ALWAYS COMES FIRST, and always appears — "1DLX", never "DLX". The
 * operator reads the leading digit as the room count, so a code printed without
 * one has to be counted by eye, and a lone "DLX" is exactly the case that gets
 * misread as an unknown quantity.
 *
 * Groups are joined by a SINGLE SPACE, not "+":
 *   - one type       → "2STAN"
 *   - mixed types    → "1DLX 1STAN" / "2DLX 1STAN"
 *   - repeated types → aggregated, so STAN+STAN+DLX becomes "2STAN 1DLX"
 *
 * First-seen order is preserved deliberately: the fragments are the booking's
 * own room list, and alphabetising them would reorder what the receptionist
 * checks against the reservation. No room type is ever silently dropped.
 */
export function roomsAbbreviation(rooms: readonly NoteRoom[]): string {
  if (rooms.length === 0) return 'PHONG';
  // Preserve first-seen order while counting duplicates.
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const room of rooms) {
    const abbr = roomAbbreviation(room);
    if (!counts.has(abbr)) order.push(abbr);
    counts.set(abbr, (counts.get(abbr) ?? 0) + 1);
  }
  return order.map((abbr) => `${counts.get(abbr)!}${abbr}`).join(' ');
}

/**
 * Nights = check-in (inclusive) → check-out (exclusive). Falls back to the
 * longest room's nightly-row count only when the dates cannot yield a value.
 */
export function noteNights(b: Pick<PmsNoteInput, 'checkInDate' | 'checkOutDate' | 'rooms'>): number {
  const fromDates = nightCount(b.checkInDate, b.checkOutDate);
  if (fromDates > 0) return fromDates;
  return b.rooms.reduce((max, r) => Math.max(max, r.nights.length), 0);
}

/** PAY_BEFORE → "PAY BEFORE CHECK-IN", PAY_AFTER → "PAY AFTER CHECK-IN". */
export function paymentCode(status: PaymentStatus): string {
  return status === 'PAY_BEFORE' ? 'PAY BEFORE CHECK-IN' : 'PAY AFTER CHECK-IN';
}

/** The note prints a phone number, never a messaging channel. */
export const CONTACT_LABEL = 'CÓ SĐT';
/** Said plainly, in the same words as the positive case. */
export const NO_CONTACT_LABEL = 'KHÔNG CÓ SĐT';

/**
 * The contact label from an optional phone: "CÓ SĐT", or "KHÔNG CÓ SĐT".
 *
 * THE MESSAGING CHANNEL IS NO LONGER GUESSED. This used to print "CÓ ZL" for
 * Vietnamese numbers and "CÓ WA" for everything else, inferred purely from the
 * dialling prefix — which is not evidence of anything: plenty of +84 guests use
 * WhatsApp and plenty of foreign guests use Zalo. The note told the receptionist
 * which app to open, and was wrong whenever the guess was wrong. It now carries
 * the number and lets the receptionist choose.
 *
 * The normalisation below is kept solely to decide PRESENT vs ABSENT: a string
 * of punctuation with no digits is not a phone number, and must not produce a
 * note that says there is one.
 */
export function contactLabel(phone: string | null | undefined): string {
  if (!phone) return NO_CONTACT_LABEL;
  // Keep digits and a single leading '+'.
  let norm = phone.trim().replace(/[^\d+]/g, '');
  norm = norm.replace(/(?!^)\+/g, '');
  if (norm.replace(/\+/g, '') === '') return NO_CONTACT_LABEL;
  return CONTACT_LABEL;
}

/**
 * The contact segment: the label followed by the number itself, e.g.
 * "CÓ SĐT +31 345 678 912" or "CÓ SĐT 0901234567".
 *
 * THE NUMBER IS PRINTED VERBATIM — trimmed and nothing else. A leading "+" is
 * part of an international number and is kept; no spacing, grouping or country
 * prefix is added or removed. The receptionist dials or messages exactly what
 * is on the note, so a number this screen "tidied" is a number that no longer
 * connects.
 *
 * "KHÔNG CÓ SĐT" stands alone: there is no number to append, and printing an
 * empty label would leave a dangling "CÓ SĐT" with nothing after it.
 */
export function contactSegment(phone: string | null | undefined): string {
  const label = contactLabel(phone);
  if (label === NO_CONTACT_LABEL) return label;
  return `${label} ${(phone ?? '').trim()}`;
}

/**
 * Extracts a concise arrival-time note from specialRequest, e.g.
 * "Khách dự kiến đến khoảng 13:00." → "KHÁCH ĐẾN KHOẢNG 13:00".
 * Returns '' when there is no arrival-time information (never a placeholder).
 */
export function arrivalNote(specialRequest: string | null | undefined): string {
  if (!specialRequest) return '';
  const time = specialRequest.match(/\b(\d{1,2}:\d{2})\b/);
  if (!time) return '';
  const folded = fold(specialRequest);
  if (!folded.includes('den')) return ''; // must mention arrival ("đến")
  let qualifier = '';
  if (folded.includes('khoang')) qualifier = 'KHOẢNG ';
  else if (folded.includes('luc')) qualifier = 'LÚC ';
  return `KHÁCH ĐẾN ${qualifier}${time[1]}`;
}

export interface PmsNoteResult {
  ok: boolean;
  /** The two-line note when ok. */
  text?: string;
  /** A user-facing reason when the note cannot be generated. */
  error?: string;
}

/** Builds the full note, or a reason it cannot be generated. `now` is injectable. */
export function buildPmsNote(b: PmsNoteInput, now: Date = new Date()): PmsNoteResult {
  const code = b.bookingCode?.trim();
  if (!code) return { ok: false, error: NO_CODE_MESSAGE };

  // Exactly one space after "BK" and between every token — collapse any accidental
  // run of spaces so the first line is always cleanly "BK <code>_… CI".
  const line1 = `BK ${code}_${roomsAbbreviation(b.rooms)}_${noteNights(b)} ĐÊM ${formatAmountCopy(
    b.totalAmount,
  )} ${paymentCode(b.paymentStatus)} CI`.replace(/ {2,}/g, ' ');

  // Breakfast comes from the branch's own configuration (Branch.breakfastIncluded),
  // which an Admin edits in "Khách sạn & chi nhánh" and which applies to every
  // branch alike. It is never inferred from a branch code, id or list position.
  const breakfast = b.branch?.breakfastIncluded === true;
  const arrival = arrivalNote(b.specialRequest);
  // For a partner booking the contact segment (CÓ SĐT / KHÔNG CÓ SĐT) is
  // replaced by "ĐƠN ĐỐI TÁC"; breakfast, date, arrival and requests are kept.
  const contact = b.businessType === 'PARTNER' ? 'ĐƠN ĐỐI TÁC' : contactSegment(b.phone);
  const line2 = `${breakfast ? 'ĂN SÁNG ' : ''}${hcmDayMonth(now)} ${contact}${
    arrival ? ` ${arrival}` : ''
  }`;

  return { ok: true, text: `${line1}\n${line2}` };
}
