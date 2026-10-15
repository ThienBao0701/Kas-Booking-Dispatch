/**
 * Agoda **hotel-partner (YCS) booking email** parser.
 *
 * This is a different document from the guest-facing Agoda confirmation page that
 * `agoda.ts` already handles: the partner email carries the hotel's commercial
 * rows ("Reference sell rate", "Net rate", "Commission", …) plus a labelled
 * reservation table. It is parsed here by a dedicated deterministic extractor so
 * the operator's exact two-line PMS note can be produced.
 *
 * Hard rules encoded below:
 *  - The PMS note's first amount is ALWAYS the labelled **Net rate**; the second is
 *    ALWAYS the labelled **Reference sell rate**. Commission, promotions,
 *    withholding tax, tax-on-commission and compensation rows are never used and
 *    are never arithmetically derived.
 *  - Nights = checkOut − checkIn (calendar days only), never the nightly-row count.
 *  - Room quantity comes only from "No. of Rooms" — never occupancy/adults/beds.
 *  - An unknown room type is preserved verbatim and flagged for manual review; it
 *    is never guessed into an existing code.
 *  - Everything is pure and deterministic.
 */
import { findDate } from './dates';
import { allocateEvenly } from './money';
import { removeDiacritics } from './text';
import type { ExtractWarning } from './types';

/** Version stamp for the partner-email extraction rules. */
export const AGODA_PARTNER_PARSER_VERSION = 'agoda-partner-1.0.0';

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
/** Lower-cases, strips diacritics and collapses whitespace (comparison only). */
export function fold(s: string | null | undefined): string {
  return removeDiacritics(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function lines(rawText: string): string[] {
  return rawText.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
}

/**
 * Splits a pasted line into logical table cells. Copying an Agoda table out of a
 * mail client flattens it to one line per row whose columns are separated by tabs
 * or a run of spaces — so "Customer First Name\tTEST" and
 * "Standard (0)    1    2 Adults    0" both become proper cells. A single space is
 * NOT a separator, so values such as "2 Adults" stay intact.
 */
function cells(line: string): string[] {
  return line
    .split(/\t+| {2,}/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Labels that may appear as their own cell. They are the BOUNDARIES of a value:
 * a field never absorbs the next label, its value, or a following table row —
 * which is exactly how the flattened paste used to corrupt every field.
 */
const KNOWN_LABELS: readonly RegExp[] = [
  /^(agoda )?booking id$/,
  /^reservation information$/,
  /^booking confirmation$/,
  /^customer first name$/,
  /^customer last name$/,
  /^country of residence$/,
  /^check[- ]?in$/,
  /^check[- ]?out$/,
  /^other guests$/,
  /^room ?type$/,
  /^no\.? of rooms$/,
  /^occupancy$/,
  /^no\.? of extra bed$/,
  /^rate ?plan( name)?$/,
  /^benefits included$/,
  /^cancellation policy$/,
  /^reference sell rate.*$/,
  /^net rate.*$/,
  // ── Vietnamese labels (folded: accent-free, lower-case) ──────────────────
  // Agoda prints these BESIDE the English label. Without them a bilingual row
  // such as "Booking ID | Ma so dat phong" hands back the Vietnamese label as
  // if it were the value.
  /^ma so dat phong$/,
  /^loai phong$/,
  /^so phong$/,
  /^so luong phong$/,
  /^ten khach( hang)?$/,
  /^(?:ngay )?nhan phong$/,
  /^(?:ngay )?tra phong$/,
  /^khach kh?ac$/,
  /^quoc gia cu tru$/,
  /^suc chua$/,
  /^so nguoi$/,
  /^so giuong them$/,
  /^gia thuc te.*$/,
  /^gia ban tham khao.*$/,
  /^hoa hong$/,
  /^commission$/,
  /^compensation$/,
  /^other programs$/,
  /^customer notes?$/,
  /^card (type|number|holder name)$/,
  /^website language$/,
  /^booked and payable by$/,
  /^marsha code$/,
  /^city$/,
  /^from - to$/,
  /^rates$/,
  /^property name$/,
  /^hotel name$/,
];

/**
 * Vietnamese labels whose ACCENT-FREE form collides with a real value.
 *
 * "Họ" is the surname label, and it folds to "ho" — which is also how a guest
 * surnamed HO is written. Treating the folded form as a label made every such
 * guest lose their surname (the confirmed booking's THU UYEN HO became THU
 * UYEN), so these are matched with their diacritics intact.
 */
const ACCENTED_LABELS: readonly string[] = ['họ', 'họ khách', 'họ khách hàng'];

/**
 * Vietnamese label phrases, folded, longest first.
 *
 * Agoda prints the English label, the Vietnamese label and the value ON ONE
 * LINE separated by single spaces: "Customer First Name Tên Khách Hàng Nga".
 * A single space is not a column separator, so the whole thing arrives as one
 * cell and no label matches it. These phrases are what gets peeled off between
 * the English label and the value.
 *
 * Sorted longest-first so "họ khách hàng" is consumed before the bare "họ".
 */
const VIETNAMESE_LABEL_PHRASES: readonly string[] = [
  'ma so dat phong',
  'ten khach hang',
  'ho khach hang',
  'quoc gia cu tru',
  'so giuong them',
  'so luong phong',
  'gia ban tham khao',
  'ngay nhan phong',
  'ngay tra phong',
  'chinh sach huy phong',
  'bao gom cac quyen loi',
  'ten chinh sach gia',
  'yeu cau dac biet',
  'ngon ngu website',
  'ten khach',
  'ho khach',
  'khach khac',
  'thanh pho',
  'nhan phong',
  'tra phong',
  'gia thuc te',
  'loai phong',
  'so nguoi',
  'so phong',
  'suc chua',
  'hoa hong',
  'ho',
]
  .slice()
  .sort((a, b) => b.split(' ').length - a.split(' ').length);

/** Splits on whitespace, dropping empties. */
function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** A line that opens a reservation: its first cell is the Booking ID label. */
const BOOKING_ID_LABEL = /^(agoda )?booking id$|^ma so dat phong$/;

/**
 * Narrows a pasted mail THREAD to the one reservation it is about.
 *
 * This is the single most damaging thing the parser got wrong. A real Agoda
 * mail is opened in Gmail as a thread, and copying it yields every message in
 * that thread — six separate reservations in one of the supplied samples, each
 * with its own Booking ID, property, guest, dates, room row and rates.
 *
 * Reading fields from the whole document does not fail loudly; it silently
 * BLENDS the bookings. The supplied amended mail produced the first block's
 * booking id, the fourth block's guest, and the last block's prices — a
 * confident, entirely fictitious reservation that would have been dispatched.
 *
 * Blocks are split at the Booking ID label. The subject line names the booking
 * the mail is actually about, so the block whose own id matches it wins; with
 * no subject id the first block does, because Gmail puts the open message at
 * the top. Everything above the first block (subject, navigation) is dropped.
 */
export function reservationBlock(all: readonly string[]): string[] {
  const blocks = reservationBlocks(all);
  if (blocks.length === 0) return [...all];

  // CONTENT decides, never the subject line. A forwarded, edited or translated
  // subject is common and may be missing altogether, so the reservation that
  // actually carries a complete structure wins; ties go to the first, because
  // a mail client puts the message being read at the top.
  const complete = blocks.find((block) => isCompleteReservation(block));
  return [...(complete ?? blocks[0]!)];
}

/**
 * Every reservation in the document, in the order they appear.
 *
 * Split at the Booking ID label. The first block keeps everything above it:
 * some layouts print the property name and "(Property ID …)" ABOVE that label,
 * and cutting there threw the hotel name away.
 */
export function reservationBlocks(all: readonly string[]): string[][] {
  const starts: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const first = cells(all[i]!)[0];
    if (first && BOOKING_ID_LABEL.test(fold(first).replace(/\s*:\s*$/, ''))) starts.push(i);
  }
  if (starts.length === 0) return [];

  // "Booking ID" / "Mã số đặt phòng" / "1756224954" stacks the English and
  // Vietnamese labels on consecutive lines, and BOTH match. Adjacent hits are
  // therefore the same heading, not two reservations — treating them as two
  // made the first "block" a single label line with no booking in it at all.
  const opens = starts.filter((start, n) => n === 0 || start - starts[n - 1]! >= 3);

  // The FIRST block keeps everything above it. Some layouts print the property
  // name and "(Property ID …)" ABOVE the Booking ID label rather than below it,
  // and cutting at the label threw the hotel name away — leaving the branch
  // unresolved on documents that had always worked. Nothing of another
  // reservation can be up there, because this is the first one.
  return opens.map((start, n) =>
    all.slice(n === 0 ? headerStart(all, start) : start, opens[n + 1] ?? all.length),
  );
}

/**
 * How far above the Booking ID label the reservation's own header begins.
 *
 * Some layouts print the property name and "(Property ID …)" ABOVE that label,
 * so a little of what precedes it belongs to the reservation. But only a
 * little: one supplied document is a YCS reservations LIST page followed by the
 * mail, and taking everything above put a 340-line table in front of the
 * booking. That table's column headers ("Property name", "Check-in") then
 * matched as field labels and shadowed the real ones, so the hotel name came
 * back as "Guest(s)" and the stay dates vanished.
 */
function headerStart(all: readonly string[], open: number, lookback = 12): number {
  let seen = 0;
  let i = open - 1;
  for (; i >= 0 && seen < lookback; i--) {
    if (all[i]!.trim().length > 0) seen += 1;
  }
  return Math.max(0, i + 1);
}

/**
 * True when a block is a whole reservation rather than a passing mention.
 *
 * A forwarded mail often quotes a booking id in prose, and a thread can carry a
 * truncated tail block. Requiring the reservation's own STRUCTURE — its id, a
 * guest, a stay and a rate — is what lets the parser find the real reservation
 * without ever consulting the subject line.
 */
function isCompleteReservation(block: readonly string[]): boolean {
  const lines = [...block];
  if (idWithin(block) === null) return false;
  const hasGuest = labelValue(lines, /^customer first name$/) !== null;
  const hasStay = labelValue(lines, /^check[- ]?in$|^(?:ngay )?nhan phong$/) !== null;
  const hasRate = findRate(lines, /net rate|gia thuc te/) !== null;
  return hasGuest && hasStay && hasRate;
}

/** The Booking ID stated INSIDE one block, read from its own label. */
function idWithin(block: readonly string[]): string | null {
  const value = labelValue([...block], BOOKING_ID_LABEL);
  const digits = value ? /^\s*(\d{6,15})\b/.exec(value) : null;
  return digits ? digits[1]! : null;
}

/**
 * Reads "English Label + Vietnamese Label + value", all on one line.
 *
 * The English label is matched word by word against `labelPattern`; whatever
 * Vietnamese label follows is then peeled off, and the remainder is the value.
 *
 * A Vietnamese phrase is only removed when something would still be LEFT. That
 * matters for real data: "Customer Last Name HO" is a guest surnamed HO, not
 * the label "Họ" with an empty value, and stripping it would delete the
 * surname — which is exactly how THU UYEN HO lost half its name before.
 */
/**
 * True when a cell is exactly "English Label + Vietnamese Label", no value.
 *
 * That is the shape Agoda actually sends: the label pair occupies one table
 * cell and the value sits in the next.
 */
function isBilingualLabelCell(cell: string, labelPattern: RegExp): boolean {
  const parts = words(cell.replace(/\s*:\s*$/, ''));
  for (let n = 1; n < parts.length; n++) {
    if (!labelPattern.test(fold(parts.slice(0, n).join(' ')))) continue;
    const rest = fold(parts.slice(n).join(' '));
    if (VIETNAMESE_LABEL_PHRASES.includes(rest)) return true;
  }
  return false;
}

function bilingualInline(line: string, labelPattern: RegExp): string | null {
  const parts = words(line);
  if (parts.length < 2) return null;

  // Find how many leading words form the English label.
  let labelLength = 0;
  for (let n = 1; n <= Math.min(parts.length - 1, 6); n++) {
    if (labelPattern.test(fold(parts.slice(0, n).join(' ')))) {
      labelLength = n;
      break;
    }
  }
  if (labelLength === 0) return null;

  let rest = parts.slice(labelLength);
  let consumedVietnamese = false;
  for (const phrase of VIETNAMESE_LABEL_PHRASES) {
    const size = phrase.split(' ').length;
    if (rest.length <= size) continue; // never consume the whole remainder
    if (fold(rest.slice(0, size).join(' ')) === phrase) {
      rest = rest.slice(size);
      consumedVietnamese = true;
      break;
    }
  }

  // A Vietnamese label MUST have sat between the label and the value. Without
  // one this is not a bilingual field row but ordinary prose that happens to
  // begin with the label words — the copied subject line "Agoda Booking ID
  // 9999999999 - CONFIRMED Hotel Country: Vietnam …" is exactly that, and
  // reading it as the field let a stale subject id outrank the real body value.
  if (!consumedVietnamese) return null;

  const value = rest.join(' ').trim();
  return value.length > 0 && !isKnownLabel(value) ? value : null;
}

function isKnownLabel(cell: string): boolean {
  const exact = cell
    .toLowerCase()
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (ACCENTED_LABELS.includes(exact)) return true;
  const f = fold(cell).replace(/\s*:\s*$/, '');
  return KNOWN_LABELS.some((p) => p.test(f));
}

/** The next non-empty line index at or after `from`, or -1. */
function nextNonEmpty(all: string[], from: number): number {
  for (let j = from; j < all.length; j++) {
    if (all[j]!.trim().length > 0) return j;
  }
  return -1;
}

/**
 * Reads a labelled value, column-aware. Supported shapes, in order:
 *   "Label<TAB|2+ spaces>Value"   (flattened table paste)
 *   "Label: Value"                (inline, single cell)
 *   "Label:" / "Label" then the value on the next non-empty line
 *
 * `labelPattern` is matched against a whole CELL (anchor it with ^…$), so a long
 * subject line or a table header can never be mistaken for the field, and the
 * value is rejected when it is itself a known label.
 */
function labelValue(all: string[], labelPattern: RegExp): string | null {
  for (let i = 0; i < all.length; i++) {
    const row = cells(all[i]!);
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]!;

      // "Label: value" inside one cell.
      const inline = /^([^:]{1,60}):\s*(.*)$/.exec(cell);
      if (inline && labelPattern.test(fold(inline[1]))) {
        const value = inline[2]!.trim();
        if (value.length > 0) return value;
        // "Label:" with the value on the next line.
        const j = nextNonEmpty(all, i + 1);
        if (j >= 0) {
          const first = cells(all[j]!)[0];
          if (first && !isKnownLabel(first)) return first;
        }
        // Keep looking. A label that carries no value is not proof the field is
        // absent — a table COLUMN HEADER matches the same text, and giving up
        // there let a header shadow the real field further down.
        continue;
      }

      if (!labelPattern.test(fold(cell))) {
        // "Customer First Name Tên Khách Hàng<TAB>Yunning" — the real layout in
        // every supplied mail. The cell holds BOTH labels and nothing else, so
        // the value is the next cell that is not itself a label.
        //
        // Checked BEFORE the single-cell reader: that one refuses to consume a
        // Vietnamese phrase that would leave nothing behind (which is what
        // protects a guest surnamed "HO" from the label "Họ"), and here the
        // remainder IS the whole label, with the value in the next cell.
        if (isBilingualLabelCell(cell, labelPattern)) {
          for (let k = c + 1; k < row.length; k++) {
            if (!isKnownLabel(row[k]!)) return row[k]!;
          }
          const j = nextNonEmpty(all, i + 1);
          if (j >= 0) {
            const value = cells(all[j]!)[0];
            if (value && !isKnownLabel(value)) return value;
          }
        }

        // "Customer First Name Tên Khách Hàng Nga" — labels and value all
        // separated by single spaces, so the whole row arrives as one cell.
        const inlineBilingual = bilingualInline(cell, labelPattern);
        if (inlineBilingual) return inlineBilingual;
        continue;
      }

      // "Label<TAB>Value" — the value is the next cell to the right that is not
      // itself a label. Stepping PAST label cells is what makes the tab-separated
      // bilingual row work: "Customer First Name | Tên Khách Hàng | Nga" puts a
      // second label between the field and its value, and stopping at the first
      // neighbour returned nothing at all. A row that is only labels (a header,
      // or "Check-in | Check-out") finds no value here and falls through to the
      // column-aware lookup below.
      for (let k = c + 1; k < row.length; k++) {
        const candidate = row[k]!;
        if (!isKnownLabel(candidate)) return candidate;
      }

      // A row that is ONLY labels — a lone label, or Agoda's bilingual
      // "Booking ID | Mã số đặt phòng" — puts its values on the next line. The
      // value is taken from the SAME COLUMN, so "Check-in | Check-out" above
      // two dates gives each label its own date instead of both taking the
      // first one.
      if (row.every((other, idx) => idx === c || isKnownLabel(other))) {
        // Agoda also stacks the pair vertically — the English label, then the
        // Vietnamese one, THEN the value:
        //
        //   Booking ID
        //   Mã số đặt phòng
        //   1756224954
        //
        // so at most a couple of further label-only lines are stepped over.
        // The cap matters: without it, a field that genuinely has no value
        // would run on and adopt the next field's.
        let skippedLabels = 0;
        for (let j = i + 1; j < all.length && skippedLabels <= 2; j++) {
          if (all[j]!.trim().length === 0) continue;
          const valueRow = cells(all[j]!);
          const value = valueRow[c] ?? (valueRow.length === 1 ? valueRow[0] : undefined);
          if (!value) break;
          if (isKnownLabel(value)) {
            skippedLabels += 1;
            continue;
          }
          return value;
        }
      }
      // This occurrence yielded nothing; a later one may still be the field.
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------
/** Normalises a single money TOKEN ("1,016,710.00") to whole VND. */
function tokenToVnd(token: string): number | null {
  // Drop a 2-digit decimal fraction (".00" / ",00"); 3-digit groups are kept.
  const digits = token.replace(/[.,]\d{2}$/, '').replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Extracts an Agoda money amount from a line and normalises it to whole VND.
 *
 * Handles "VND 1,016,710.00", "VND 508,355.00", "1,680,000 VND" and
 * "1.016.710 VND". A trailing separator followed by exactly two digits is a
 * decimal fraction and is dropped; a separator followed by three digits is a
 * thousands group and is kept.
 *
 * The currency-adjacent forms are tried FIRST so a date on the same row
 * ("July 27, 2026  VND 508,355.00") can never be read as the amount. Returns null
 * when no amount is present — money is never invented.
 */
export function parseAgodaMoney(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const tagged =
    raw.match(/(?:VND|₫)\s*(\d[\d.,]*)/i) ??
    raw.match(/(\d[\d.,]*)\s*(?:VND|₫)/i);
  if (tagged?.[1]) return tokenToVnd(tagged[1]);
  // Untagged: require a real thousands group so a bare year is never money.
  const grouped = raw.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?/);
  if (grouped) return tokenToVnd(grouped[0]);
  return null;
}

/** Formats whole VND with Vietnamese dot separators: 1016710 → "1.016.710". */
export function formatVndDots(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(amount)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ---------------------------------------------------------------------------
// Room-type mapping
// ---------------------------------------------------------------------------
/**
 * Room-type → internal abbreviation. **Order matters**: the most specific
 * patterns are evaluated first, so "Deluxe Room - 01" resolves to LUXDEL (not
 * DEL), "Deluxe Family" to DEFAM (not DEL/FAM) and "Deluxe Balcony" to DEBAL.
 * Patterns run against the folded (accent-free, lower-case) room type.
 */
const ROOM_CODE_RULES: ReadonlyArray<{ code: string; test: RegExp }> = [
  { code: 'LUXDEL', test: /\bdeluxe\s+room\s*-\s*0*1\b/ },
  { code: 'DD', test: /\bd\s*-\s*d\s+room\s*-\s*0*3\b/ },
  { code: 'DD', test: /\bdeluxe\s+giuong\s+doi\b/ },
  { code: 'DEBAL', test: /\bdeluxe\s+balcony\b/ },
  { code: 'KINGBAL', test: /\bking\s+balcony\b/ },
  { code: 'DEFAM', test: /\bdeluxe\s+family\b/ },
  { code: 'STAN', test: /\bstandard\b/ },
  { code: 'SUP', test: /\bsuperior\b/ },
  { code: 'DEL', test: /\bdeluxe\b/ },
  { code: 'FAM', test: /\bfamily\b/ },
];

/**
 * Normalises a raw room type for matching: folds case/accents, removes a
 * parenthetical numeric suffix such as "(0)" and harmless punctuation noise, and
 * collapses whitespace. The ORIGINAL text is always preserved by the caller.
 */
export function normalizeRoomType(raw: string | null | undefined): string {
  return fold(
    (raw ?? '')
      .replace(/\(\s*\d+\s*\)/g, ' ') // "(0)" numeric suffix
      .replace(/[·•|]+/g, ' '),
  );
}

/**
 * The OTA room name as the mapping catalogue holds it.
 *
 * Agoda appends a numeric STYLE marker to the room row — "Superior Room (2)",
 * "Standard (0)". It is not a quantity and not part of the name, so only a
 * TRAILING marker is removed. Everything else is preserved verbatim: accents,
 * capitalisation and any parenthesised text that is genuinely part of the name
 * ("Phòng Superior Có Cửa Sổ (Giường Queen)") stay exactly as written, because
 * this string is the key the branch's mappings are looked up by.
 */
export function normalizeOtaRoomName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw
    .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > 0 ? value : null;
}

/**
 * The guest's name, from the customer fields and the "Other Guests" list.
 *
 * Agoda states the name up to three times and rarely identically: the customer
 * fields hold it split, while "Other Guests" repeats it decorated with a room
 * marker and sometimes as "Guest of <name>". The decorations are stripped and
 * the entries compared case-insensitively; when every entry turns out to name
 * the SAME person, that spelling is used. Anything else — an empty list, or two
 * genuinely different guests — falls back to "First Last", because guessing
 * which of several people the booking is under is not the parser's decision.
 */
export function resolveAgodaGuestName(
  firstName: string | null,
  lastName: string | null,
  otherGuests: string | null,
): string | null {
  const primary =
    [firstName, lastName].filter((p) => p && p.trim().length > 0).join(' ').trim() || null;

  // The customer fields WIN whenever they exist. "Other Guests" lists the
  // occupants, which routinely includes a companion travelling on the same
  // reservation; letting it override would rename the booking to whoever
  // happened to be listed first.
  if (primary) return primary;
  if (!otherGuests) return null;

  // With no customer name at all, the occupant list is the only evidence there
  // is. It is used only when every entry, once stripped of its room marker and
  // "Guest of" prefix, turns out to name the SAME person — two genuinely
  // different guests leave the field empty for the Admin to fill.
  const cleaned = otherGuests
    .split(',')
    .map((entry) =>
      entry
        // "[RmNo.1]" / "[RmNo 2]" — which room the guest occupies, not a name.
        .replace(/\[\s*rm\s*no\.?\s*\d*\s*\]/gi, ' ')
        .replace(/\bguest\s+of\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((entry) => entry.length > 0);
  if (cleaned.length === 0) return null;

  // Deduplicate case-insensitively, keeping the FIRST spelling seen.
  const byFolded = new Map<string, string>();
  for (const entry of cleaned) {
    const key = fold(entry);
    if (key.length > 0 && !byFolded.has(key)) byFolded.set(key, entry);
  }
  return byFolded.size === 1 ? [...byFolded.values()][0]! : null;
}

export interface RoomCodeResult {
  /** The abbreviation, or null when the type is not in the controlled map. */
  code: string | null;
  /** The original room-type text, always preserved verbatim. */
  original: string | null;
  /** False when the type is unknown and needs manual review. */
  known: boolean;
}

/** Maps a room type to its abbreviation using the controlled, ordered map. */
export function mapAgodaRoomCode(raw: string | null | undefined): RoomCodeResult {
  const original = raw && raw.trim().length > 0 ? raw.trim() : null;
  const normalized = normalizeRoomType(raw);
  if (normalized.length === 0) return { code: null, original, known: false };
  for (const rule of ROOM_CODE_RULES) {
    if (rule.test.test(normalized)) return { code: rule.code, original, known: true };
  }
  return { code: null, original, known: false };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
// Partner-email-specific markers. A generic "booking confirmation" is NOT one.
const PARTNER_MARKERS: readonly RegExp[] = [
  /reference sell rate/,
  /net rate/,
  /customer first name/,
  /customer last name/,
  /no\.? of rooms/,
  /no\.? of extra bed/,
  /rate ?plan/,
  /reservation information/,
];

// Markers that identify Agoda at all (domain / explicit Agoda booking id).
const AGODA_MARKERS: readonly RegExp[] = [/agoda\.com/, /agoda booking id/, /\bagoda\b/];

/** Counts how many of the given patterns appear in the folded text. */
function countMarkers(folded: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((n, p) => (p.test(folded) ? n + 1 : n), 0);
}

/**
 * True for an Agoda **hotel-partner** booking email. Requires at least two
 * partner-specific markers, so a Booking.com email, a manually typed booking or a
 * generic "Booking confirmation" line can never be misclassified.
 */
export function isAgodaPartnerEmail(rawText: string): boolean {
  return countMarkers(fold(rawText), PARTNER_MARKERS) >= 2;
}

/**
 * True when the text is an Agoda document at all — an agoda.com domain or an
 * explicit "Agoda Booking ID", or the partner format. Never decided by a generic
 * phrase such as "Booking confirmation" on its own.
 */
export function isAgodaEmail(rawText: string): boolean {
  const folded = fold(rawText);
  if (/agoda\.com/.test(folded) || /agoda booking id/.test(folded)) return true;
  if (isAgodaPartnerEmail(rawText)) return true;
  // A bare "agoda" mention only counts alongside a booking-id style marker.
  return countMarkers(folded, AGODA_MARKERS) >= 1 && /booking id/.test(folded);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
export interface AgodaNightlyRate {
  /** ISO "YYYY-MM-DD". */
  stayDate: string;
  /** Exactly as the source stated it — for several rooms this covers them all. */
  amount: number | null;
  /**
   * `amount` divided by the room count, for per-room display only. Null when
   * the division is not exact, or when the room count is unknown. Never used
   * for the note and never used for the booking total.
   */
  perRoomAmount?: number | null;
}

export interface AgodaPartnerBooking {
  source: 'AGODA';
  bookingId: string | null;
  /**
   * The public Agoda property name ("KAS Sonata Luxury Hotel"). This is a
   * branch-RESOLUTION input only — the normalized booking shows the resolved
   * branch address, exactly like Booking.com. Agoda's Property ID is never read.
   */
  sourceHotelName: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerFullName: string | null;
  countryOfResidence: string | null;
  /** ISO "YYYY-MM-DD". */
  checkIn: string | null;
  checkOut: string | null;
  /** checkOut − checkIn in calendar days; null when either date is unusable. */
  nights: number | null;
  /** The room row exactly as Agoda printed it, including any "(2)" marker. */
  roomTypeOriginal: string | null;
  /** The same name with the trailing style marker removed — the mapping key. */
  roomTypeNormalized: string | null;
  /**
   * Every room row on the reservation. `roomTypeOriginal` and the fields beside
   * it describe the FIRST row and are kept for existing callers; this carries
   * the whole table, so a booking with several room types is not truncated.
   */
  roomLines: {
    roomTypeOriginal: string | null;
    roomTypeNormalized: string | null;
    quantity: number;
    occupancy: string | null;
    extraBeds: number | null;
  }[];
  roomCode: string | null;
  roomTypeKnown: boolean;
  roomQuantity: number | null;
  occupancy: string | null;
  extraBeds: number | null;
  /** Always false: these branches serve no breakfast on Agoda. */
  breakfastIncluded: boolean;
  /** CONFIRMED / AMENDED / CANCELLED, from the confirmation heading itself. */
  bookingStatus: 'CONFIRMED' | 'AMENDED' | 'CANCELLED' | null;
  /**
   * Agoda's own property identifier, from "(Property ID 55198617)".
   *
   * Recorded for audit ONLY. Branch resolution goes through the configured
   * platform identity as it always has — this id never selects a branch, so a
   * property renumbered on Agoda cannot silently reroute a booking.
   */
  sourcePropertyId: string | null;
  /**
   * Every DISTINCT complete reservation found in the pasted document. More than
   * one means the paste is ambiguous: the parsed booking is the first, and
   * dispatch is blocked until an Admin says which was intended.
   */
  detectedReservationIds: string[];
  /** How Agoda settles the booking, as stated ("PREPAID"). Never the note's mode. */
  paymentType: string | null;
  /** "Website Language" — the guest's language / market. */
  websiteLanguage: string | null;
  /** "Special Requests" — the guest's own requests, not Agoda's boilerplate. */
  specialRequests: string | null;
  /** "Benefits Included" verbatim. Never consulted for breakfast. */
  benefitsIncluded: string | null;
  payment: string | null;
  ratePlan: string | null;
  cancellationPolicy: string | null;
  customerPhone: string | null;
  customerNotes: string | null;
  /** Agoda's own per-night rows. Diagnostics/consistency only — NOT the debt schedule. */
  nightlyRates: AgodaNightlyRate[];
  /** The guest booking price ("Giá khách đặt"). */
  referenceSellRate: number | null;
  /** The TOTAL hotel receivable / debt. Drives PMS-note line 1 and the schedule. */
  netRate: number | null;
  /**
   * The authoritative internal debt schedule: the total Net rate split evenly over
   * the stay nights (check-in inclusive → check-out exclusive), summing exactly to
   * the Net rate. Never derived from Agoda's own nightly rows.
   */
  nightlyDebt: AgodaNightlyRate[];
  warnings: ExtractWarning[];
  parserVersion: string;
}

const warn = (code: string, message: string, severity: ExtractWarning['severity'] = 'WARNING'): ExtractWarning => ({ code, message, severity });

/**
 * Reads an Agoda date, which hyphenates its named-month form: "5-Aug-2026".
 *
 * The shared reader expects spaces around a named month, so only the hyphens
 * SURROUNDING LETTERS are relaxed to spaces. A purely numeric "5-08-2026" is
 * left untouched and keeps its day-first meaning — which is what makes
 * "3-Aug-2026 (3-08-2026)" resolve through the parenthesised numeric form, as
 * the operator specified.
 *
 * Deliberately local to Agoda: widening the shared reader would change how
 * every other source, Booking.com included, interprets a hyphenated date.
 */
function agodaDate(raw: string): string | null {
  return findDate(raw.replace(/(\d)\s*-\s*([A-Za-z]{3,9})\s*-\s*(\d{4})/g, '$1 $2 $3'));
}

/**
 * True when a row states a date in words AND in numbers, and they differ.
 *
 * Agoda writes "3-Aug-2026 (3-08-2026)". `findDate` resolves the numeric form,
 * which is the one to trust; this only detects the case where the words say
 * something else, so the Admin is told rather than silently given one of two
 * conflicting dates.
 */
function disagreesWithTextualDate(raw: string, iso: string): boolean {
  const flat = removeDiacritics(raw).toLowerCase();
  // "3-Aug-2026" / "3 Aug 2026" / "August 3, 2026" — a month written in letters.
  const named =
    /(\d{1,2})\s*[-\s]\s*([a-z]{3,9})\.?\s*[-,\s]\s*(\d{4})/.exec(flat) ??
    /([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(flat);
  if (!named) return false;

  const dayFirst = /^\d/.test(named[1]!);
  const day = Number(dayFirst ? named[1] : named[2]);
  const monthWord = dayFirst ? named[2]! : named[1]!;
  const month = MONTH_NAMES[monthWord.slice(0, 3)];
  if (!month) return false;
  const year = Number(named[3]);

  const expected = `${year}-${pad2(month)}-${pad2(day)}`;
  return expected !== iso;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** English month names and abbreviations, keyed by their first three letters. */
const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Whole calendar days between two ISO dates, or null when invalid/negative. */
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const diff = Math.round((b - a) / 86_400_000);
  return diff > 0 ? diff : null;
}

/**
 * Finds a labelled rate row. Prefers the "(incl. taxes & fees)" variant and takes
 * the LAST such row (the final total), so a per-night or interim row can never
 * shadow the authoritative amount. Commission / promotion / tax rows are never
 * consulted because the label itself must match.
 */
function findRate(all: string[], labelPattern: RegExp): number | null {
  const withIncl: number[] = [];
  const plain: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    const folded = fold(line);
    if (!labelPattern.test(folded)) continue;
    const amount = readWrappedAmount(all, i);
    if (amount == null) continue;
    // "(incl. taxes & fees)" / "(bao gồm thuế & phí)" is the authoritative row.
    (/incl|bao gom/.test(folded) ? withIncl : plain).push(amount);
  }
  // Prefer the "(incl. taxes & fees)" rows and take the LAST (the final total).
  const pool = withIncl.length > 0 ? withIncl : plain;
  return pool.length > 0 ? pool[pool.length - 1]! : null;
}

/** A line that is nothing but one or two digits. */
const BARE_DIGITS = /^\d{1,2}$/;

/**
 * Rejoins a money value that a mail client wrapped across lines.
 *
 * Copying an Agoda rate row out of Gmail at a narrow width splits it, and the
 * split can fall INSIDE the number:
 *
 *   Net rate (incl. taxes & fees)
 *   VND
 *   2,012,236.0
 *   0
 *
 * Reading only the next line yields nothing; reading "2,012,236.0" on its own
 * yields 20,122,360 — an order of magnitude wrong, and it would be pasted into
 * the hotel PMS. A stray one-or-two-digit line is therefore treated as the
 * CONTINUATION of the preceding number rather than as a value of its own, but
 * only when that number already ends in a decimal separator plus a digit, so
 * two genuinely separate amounts are never glued together.
 */
function joinWrappedParts(parts: readonly string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (previous !== undefined && BARE_DIGITS.test(part) && /[.,]\d{1,2}$/.test(previous)) {
      out[out.length - 1] = previous + part;
      continue;
    }
    out.push(part);
  }
  return out.join(' ');
}

/**
 * Reads the amount belonging to the label on line `from`, tolerating wrapping.
 *
 * Collection stops at the next known label, so the following rate row — or a
 * Commission line — can never be absorbed into this one.
 */
function readWrappedAmount(all: string[], from: number, limit = 5): number | null {
  const parts: string[] = [];
  for (let i = from; i < all.length && parts.length < limit; i++) {
    const text = all[i]!.trim();
    if (text.length === 0) continue;

    // A DIFFERENT rate label ends this row. Without this guard, a Net rate with
    // no amount of its own would happily take the Commission below it.
    const firstCell = cells(text)[0] ?? '';
    if (parts.length > 0 && isOtherRateLabel(firstCell, all[from]!)) break;

    // The label's own Vietnamese twin is a continuation, not the value — and it
    // frequently CARRIES the amount ("Giá bán tham khảo (…)<TAB>VND 5,156,900").
    // Stopping at it, as this once did, lost the Net rate entirely.
    //
    // The whole window is collected before parsing rather than stopping at the
    // first line containing digits: a rate can wrap INSIDE the number
    // ("VND" / "2,012,236.0" / "0"), and stopping early reads that as
    // 20,122,360 — ten times the truth.
    parts.push(text);
  }
  if (parts.length === 0) return null;
  return parseAgodaMoney(joinWrappedParts(parts));
}

/** The commercial rows, each with its Vietnamese twin. */
const RATE_LABEL_GROUPS: readonly RegExp[] = [
  /reference sell rate|gia ban tham khao/,
  /net rate|gia thuc te/,
  /commission|tien hoa hong|hoa hong/,
  /compensation|khoan bu tru/,
  /withholding tax|thue khau luu/,
  /tax on commission/,
  /promotions?|khuyen mai/,
  /other programs?/,
];

/**
 * True when `cell` names a rate row that is NOT the one being read.
 *
 * A label and its Vietnamese twin belong to the SAME group, so stepping from
 * "Net rate (incl. taxes & fees)" onto "Giá thực tế (bao gồm thuế & phí)" is a
 * continuation, while stepping onto "Commission" is the end of the row.
 */
function isOtherRateLabel(cell: string, ownLabelLine: string): boolean {
  const folded = fold(cell);
  const own = fold(ownLabelLine);
  const ownGroup = RATE_LABEL_GROUPS.find((g) => g.test(own));
  const cellGroup = RATE_LABEL_GROUPS.find((g) => g.test(folded));
  return cellGroup !== undefined && cellGroup !== ownGroup;
}

/** Rows that are commercial summaries, never per-night stay rows. */
const SUMMARY_ROW =
  /reference sell rate|net rate|commission|promotion|withholding|tax on|compensation|other program|total/;

/**
 * Reads the nightly-rate rows ("July 27, 2026  VND 508,355.00").
 *
 * Agoda's nightly figure is the amount for ALL rooms that night, so with two
 * rooms it is twice what one room costs. Both readings are kept: `amount` is
 * exactly what Agoda printed, and `perRoomAmount` is that divided by the room
 * count — for display only. The booking total is never divided.
 *
 * The per-room figure is filled in only when the division is EXACT. A rounded
 * share would not add back up to the stated total, and a number that looks
 * precise but is not would be read as if Agoda had quoted it.
 */
function extractNightlyRates(all: string[], roomQuantity: number | null): AgodaNightlyRate[] {
  const out: AgodaNightlyRate[] = [];
  const seen = new Set<string>();
  const hasMoney = (line: string) => /(?:VND|₫)\s*\d|\d\s*(?:VND|₫)/i.test(line);

  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    if (SUMMARY_ROW.test(fold(line))) continue;
    const iso = findDate(line);
    if (!iso || seen.has(iso)) continue;

    // The amount sits on the date's own line, or on the NEXT one when the row
    // wrapped ("August 4, 2026" / "VND 529,537.00"). The continuation must be
    // a bare amount: a line carrying its own date is the next night's row, and
    // a summary label is not a nightly figure at all.
    let amountLine: string | null = hasMoney(line) ? line : null;
    if (amountLine === null) {
      const j = nextNonEmpty(all, i + 1);
      const candidate = j >= 0 ? all[j]! : null;
      if (
        candidate !== null &&
        hasMoney(candidate) &&
        !SUMMARY_ROW.test(fold(candidate)) &&
        findDate(candidate) === null
      ) {
        amountLine = candidate;
      }
    }
    if (amountLine === null) continue;

    seen.add(iso);
    const amount = parseAgodaMoney(amountLine);
    out.push({ stayDate: iso, amount, perRoomAmount: perRoom(amount, roomQuantity) });
  }
  return out;
}

/** An exact per-room share of a nightly total, or null when there isn't one. */
function perRoom(amount: number | null, roomQuantity: number | null): number | null {
  if (amount == null) return null;
  if (roomQuantity == null || !Number.isInteger(roomQuantity) || roomQuantity <= 0) return null;
  return amount % roomQuantity === 0 ? amount / roomQuantity : null;
}

/**
 * Extracts the Agoda partner booking. Never throws: missing values become null
 * and a warning, so the Admin sees exactly what needs manual review.
 */
export function parseAgodaPartnerBooking(rawText: string): AgodaPartnerBooking {
  // ONE reservation, never a whole mail thread. See `reservationBlock`.
  const documentLines = lines(rawText);
  const all = reservationBlock(documentLines);
  const warnings: ExtractWarning[] = [];

  // AMBIGUITY IS NEVER RESOLVED SILENTLY.
  //
  // A paste routinely holds several DISTINCT complete reservations: every real
  // mail collected so far is a Gmail thread carrying between two and six. The
  // parser takes the first complete one, because a mail client puts the message
  // being read at the top — but it says so, and it reports every reservation it
  // found, so a wrong pick is visible rather than silent.
  //
  // This is a WARNING, not a blocker. Blocking would reject every production
  // mail collected to date and make the intake unusable, which is a worse
  // failure than a visible, correctable choice: the review screen shows the
  // guest, dates and prices of whichever booking was taken, so the wrong one
  // does not look right.
  //
  // The same reservation quoted twice is NOT ambiguous: identity is by booking
  // id, so quoted history and forwarded copies stay silent.
  const detectedReservationIds = [
    ...new Set(
      reservationBlocks(documentLines)
        .filter((block) => isCompleteReservation(block))
        .map((block) => idWithin(block))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (detectedReservationIds.length > 1) {
    warnings.push(
      warn(
        'AGODA_MULTIPLE_RESERVATIONS',
        `Nội dung chứa ${detectedReservationIds.length} đơn đặt phòng khác nhau (${detectedReservationIds.join(', ')}). Đang xử lý đơn ${detectedReservationIds[0]}. Nếu cần đơn khác, vui lòng dán riêng đơn đó.`,
        'WARNING',
      ),
    );
  }

  const bookingId = extractBookingId(all, all.join('\n'));
  if (!bookingId) warnings.push(warn('AGODA_MISSING_BOOKING_ID', 'Không đọc được Booking ID của Agoda.', 'ERROR'));

  const first = labelValue(all, /^customer first name$|^ten khach( hang)?$/);
  // Matched by the English label only: the Vietnamese "Họ" is indistinguishable
  // from a surname once accents are folded, so it identifies the label's
  // POSITION (above) rather than being searched for as a label itself.
  const last = labelValue(all, /^customer last name$/);
  const otherGuests = labelValue(all, /^other guests$|^khach kh?ac$/);
  const fullName = resolveAgodaGuestName(first, last, otherGuests);
  if (!fullName) warnings.push(warn('AGODA_MISSING_CUSTOMER', 'Không đọc được tên khách chính.'));

  const checkInRaw = labelValue(all, /^check[- ]?in$|^ngay nhan phong$/) ?? '';
  const checkOutRaw = labelValue(all, /^check[- ]?out$|^ngay tra phong$/) ?? '';
  const checkIn = agodaDate(checkInRaw);
  const checkOut = agodaDate(checkOutRaw);
  // "3-Aug-2026 (3-08-2026)" states the same day twice. `findDate` takes the
  // parenthesised numeric form; if the words disagree with it, neither is
  // trustworthy on its own and the Admin is asked.
  for (const [raw, iso, field] of [
    [checkInRaw, checkIn, 'nhận phòng'],
    [checkOutRaw, checkOut, 'trả phòng'],
  ] as const) {
    if (iso && disagreesWithTextualDate(raw, iso)) {
      warnings.push(
        warn(
          'AGODA_DATE_FORMS_DISAGREE',
          `Ngày ${field} ghi hai dạng khác nhau ("${raw.trim()}") — vui lòng kiểm tra.`,
          'ERROR',
        ),
      );
    }
  }
  if (!checkIn) warnings.push(warn('AGODA_MISSING_CHECK_IN', 'Không đọc được ngày nhận phòng.', 'ERROR'));
  if (!checkOut) warnings.push(warn('AGODA_MISSING_CHECK_OUT', 'Không đọc được ngày trả phòng.', 'ERROR'));
  const nights = nightsBetween(checkIn, checkOut);
  if (checkIn && checkOut && nights == null) {
    warnings.push(warn('AGODA_INVALID_DATE_RANGE', 'Ngày trả phòng phải sau ngày nhận phòng.', 'ERROR'));
  }

  // The room table is read as a table first; the labelled form is the fallback for
  // layouts that print "Room Type:" / "No. of Rooms:" on their own lines.
  const roomRows = parseRoomRows(all);
  const table = roomRows[0] ?? parseColumnRoomTable(all);
  const roomTypeRaw = table?.roomType ?? labelValue(all, /^room ?type$|^loai phong$/);
  const room = mapAgodaRoomCode(roomTypeRaw);
  if (!room.original) {
    warnings.push(warn('AGODA_MISSING_ROOM_TYPE', 'Không đọc được hạng phòng.', 'ERROR'));
  } else if (!room.known) {
    warnings.push(
      warn('AGODA_UNKNOWN_ROOM_TYPE', `Hạng phòng "${room.original}" chưa có mã nội bộ — cần kiểm tra thủ công.`, 'ERROR'),
    );
  }

  /** A count cell must be a plain integer — never a concatenation of columns. */
  const countOf = (raw: string | null | undefined): number | null => {
    const m = raw ? /^\s*(\d{1,3})\b/.exec(raw) : null;
    if (!m) return null;
    const n = Number.parseInt(m[1]!, 10);
    return Number.isFinite(n) ? n : null;
  };

  const roomsRaw = table?.rooms ?? labelValue(all, /^no\.? of rooms$|^so (?:luong )?phong$/);
  const parsedRooms = countOf(roomsRaw);
  const roomQty = parsedRooms != null && parsedRooms > 0 ? parsedRooms : null;
  if (roomQty == null) warnings.push(warn('AGODA_MISSING_ROOM_QUANTITY', 'Không đọc được số lượng phòng.', 'ERROR'));

  const extraParsed = countOf(table?.extraBeds ?? labelValue(all, /^no\.? of extra bed$/));

  const referenceSellRate = findRate(all, /reference sell rate|gia ban tham khao/);
  if (referenceSellRate == null) {
    warnings.push(warn('AGODA_MISSING_SELL_RATE', 'Không đọc được "Reference sell rate" — cần kiểm tra thủ công.', 'ERROR'));
  }
  const netRate = findRate(all, /net rate|gia thuc te/);
  if (netRate == null) {
    warnings.push(warn('AGODA_MISSING_NET_RATE', 'Không đọc được "Net rate" — cần kiểm tra thủ công.', 'ERROR'));
  }

  // Scoped to THIS reservation. `rawText` is the whole pasted document, which
  // for a thread is every message in it — reading the phone or the payment
  // wording from there attributes another booking's details to this one.
  const blockText = all.join('\n');

  const paymentRaw = labelValue(all, /^payment|payment (?:type|model|method)/);
  // Card rows are explicitly not the payment type ("Card Type" / "LOẠI THẺ"),
  // and a value must actually read as a word — a stray table separator "|" is
  // not a payment method.
  const usable =
    paymentRaw !== null &&
    /[a-z]{3}/i.test(removeDiacritics(paymentRaw)) &&
    !/^(loai the|card type|card number|card holder name)$/.test(fold(paymentRaw));
  const payment = usable
    ? paymentRaw!.trim().toUpperCase().slice(0, 40)
    : /\bprepaid\b|\btra truoc\b/.test(fold(blockText))
      ? 'PREPAID'
      : null;

  // The authoritative debt schedule: the TOTAL Net rate split evenly per night.
  // Agoda's own nightly rows are never used for this; they are only cross-checked.
  const stayDates = checkIn && nights != null ? stayDatesFrom(checkIn, nights) : [];
  const nightlyDebt: AgodaNightlyRate[] =
    netRate != null && stayDates.length > 0
      ? allocateEvenly(netRate, stayDates.length).map((amount, i) => ({ stayDate: stayDates[i]!, amount }))
      : [];
  const nightlyRates = extractNightlyRates(all, roomQty);

  // Consistency check, never a repair. When Agoda lists one row per stay night,
  // those rows should add up to the Net rate. A mismatch is Agoda's own
  // inconsistency: it is reported at INFO so an Admin can look, and NEITHER
  // figure is adjusted — a silently "corrected" total would be pasted into the
  // hotel PMS as though Agoda had stated it.
  if (netRate != null && nights != null && nightlyRates.length === nights) {
    const stated = nightlyRates.map((n) => n.amount);
    if (stated.every((a): a is number => a != null)) {
      const sum = stated.reduce((total, a) => total + a, 0);
      if (sum !== netRate) {
        warnings.push(
          warn(
            'AGODA_NIGHTLY_SUM_MISMATCH',
            `Tổng giá từng đêm (${formatVndDots(sum)}) khác Net rate (${formatVndDots(netRate)}) — vui lòng kiểm tra.`,
            'INFO',
          ),
        );
      }
    }
  }
  if (nightlyDebt.length > 0 && nightlyRates.length > 0 && differsFromAgodaRows(nightlyDebt, nightlyRates)) {
    warnings.push(
      warn(
        'AGODA_NIGHTLY_ROWS_DIFFER',
        'Giá từng đêm Agoda khác với công nợ chia đều — vui lòng kiểm tra (tổng công nợ giữ nguyên).',
        'INFO',
      ),
    );
  }

  return {
    source: 'AGODA',
    bookingId,
    sourceHotelName: extractHotelName(all),
    customerFirstName: first,
    customerLastName: last,
    customerFullName: fullName,
    countryOfResidence: labelValue(all, /^country of residence$/),
    checkIn,
    checkOut,
    nights,
    roomTypeOriginal: room.original,
    roomTypeNormalized: normalizeOtaRoomName(room.original),
    // Every room row the reservation states, not merely the first.
    roomLines: roomRows.map((r) => ({
      roomTypeOriginal: r.roomType,
      roomTypeNormalized: normalizeOtaRoomName(r.roomType),
      quantity: countOf(r.rooms) ?? 1,
      occupancy: r.occupancy,
      extraBeds: countOf(r.extraBeds),
    })),
    roomCode: room.code,
    roomTypeKnown: room.known,
    roomQuantity: roomQty,
    occupancy: table?.occupancy ?? labelValue(all, /^occupancy$|^suc chua$/),
    extraBeds: extraParsed,
    breakfastIncluded: AGODA_BREAKFAST_INCLUDED,
    bookingStatus: readBookingStatus(all),
    sourcePropertyId: readPropertyId(all),
    detectedReservationIds,
    paymentType: payment,
    websiteLanguage: labelValue(all, /^website language$/),
    specialRequests: valueUnderLabelPrefix(all, /^special requests\b|^yeu cau dac biet\b/),
    benefitsIncluded: valueUnderLabelPrefix(all, /^benefits included\b|^bao gom cac quyen loi\b/),
    payment,
    ratePlan: cleanRatePlan(labelValue(all, /^rate ?plan(?: name)?$/)),
    cancellationPolicy: labelValue(all, /^cancellation policy$/),
    customerPhone: extractPhone(blockText),
    customerNotes: guestRequestNote(labelValue(all, /^(customer notes?|special requests?|remarks?)$/)),
    nightlyRates,
    referenceSellRate,
    netRate,
    nightlyDebt,
    warnings,
    parserVersion: AGODA_PARTNER_PARSER_VERSION,
  };
}

/**
 * Breakfast on Agoda, for these eight branches: never included.
 *
 * This is an operator-confirmed business rule, not something read from the
 * document. The text is deliberately NOT consulted: "Benefits Included" lists
 * coffee & tea, drinking water and welcome drinks, none of which is breakfast,
 * and a rate-plan blurb that happens to contain the word would otherwise flip a
 * booking to "has breakfast" and block dispatch over a note wording that does
 * not exist. Every Agoda note therefore ends "KHONG AN SANG".
 *
 * If a branch ever starts serving breakfast on Agoda, this becomes a per-branch
 * configuration change — not a parser change.
 */
export const AGODA_BREAKFAST_INCLUDED = false;

/**
 * The booking's own status, read from the confirmation heading.
 *
 * The heading is part of the reservation, so this survives a forwarded,
 * translated or missing subject line. An amended confirmation is still a
 * confirmation and is parsed identically — the status is recorded, not acted on.
 */
function readBookingStatus(all: readonly string[]): 'CONFIRMED' | 'AMENDED' | 'CANCELLED' | null {
  for (const line of all) {
    const folded = fold(line);
    if (/\bcancell?ed\b/.test(folded) && /booking|reservation/.test(folded)) return 'CANCELLED';
    if (/amended booking confirmation|booking confirmation.*amended/.test(folded)) return 'AMENDED';
    if (/\bamended\b/.test(folded) && /booking id/.test(folded)) return 'AMENDED';
    if (/booking confirmation/.test(folded)) return 'CONFIRMED';
    if (/\bconfirmed\b/.test(folded) && /booking id/.test(folded)) return 'CONFIRMED';
  }
  return null;
}

/**
 * The value BELOW a label line, matched by prefix rather than whole cell.
 *
 * Agoda appends its own boilerplate to some labels — "Special Requests Yêu cầu
 * đặc biệt ( All special requests are subject to availability… )" — so the cell
 * is neither the label alone nor a bilingual pair. The label is therefore
 * recognised by its opening words and the value taken from the next line that
 * is not itself a label or a parenthetical aside.
 */
function valueUnderLabelPrefix(all: readonly string[], prefix: RegExp): string | null {
  for (let i = 0; i < all.length; i++) {
    const first = cells(all[i]!)[0];
    if (!first || !prefix.test(fold(first))) continue;
    for (let j = i + 1; j < all.length && j <= i + 3; j++) {
      const text = all[j]!.trim();
      if (text.length === 0) continue;
      if (/^\(.*\)$/.test(text)) continue;
      const value = cells(text)[0];
      if (!value || isKnownLabel(value)) break;
      return text.replace(/\s{2,}/g, ' ').trim();
    }
  }
  return null;
}

/** "Non-Refundable ()" → "Non-Refundable". */
function cleanRatePlan(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.replace(/\(\s*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return value.length > 0 ? value : null;
}

/**
 * Keeps only a genuine guest request. Agoda repeats the guest's own contact block
 * ("Customer Info - Name: …, Phone: …") under "Customer Notes"; that is contact
 * metadata, not a request, and it must not end up in the booking's note field.
 */
function guestRequestNote(raw: string | null): string | null {
  if (!raw) return null;
  if (/^customer info\b/i.test(raw.trim())) return null;
  return raw;
}

/** Stay dates: check-in inclusive → check-out exclusive. */
function stayDatesFrom(checkInIso: string, nights: number): string[] {
  const start = Date.parse(`${checkInIso}T00:00:00Z`);
  if (Number.isNaN(start)) return [];
  return Array.from({ length: nights }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** True when Agoda's own rows disagree with the generated equal allocation. */
function differsFromAgodaRows(debt: AgodaNightlyRate[], rows: AgodaNightlyRate[]): boolean {
  const byDate = new Map(rows.map((r) => [r.stayDate, r.amount]));
  return debt.some((d) => {
    const stated = byDate.get(d.stayDate);
    return stated != null && stated !== d.amount;
  });
}

interface RoomTableRow {
  roomType: string | null;
  rooms: string | null;
  occupancy: string | null;
  extraBeds: string | null;
}

/**
 * Parses the room table as a TABLE: it locates the header row (which must carry at
 * least "Room Type" and "No. of Rooms" as separate cells), remembers each column's
 * position, then maps the data row's cells onto those columns.
 *
 * This is what stops the flattened paste from collapsing
 * "Standard (0) | 1 | 2 Adults | 0" into a single value (room type absorbing the
 * other columns) or into the digit-soup "0120" that produced a 120-room booking.
 * When the values were copied as separate logical lines, the following one-cell
 * lines are collected as the row instead.
 */
/** Matches "Room Type" in either language. */
const ROOM_TYPE_LABEL = /^room ?type$|^loai phong$/;
/** Matches "No. of Rooms" in either language. */
const ROOM_COUNT_LABEL = /^no\.? of rooms$|^so (?:luong )?phong$/;

/**
 * The room table with every column header on its OWN line, bilingual, followed
 * by a single data row separated by single spaces:
 *
 *   Room Type / Loại Phòng / No. of Rooms / Số phòng / Occupancy / Số người /
 *   No. of Extra Bed / Số Giường Thêm
 *   Superior Double Room 1 2 Adults 0
 *
 * The column-position reader cannot see this: there is no header ROW to take
 * positions from, and a single space is not a separator, so the data row is one
 * cell. Read wrongly it yields a room type of "Superior Double Room 1 2 Adults
 * 0" and no quantity at all.
 */
/** True when every cell on the line is a known label. */
function isLabelOnlyLine(line: string): boolean {
  const row = cells(line);
  return row.length > 0 && row.every((cell) => isKnownLabel(cell));
}

/**
 * Every room row under a header, however the header was wrapped.
 *
 * Agoda wraps the bilingual header across lines, pairing a Vietnamese label
 * with the NEXT English one:
 *
 *   Room Type
 *   Loại Phòng      No. of Rooms
 *   Số phòng        Occupancy
 *   Số người        No. of Extra Bed
 *   Số Giường Thêm :
 *   Standard Room   1   2 Adults   0
 *
 * There is no header ROW to take column positions from, so the run of
 * label-only lines is skipped wholesale and the data rows are read after it —
 * every one of them, so a reservation with several room types is not truncated
 * to its first.
 */
export function parseRoomRows(all: string[]): RoomTableRow[] {
  for (let i = 0; i < all.length; i++) {
    const first = cells(all[i]!)[0];
    if (!first || !ROOM_TYPE_LABEL.test(fold(first).replace(/\s*:\s*$/, ''))) continue;

    let sawRoomCount = false;
    let j = i;
    for (; j < all.length; j++) {
      const text = all[j]!.trim();
      if (text.length === 0) continue;
      if (!isLabelOnlyLine(text)) break;
      if (cells(text).some((cell) => ROOM_COUNT_LABEL.test(fold(cell).replace(/\s*:\s*$/, '')))) {
        sawRoomCount = true;
      }
    }
    if (!sawRoomCount) continue;

    const rows: RoomTableRow[] = [];
    for (let k = j; k < all.length; k++) {
      const text = all[k]!.trim();
      if (text.length === 0) continue;
      const row = splitTabbedRoomRow(text) ?? splitSpacedRoomRow(text);
      if (!row) break;
      rows.push(row);
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * "Standard Room<TAB>1<TAB>2 Adults<TAB>0" — the columns survived as cells.
 *
 * Requires all four columns in the right shape, so a prose line that merely
 * follows the table is not mistaken for another room.
 */
function splitTabbedRoomRow(line: string): RoomTableRow | null {
  const row = cells(line);
  if (row.length < 4) return null;
  const [roomType, rooms, occupancy, extraBeds] = row;
  if (!roomType || isKnownLabel(roomType)) return null;
  if (!/^\d{1,3}$/.test(rooms ?? '')) return null;
  if (!/^\d{1,3}\b/.test(occupancy ?? '')) return null;
  if (!/^\d{1,3}$/.test(extraBeds ?? '')) return null;
  return { roomType, rooms: rooms!, occupancy: occupancy!, extraBeds: extraBeds! };
}

/**
 * Splits "Superior Double Room 1 2 Adults 0" into its four columns.
 *
 * Anchored at BOTH ends so the shape must be: name, room count, an occupancy
 * phrase that starts with a number and carries a word, then the extra-bed
 * count. That is what stops the room name from swallowing the counts, and stops
 * the occupancy number from being read as the quantity.
 */
function splitSpacedRoomRow(line: string): RoomTableRow | null {
  const m = /^(.+?)\s+(\d{1,3})\s+(\d{1,3}\s*[^\d]{2,24}?)\s+(\d{1,3})$/.exec(line);
  if (!m) return null;
  return { roomType: m[1]!.trim(), rooms: m[2]!, occupancy: m[3]!.trim(), extraBeds: m[4]! };
}

function parseColumnRoomTable(all: string[]): RoomTableRow | null {
  const find = (header: string[], p: RegExp) => header.findIndex((h) => p.test(fold(h)));

  for (let i = 0; i < all.length; i++) {
    const header = cells(all[i]!);
    const iType = find(header, /^room ?type$/);
    const iRooms = find(header, /^no\.? of rooms$/);
    if (iType < 0 || iRooms < 0) continue;
    const iOcc = find(header, /^occupancy$/);
    const iBed = find(header, /^no\.? of extra bed$/);

    const j = nextNonEmpty(all, i + 1);
    if (j < 0) return null;
    let row = cells(all[j]!);

    // Values copied as separate logical lines: gather one cell per column.
    if (row.length === 1) {
      const collected: string[] = [];
      for (let k = j; k < all.length && collected.length < header.length; k++) {
        const line = all[k]!.trim();
        if (line.length === 0) continue;
        const c = cells(line);
        if (c.length !== 1 || isKnownLabel(c[0]!)) break;
        collected.push(c[0]!);
      }
      if (collected.length === header.length) row = collected;
    }

    const at = (idx: number) => (idx >= 0 && idx < row.length ? row[idx]! : null);
    return { roomType: at(iType), rooms: at(iRooms), occupancy: at(iOcc), extraBeds: at(iBed) };
  }
  return null;
}

/**
 * The booking id, as a BOUNDED numeric token. The labelled body field wins; a
 * copied subject line ("Agoda Booking ID 1753026280 - CONFIRMED …") is only a
 * fallback and still yields just the digits — never the trailing prose that used
 * to leak in ("Vietnam Check-in July 27 2026 LanguageEnglish").
 */
function extractBookingId(all: string[], rawText: string): string | null {
  const labelled = labelValue(all, /^(agoda )?booking id$/);
  if (labelled) {
    const m = /^\s*(\d{6,15})\b/.exec(labelled);
    if (m) return m[1]!;
  }
  const subject = /agoda booking id\s*[:#]?\s*(\d{6,15})\b/i.exec(rawText);
  if (subject) return subject[1]!;
  const anyLabel = /\bbooking id\s*[:#]?\s*(\d{6,15})\b/i.exec(rawText);
  return anyLabel ? anyLabel[1]! : null;
}

/**
 * The guest phone, bounded so the surrounding "Customer Info - Name: …, Phone: …"
 * prose never leaks in. Returns only the number.
 */
function extractPhone(rawText: string): string | null {
  const m = /\bphone\s*[:#]?\s*(\+?\d[\d\s().-]{4,24})/i.exec(rawText);
  if (!m) return null;
  const value = m[1]!.replace(/[.,;]+$/, '').trim();
  return value.length > 0 ? value : null;
}

/**
 * The public Agoda property name. Agoda renders it above a "(Property ID …)" line;
 * the id is deliberately ignored — it is never read, stored, shown or tested.
 */
function extractHotelName(all: string[]): string | null {
  // Agoda always prints the property name IMMEDIATELY ABOVE "(Property ID …)",
  // and that pairing is what identifies it. Taking the first hotel-looking line
  // instead picked up a neighbouring row when a reservations LIST preceded the
  // booking — naming the wrong property, and so resolving the wrong branch.
  const anchored = hotelAbovePropertyId(all);
  if (anchored) return clean(anchored);

  const labelled = labelValue(all, /property name|hotel name/);
  const candidate = labelled ?? all.find((l) => /^kas\b/i.test(l.trim())) ?? null;
  return candidate ? clean(candidate) : null;
}

/** Agoda's property id, for the record. Never used to choose a branch. */
function readPropertyId(all: readonly string[]): string | null {
  for (const line of all) {
    const match = /\(\s*property\s*id\s*:?\s*(\d{3,15})\s*\)/i.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/** The non-empty line directly above "(Property ID …)", if there is one. */
function hotelAbovePropertyId(all: readonly string[]): string | null {
  for (let i = 0; i < all.length; i++) {
    if (!/\(\s*property\s*id\b/i.test(all[i]!)) continue;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const text = all[j]!.trim();
      if (text.length === 0) continue;
      const first = cells(text)[0];
      if (!first || isKnownLabel(first)) break;
      return text;
    }
  }
  return null;
}

/** Strips any "(Property ID …)" fragment and collapses whitespace. */
function clean(candidate: string): string | null {
  const cleaned = candidate
    .replace(/\(\s*property\s*id[^)]*\)/gi, ' ')
    .replace(/\bproperty\s*id\b\s*:?\s*\d+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ---------------------------------------------------------------------------
// PMS note
// ---------------------------------------------------------------------------
export interface AgodaPmsNoteResult {
  ok: boolean;
  /** The exact two-line note when ok. */
  text?: string;
  /** A user-facing reason when the note cannot be generated. */
  error?: string;
}

/**
 * Builds the operator's exact two-line Agoda note:
 *
 *   AGD <BOOKING_ID>_<QTY><ROOM_CODE>_<NIGHTS>DEM <NET_RATE> CN
 *   GIÁ KHÁCH ĐẶT <REFERENCE_SELL_RATE> KHONG AN SANG
 *
 * The breakfast phrase is a fixed Agoda business rule: guest benefits such as
 * coffee/tea, drinking water or a welcome drink are NOT breakfast, so the second
 * line always ends "KHONG AN SANG".
 */
export function buildAgodaPmsNote(b: AgodaPartnerBooking): AgodaPmsNoteResult {
  const missing: string[] = [];
  if (!b.bookingId) missing.push('Booking ID');
  if (b.roomQuantity == null) missing.push('số lượng phòng');
  if (!b.roomCode) missing.push('mã hạng phòng');
  if (b.nights == null) missing.push('số đêm');
  if (b.netRate == null) missing.push('Net rate');
  if (b.referenceSellRate == null) missing.push('Reference sell rate');
  if (missing.length > 0) {
    return { ok: false, error: `Chưa đủ dữ liệu để tạo ghi chú Agoda: ${missing.join(', ')}.` };
  }

  const line1 = `AGD ${b.bookingId}_${b.roomQuantity}${b.roomCode}_${b.nights}DEM ${formatVndDots(b.netRate!)} CN`;
  const line2 = `GIÁ KHÁCH ĐẶT ${formatVndDots(b.referenceSellRate!)} KHONG AN SANG`;
  return { ok: true, text: `${line1}\n${line2}` };
}
