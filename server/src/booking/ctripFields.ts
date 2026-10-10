/**
 * Structured extraction of the CTrip / Trip.com partner reservation fields.
 *
 * Every label handled here is one the operator confirmed from a real CTrip
 * reservation. Nothing is inferred from a guessed layout: a label that is not
 * on this list is not read, and a field that is absent stays absent so the
 * Admin is asked rather than told something untrue.
 *
 * ── THE PRICE RULES, AND WHY THEY MATTER ──────────────────────────────────
 * CTrip shows three amounts. Only two of them are ours, and confusing them
 * would misstate what the hotel is owed:
 *
 *   Original room rate  -> GUEST-BOOKED price (what the guest paid)
 *   Final room rate     -> IGNORED when Original exists; it is the
 *                          post-discount figure, not what the guest booked at
 *   Your payout         -> BRANCH price (what the hotel actually receives)
 *   Discounts           -> IGNORED entirely
 *
 * ── NIGHTLY RATES ─────────────────────────────────────────────────────────
 * The confirmed CTrip layout carries no per-night breakdown. Nightly prices are
 * therefore left EMPTY. They are never derived by dividing the payout by the
 * number of nights: a fabricated per-night figure looks like data and would be
 * copied into the PMS as if CTrip had stated it.
 */
import { normalizeForPhrase, normalizeWhitespace } from './text';

export interface CtripFields {
  /** "Reservation" — the CTrip reservation number. */
  reservationCode: string | null;
  /** "Property name" — absent means the Admin must choose the branch. */
  propertyName: string | null;
  guestName: string | null;
  /** ISO "YYYY-MM-DD". */
  checkIn: string | null;
  checkOut: string | null;
  /** "Room type" as CTrip words it — resolved against the branch's mappings. */
  roomType: string | null;
  roomQuantity: number | null;
  /** "Original room rate" — the guest-booked price. */
  originalRoomRate: number | null;
  /** "Final room rate" — read for display only; never the guest-booked price. */
  finalRoomRate: number | null;
  /** "Your payout" — the branch price. */
  payout: number | null;
  /** From "Meals": false for "No meals". Null when not stated. */
  breakfastIncluded: boolean | null;
  /** The "N night(s)" CTrip prints beside the stay period, when it does. */
  statedNights: number | null;
}

/**
 * Narrows the page to the RESERVATION DETAIL block.
 *
 * A copied CTrip page carries, in order: navigation, a property switcher, a
 * filter bar with its own dates, a reservation LIST, then the detail block for
 * the open reservation, then a footer. The list repeats a shortened version of
 * the same fields, and the filter bar contains dates ("May 1, 2026") that are a
 * search range, not a stay.
 *
 * Everything before "Reservation:" is therefore dropped. That line opens the
 * detail block, which is the authoritative copy; when it is absent the whole
 * text is used, so a list-only paste still yields what it can.
 */
export function detailBlock(lines: readonly string[]): readonly string[] {
  const start = lines.findIndex((l) => /^\s*reservation\s*:/i.test(l));
  return start >= 0 ? lines.slice(start) : lines;
}

/** Month names and abbreviations CTrip uses, keyed by their first 3 letters. */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Aug 1, 2026" / "August 1 2026" → ISO, or null. */
function parseNamedMonthDate(raw: string): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface CtripStayPeriod {
  checkIn: string | null;
  checkOut: string | null;
  /** The night count CTrip printed, which the caller validates against the dates. */
  statedNights: number | null;
}

/**
 * Parses "Aug 1, 2026 - Aug 8, 2026 7 night(s)".
 *
 * Both dates must be present: a single date is not a stay period, and pairing
 * it with something else on the page would invent a range.
 */
export function parseCtripStayPeriod(raw: string | null): CtripStayPeriod {
  const empty: CtripStayPeriod = { checkIn: null, checkOut: null, statedNights: null };
  if (!raw) return empty;

  // Split on the range dash, tolerating en/em dashes and the word "to".
  const halves = raw.split(/\s+(?:[-–—]|to)\s+/i);
  if (halves.length < 2) return empty;

  const checkIn = parseNamedMonthDate(halves[0]!) ?? parseCtripDate(halves[0]!);
  const rest = halves.slice(1).join(' ');
  const checkOut = parseNamedMonthDate(rest) ?? parseCtripDate(rest);
  if (!checkIn || !checkOut) return empty;

  const nights = /(\d{1,3})\s*nights?\s*\(?s?\)?/i.exec(raw);
  return {
    checkIn,
    checkOut,
    statedNights: nights ? Number(nights[1]) : null,
  };
}

/**
 * Splits "Standard Double Room No Window 1 room(s)" into the name and count.
 *
 * Only a TRAILING "<number> room(s)" is removed. Room names legitimately
 * contain numbers ("Deluxe 1 - 2"), so nothing else is stripped and the name is
 * otherwise preserved exactly — it is the key the branch mappings use.
 */
export function parseCtripRoomLine(raw: string | null): {
  roomType: string | null;
  roomQuantity: number | null;
} {
  if (!raw) return { roomType: null, roomQuantity: null };
  const m = /^(.*?)\s*(\d{1,3})\s*rooms?\s*\(?s?\)?\s*$/i.exec(raw.trim());
  if (!m) {
    const name = raw.trim();
    return { roomType: name.length > 0 ? name : null, roomQuantity: null };
  }
  const name = m[1]!.trim();
  const quantity = Number(m[2]);
  return {
    roomType: name.length > 0 ? name : null,
    roomQuantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
  };
}

/**
 * A line that sits BETWEEN a label and its value rather than being the value.
 *
 * CTrip prints a parenthetical qualifier under the price labels ("Original room
 * rate" / "(incl. taxes and fees)" / "6637080.00") and sometimes puts the
 * currency on its own line ("Your payout" / "VND" / "4645956.00"). Returning
 * the first following line blindly yielded "(incl. taxes and fees)" and "VND",
 * which parse to no amount at all — so the price silently vanished.
 */
function isQualifier(line: string): boolean {
  const text = line.trim();
  if (text.length === 0) return true;
  if (/^\(.*\)$/.test(text)) return true;
  if (/^(?:VND|₫|USD|\$)$/i.test(text)) return true;
  return false;
}

/** Reads one labelled value, tolerating qualifier lines before the value. */
function labelled(lines: readonly string[], labels: readonly string[]): string | null {
  const wanted = labels.map((l) => normalizeForPhrase(l));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    const head = normalizeForPhrase(colon >= 0 ? line.slice(0, colon) : line);
    if (!wanted.includes(head)) continue;

    const inline = colon >= 0 ? line.slice(colon + 1).trim() : '';
    if (inline.length > 0) return inline;

    // The value is on a following line, possibly behind a qualifier. A line
    // carrying a colon is the NEXT label, so this field simply has no value.
    for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
      const next = lines[j]!.trim();
      if (isQualifier(next)) continue;
      if (next.includes(':')) break;
      return next;
    }
    return null;
  }
  return null;
}

/**
 * Whole VND from a CTrip amount. Handles both the raw form ("6637080") and a
 * grouped form ("6.637.080" / "6,637,080"). Returns null rather than 0 when
 * nothing numeric is present — 0 is a real price and must not be invented.
 */
export function parseCtripAmount(raw: string | null): number | null {
  if (!raw) return null;
  // A trailing separator followed by exactly TWO digits is a decimal fraction
  // and is dropped; three digits is a thousands group and is kept. The real
  // reservation page prints "6637080.00", and stripping every non-digit made
  // that 663,708,000 — a hundredfold overstatement of what the hotel is owed.
  const digits = raw.replace(/[.,]\d{2}(?!\d)/g, '').replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/** DD/MM/YYYY (CTrip's confirmed form) or an ISO date, to ISO "YYYY-MM-DD". */
export function parseCtripDate(raw: string | null): string | null {
  if (!raw) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
  if (!dmy) return null;
  const day = dmy[1]!.padStart(2, '0');
  const month = dmy[2]!.padStart(2, '0');
  return `${dmy[3]}-${month}-${day}`;
}

/** Whole nights between two ISO dates, or null when either is missing. */
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Reads the confirmed CTrip labels. Absent fields stay null — this never
 * substitutes one field for another, and never computes a value CTrip did not
 * state.
 */
export function extractCtripFields(rawText: string): CtripFields {
  const allLines = normalizeWhitespace(rawText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // The detail block is authoritative — it is where the OPEN reservation's own
  // values live, so a repeated field from the list below it never wins.
  const block = detailBlock(allLines);

  /**
   * Detail block first, whole page second.
   *
   * The block cannot simply REPLACE the page: the property header is printed
   * ABOVE the reservation on a real page, so slicing at "Reservation:" threw
   * the branch away entirely. Falling back keeps that header readable while
   * still letting the block win wherever both state the same field.
   *
   * The filter bar stays excluded either way — its labels are "Check-in date
   * from" / "Check-in date to", which are not the labels read here.
   */
  const pick = (labels: readonly string[]): string | null =>
    labelled(block, labels) ?? labelled(allLines, labels);

  const meals = pick(['Meals', 'Meal', 'Bữa ăn']);

  // "Aug 1, 2026 - Aug 8, 2026 7 night(s)" states the whole stay on one row.
  // The separate Check-in / Check-out labels remain supported for layouts that
  // print them, but the stay period wins when both are present.
  const stay = parseCtripStayPeriod(pick(['Stay period', 'Stay dates', 'Stay']));
  const room = parseCtripRoomLine(pick(['Room type', 'Room', 'Hạng phòng']));

  const labelledQuantity = (() => {
    const raw = pick(['Room quantity', 'Rooms', 'Number of rooms', 'Số lượng phòng']);
    const parsed = raw ? Number.parseInt(raw.replace(/[^\d]/g, ''), 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  return {
    reservationCode: cleanReservationCode(
      pick(['Reservation', 'Reservation number', 'Reservation ID']),
    ),
    propertyName: pick(['Property name', 'Property', 'Hotel name']),
    guestName: pick(['Guest name', 'Guest', 'Guests', 'Guest(s)', 'Khách']),
    checkIn: stay.checkIn ?? parseCtripDate(pick(['Check-in', 'Check in', 'Nhận phòng'])),
    checkOut: stay.checkOut ?? parseCtripDate(pick(['Check-out', 'Check out', 'Trả phòng'])),
    statedNights: stay.statedNights,
    roomType: room.roomType,
    roomQuantity: room.roomQuantity ?? labelledQuantity,
    // The guest-booked price. Never replaced by "Final room rate".
    originalRoomRate: parseCtripAmount(pick(['Original room rate'])),
    // Read for the review screen only — deliberately not used as any price.
    finalRoomRate: parseCtripAmount(pick(['Final room rate'])),
    // The branch price.
    payout: parseCtripAmount(pick(['Your payout', 'Payout'])),
    breakfastIncluded: meals === null ? null : !/no\s*meals?/i.test(meals),
  };
}

/**
 * "1658113703317875 · Confirmed" → "1658113703317875".
 *
 * CTrip prints the status beside the number. Keeping only the leading digit run
 * means the status can never end up inside a PMS note.
 */
function cleanReservationCode(raw: string | null): string | null {
  if (!raw) return null;
  const digits = /^\s*(\d{6,24})\b/.exec(raw);
  if (digits) return digits[1]!;
  const trimmed = raw.split(/[·|]/)[0]!.trim();
  return trimmed.length > 0 ? trimmed : null;
}
