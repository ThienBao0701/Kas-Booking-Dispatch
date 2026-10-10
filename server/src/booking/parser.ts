import { normalizeText, removeDiacritics, toLines } from './text';
import {
  resolveBranchIdentityFromLines,
  type IdentityBranch,
  type IdentityPlatform,
} from './identityResolver';
import { detectCurrency, looksLikeMoney, parseFirstAmount } from './money';
import { findDate, generateStayDates, parseDateRangeStayDate } from './dates';
import { resolvePaymentStatus } from './paymentStatus';
import { extractSpecialRequest } from './arrivalNote';
// BRANCH_CONFIDENT_THRESHOLD is deliberately NOT imported any more: a
// similarity score, however high, no longer makes a branch match "confident".
// Only an exact identity / internal-name / branch-code match assigns a branch.
import { BRANCH_MATCH_THRESHOLD, findBestBranch, matchBranch } from './branchMatcher';
import type {
  ExtractWarning,
  FieldConfidence,
  MatchableBranch,
  ParsedBooking,
  ParsedNight,
  ParsedRoom,
  ParserQuality,
} from './types';

/** Extraction-engine version stamped onto every booking it produces. */
export const PARSER_VERSION = '4a.2.0';

// How far past a bare label to look for its value on following lines.
const VALUE_LOOKAHEAD = 5;

// Canonical field -> the exact normalised label keys that introduce it. Both the
// clean synthetic labels and the ones Booking.com renders on its detail page.
const FIELD_LABELS: Record<string, readonly string[]> = {
  guestName: [
    'khach', 'ten khach', 'ten khach hang', 'ho ten khach', 'guest', 'guest name',
    'ho ten', 'ten nguoi dat', 'ten', 'name',
    // Agoda
    'lead guest', 'ten khach chinh', 'customer name',
  ],
  phone: ['dien thoai', 'so dien thoai', 'sdt', 'dt', 'phone', 'phone number', 'tel', 'mobile'],
  bookingCode: [
    'ma dat phong', 'ma so dat phong', 'ma so dat cho', 'ma xac nhan', 'so xac nhan',
    'so xac nhan dat phong', 'ma xac nhan dat phong', 'so dat phong', 'so dat cho',
    'ma dat cho', 'ma booking', 'booking code', 'booking number', 'booking id',
    'confirmation', 'confirmation number', 'reservation', 'reservation number',
    // Agoda
    'agoda booking id', 'reference number', 'reference no', 'ma dat phong agoda', 'ma tham chieu',
  ],
  checkIn: ['nhan phong', 'ngay nhan phong', 'ngay nhan', 'ngay den', 'check in', 'checkin', 'arrival'],
  checkOut: ['tra phong', 'ngay tra phong', 'ngay tra', 'ngay di', 'check out', 'checkout', 'departure'],
  // Booking-*level* total only. Per-room totals ("Tổng giá phòng" / "Total room
  // price" / "Tổng phụ") are deliberately excluded so a room's own subtotal is
  // never captured as the booking total — the room subtotal is derived from its
  // nights instead. Booking.com's booking-level field is "Tổng tiền phòng".
  total: [
    'tong cong', 'tong tien', 'tong tien phong', 'tong gia', 'thanh tien',
    'tong thanh toan', 'tong so tien', 'gia cua ban', 'total', 'total price',
    'total cost', 'grand total',
    // Agoda
    'total charge', 'total amount', 'total all rooms', 'tong tien tat ca phong',
  ],
  payment: [
    'thanh toan', 'hinh thuc thanh toan', 'phuong thuc thanh toan', 'payment', 'payment status',
    // Agoda
    'payment method', 'payment details',
  ],
  hotel: ['khach san', 'ten khach san', 'hotel', 'property', 'property name'],
  // Authoritative room count (Booking.com extranet). Two-line forms ("Tổng số
  // căn" then "1") are captured here; single-line "Số phòng: 2" is still read as
  // a room quantity by detectRoomQuantity (which runs first in Pass 1).
  roomCount: [
    'tong so can', 'so can', 'tong so phong', 'so luong phong', 'so luong can',
    'so phong', 'tong so don vi', 'number of rooms', 'total rooms', 'total units',
    // Agoda
    'rooms booked', 'no of rooms', 'so phong da dat',
  ],
};

const LABEL_LOOKUP = new Map<string, string>();
for (const [field, labels] of Object.entries(FIELD_LABELS)) {
  for (const label of labels) LABEL_LOOKUP.set(label, field);
}

const ROOM_HEADER = /^(?:ph[oòơ]ng|room)\s*(\d+)?\s*[:\-–]\s*(.+)$/i;

// A leading room ordinal that precedes the type, as Booking.com's extranet lists
// physical rooms: "1 Phòng Tiêu Chuẩn …", "2 Room Standard …". The number is the
// room's ordinal (its index), never a quantity — the second capture is the type.
// Guarded by requiring "Phòng"/"Room" right after the number, so "2 người lớn",
// "3 đêm" or a "23 - 24 Tháng 7" date row never match.
const LEADING_ORDINAL_ROOM = /^(\d{1,2})\s+((?:ph[oòơ]ng|room)\b.+)$/i;

// Room-name detection for raw text where the type is a bare line ("Deluxe Double
// Room") rather than "Phòng N: …". Requires a strong type qualifier next to a
// room noun, or a standalone room noun, so policy sentences are not misread.
const ROOM_QUALIFIER =
  /\b(deluxe|superior|standard|suite|twin|double|king|queen|family|junior|executive|studio|single|triple|quad|premium|classic|grand|economy|budget)\b/;
const ROOM_NOUN = /\b(room|suite|studio|villa|apartment|bungalow|penthouse|dormitory|dorm|cabin)\b/;
const ROOM_STANDALONE = /\b(suite|studio|penthouse|bungalow|villa)\b/;

// Vietnamese room descriptors (on diacritic-free normalised text). A line that
// starts with "phong"/"suite" AND carries one of these is a room type — a
// whitelist keeps policy sentences that merely start with "Phòng" out.
const VN_ROOM_DESC =
  /\b(deluxe|superior|standard|suite|studio|premium|executive|junior|tieu chuan|gia dinh|giuong|doi|don|ban cong|nhin ra|thanh pho|cua so|ba nguoi|bon nguoi|hai giuong|view|cao cap|sang trong|thuong gia|gac lung|lien thong|twin|double|king|queen|single|triple|family|penthouse)\b/;

// Bare generic phrases that are never a room type on their own.
const GENERIC_ROOM_PHRASES = new Set([
  'phong', 'phong da dat', 'phong nghi', 'phong cua ban', 'phong va gia',
  'phong khac', 'cac phong', 'so phong', 'loai phong', 'thong tin phong',
  'chi tiet phong', 'chinh sach phong',
]);

// A "Loại phòng: …" / "Phòng đã đặt: …" style prefix that introduces the real type.
const ROOM_PREFIX_LABEL =
  /^(?:phòng đã đặt|loại phòng|kiểu phòng|hạng phòng|room type)\s*[:\-–]\s*(.+)$/i;

// Policy-section keywords. A room-type heading immediately followed only by these
// (and no price/date) is a policy heading, not a physical room.
const POLICY_KEYWORDS =
  /\b(huy dat phong|huy phong|chinh sach huy|tra truoc|thanh toan truoc|internet|wi fi|wifi|chinh sach|tre em|giuong phu|do xe|vat nuoi|dat coc|thiet hai|cancellation|prepayment|children|extra bed|parking|pets|deposit|breakfast|bua sang)\b/;

// Room-quantity signals within a section.
const PER_ROOM_SIGNAL =
  /\b(moi phong|per room|each room|cho moi phong|gia moi phong|tren moi phong|tung phong|gia mot phong|per room per night)\b/;
const COMBINED_SIGNAL =
  /\b(cho ca \d+ phong|cho ca hai phong|cho \d+ phong|cho hai phong|combined|tong cho|tong \d+ phong|tong gia \d+ phong|ca \d+ phong|for both rooms|for \d+ rooms|gia \d+ phong|gia cho \d+ phong)\b/;

type LineKind = 'room' | 'labeled' | 'bareLabel' | 'other';

interface Classified {
  raw: string;
  kind: LineKind;
  field?: string;
  value?: string;
  roomIndex?: number | null;
  roomName?: string | null;
}

interface FieldCapture {
  value: string | null;
  raw: string | null;
  ambiguous: boolean;
}

function matchRoomHeader(line: string): { index: number | null; name: string } | null {
  const m = line.match(ROOM_HEADER);
  if (!m) return null;
  const index = m[1] ? Number(m[1]) : null;
  return { index, name: (m[2] ?? '').trim() };
}

function clampQuantity(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

/**
 * A standalone room-quantity line ("Số phòng: 2", "Số lượng: 2", "Quantity: 2",
 * "Rooms: 2", "2 phòng", "2 rooms"), or null. Guest/adult/child/night counts and
 * embedded numbers ("3 đêm, 2 phòng") never match — the pattern anchors the whole
 * line so only a bare quantity qualifies.
 */
function detectRoomQuantity(line: string): number | null {
  const norm = normalizeText(line);
  const labelled = norm.match(
    /^(?:so phong|so luong phong|so luong|quantity|number of rooms|rooms?)\s+(\d{1,2})$/,
  );
  if (labelled) return clampQuantity(Number(labelled[1]));
  const bare = norm.match(/^(\d{1,2})\s+(?:phong|rooms?)$/);
  if (bare) return clampQuantity(Number(bare[1]));
  return null;
}

/**
 * Splits an inline room quantity ("Deluxe Double Room x2", "2 x Deluxe Room",
 * "Phòng Đôi (x2)") from a room name. Never treats a bed/person count inside the
 * name ("Phòng Superior 2 Giường Đơn") as a quantity — a quantity requires an
 * explicit x/× marker.
 */
function extractInlineQuantity(name: string): { name: string; quantity: number } {
  const n = name.trim();
  let m = n.match(/^(\d{1,2})\s*[x×]\s+(.+)$/);
  if (m) return { name: m[2]!.trim(), quantity: clampQuantity(Number(m[1])) ?? 1 };
  m = n.match(/^(.+?)\s*\(\s*[x×]?\s*(\d{1,2})\s*(?:phòng|rooms?)?\s*\)\s*$/i);
  if (m) return { name: m[1]!.trim(), quantity: clampQuantity(Number(m[2])) ?? 1 };
  m = n.match(/^(.+?)\s*[x×]\s*(\d{1,2})\s*$/);
  if (m) return { name: m[1]!.trim(), quantity: clampQuantity(Number(m[2])) ?? 1 };
  return { name: n, quantity: 1 };
}

/** True when a bare line reads like a room-type name (not a label or sentence). */
function isRoomTypeName(line: string): boolean {
  const norm = normalizeText(line);
  if (norm.length === 0 || line.length > 60) return false;
  if (LABEL_LOOKUP.has(norm) || GENERIC_ROOM_PHRASES.has(norm)) return false;
  if (detectRoomQuantity(line) !== null) return false;
  if (ROOM_QUALIFIER.test(norm) && ROOM_NOUN.test(norm)) return true;
  if (ROOM_STANDALONE.test(norm)) return true;
  // Vietnamese: "Phòng …" / "Suite …" carrying a whitelisted room descriptor.
  if (/^(?:phong|suite)\b/.test(norm) && VN_ROOM_DESC.test(norm)) return true;
  return false;
}

/**
 * Booking.com shows a bilingual room type: the Vietnamese name with the English
 * name in a trailing parenthesis, e.g. "Phòng Tiêu Chuẩn Giường Đôi (Standard
 * Double Room)". Keep the Vietnamese name the receptionist reads, dropping the
 * trailing "(…)".
 */
function stripEnglishParenthetical(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped.length > 0 ? stripped : name.trim();
}

/**
 * Detects a room section on a line and returns its type name (accents preserved),
 * any inline quantity, and whether the header was explicitly *numbered*
 * ("1 Phòng…", "Phòng 1:", "Room 2:"). Handles a leading ordinal, "Phòng N: name",
 * a "Loại phòng: name" prefix, and bare English/Vietnamese type names.
 *
 * `ordinal` marks a header whose room number makes it a certain physical room:
 * such a header is always kept (it is never mistaken for a repeated policy
 * heading) and its number is discarded, never read as a room quantity.
 */
function detectRoom(line: string): { name: string | null; quantity: number; ordinal: boolean } | null {
  const prefixed = line.match(ROOM_PREFIX_LABEL);
  const target = prefixed ? prefixed[1]!.trim() : line;

  // "1 Phòng …" / "2 Room …": the leading number is the room ordinal, not a type
  // qualifier and not a quantity. Strip it and keep the type that follows.
  const lead = target.match(LEADING_ORDINAL_ROOM);
  if (lead) {
    const { name, quantity } = extractInlineQuantity(lead[2]!.trim());
    const clean = nonEmpty(name);
    return { name: clean ? stripEnglishParenthetical(clean) : null, quantity, ordinal: true };
  }

  const header = matchRoomHeader(target);
  if (header && header.name.length > 0) {
    const { name, quantity } = extractInlineQuantity(header.name);
    const clean = nonEmpty(name);
    return { name: clean ? stripEnglishParenthetical(clean) : null, quantity, ordinal: header.index !== null };
  }
  if (isRoomTypeName(target)) {
    const { name, quantity } = extractInlineQuantity(target.trim());
    return { name: stripEnglishParenthetical(nonEmpty(name) ?? target.trim()), quantity, ordinal: false };
  }
  return null;
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * A real room block has price/date context within a few lines of its heading.
 * A heading with no such context is dropped as a phantom only when it duplicates
 * an already-seen room name or sits amongst policy keywords (e.g. the room type
 * repeated in the cancellation/policy section). A unique heading with no nearby
 * context is kept, so a legitimate room is never silently deleted.
 */
function isRealRoomHeading(
  lines: readonly string[],
  index: number,
  name: string | null,
  seen: readonly { roomName: string | null }[],
): boolean {
  const end = Math.min(lines.length, index + 7);
  let policyNearby = false;
  for (let j = index + 1; j < end; j += 1) {
    const l = lines[j]!;
    // Real pricing context is the strongest signal of an actual room. A nearby
    // *date* alone is not — a repeated room name in the policy/chat section sits
    // near message timestamps, and must not be resurrected into a phantom room.
    if (looksLikeMoney(l)) return true;
    if (POLICY_KEYWORDS.test(normalizeText(l))) policyNearby = true;
  }
  const normName = normalizeText(name ?? '');
  const duplicate = normName.length > 0 && seen.some((s) => normalizeText(s.roomName ?? '') === normName);
  return !(duplicate || policyNearby);
}

// Removes date tokens so the amount reader never swallows the date's digits, on
// a line where the stay date and its nightly price share one line.
function stripDates(line: string): string {
  return line
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4}/g, ' ')
    .replace(/\d{1,2}\s*(?:tháng|thang|thg)\s*\d{1,2}[^\d]{0,6}\d{4}/gi, ' ');
}

/** The nightly/total amount stated on a line, ignoring any date it also holds. */
function amountOnLine(line: string): number | null {
  return parseFirstAmount(stripDates(line));
}

/** A plausible person/hotel name line: has letters, is not money/date/phone. */
function cleanName(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  if (!/[a-zA-ZÀ-ỹ]/.test(trimmed)) return null;
  if (looksLikeMoney(trimmed) || findDate(trimmed)) return null;
  if (extractPhone(trimmed)) return null;
  return trimmed;
}

/**
 * Removes a trailing Booking.com property ID that is glued to (or trails) the
 * hotel name, e.g. "Saigon Hotel & Ben Thanh Market16806954" -> "…Market". Only a
 * long digit run (6+) at the very end is stripped, so a hotel whose name ends in
 * a small number is untouched. Used for display only — the raw text is preserved.
 */
function cleanHotelName(name: string | null): string | null {
  if (!name) return name;
  const stripped = name.replace(/\s*\d{6,}\s*$/, '').trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * The guest's own phone number, read from the primary guest-information block
 * (the few lines following the "Tên khách:" label) even when Booking.com prints
 * it without its own label. Bounded to that block so a hotel hotline, transfer
 * contact or a number inside the chat further down is never captured.
 */
function extractPrimaryGuestPhone(classified: readonly Classified[]): string | null {
  for (let i = 0; i < classified.length; i += 1) {
    const e = classified[i]!;
    const isGuestLabel =
      (e.kind === 'bareLabel' || e.kind === 'labeled') && e.field === 'guestName';
    if (!isGuestLabel) continue;
    const end = Math.min(classified.length, i + 7);
    for (let j = i + 1; j < end; j += 1) {
      const l = classified[j]!;
      if (l.kind === 'room') break;
      const phone = extractPhone(l.raw);
      if (phone) return phone;
    }
  }
  return null;
}

/** A Booking.com confirmation number: 8–12 digits not starting with 0. */
function extractBookingCode(value: string): string | null {
  const runs = value.match(/\d{4,}/g);
  if (!runs) return null;
  const candidate = runs.find((r) => r.length >= 8 && r.length <= 12 && !r.startsWith('0'));
  return candidate ?? null;
}

/** A Vietnamese or international phone number, or null. Dates/codes are rejected. */
function extractPhone(value: string): string | null {
  const m = value.match(/(\+?\d[\d\s.\-()]{6,}\d)/);
  if (!m || !m[1]) return null;
  const token = m[1].trim().replace(/\s{2,}/g, ' ');
  const digits = token.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  // VN/international numbers start with 0 or +; this excludes ISO dates and codes.
  if (!(token.startsWith('+') || digits.startsWith('0') || token.startsWith('84'))) return null;
  return token;
}

/**
 * Field-specific value parse, applied both to an inline "Label: value" and to a
 * following line when the label stands alone. Returns the comparable normalised
 * value (or null when the line does not yield this field's type).
 */
function extractField(field: string, line: string): string | null {
  switch (field) {
    case 'guestName':
    case 'hotel':
      return cleanName(line);
    case 'phone':
      return extractPhone(line);
    case 'bookingCode':
      return extractBookingCode(line);
    case 'checkIn':
    case 'checkOut':
      return findDate(line);
    case 'total': {
      const amount = amountOnLine(line);
      return amount === null ? null : String(amount);
    }
    case 'roomCount': {
      // A bare small integer, optionally with a room unit ("1", "2 căn",
      // "2 rooms"). Reject guest/adult/child/night counts ("1 người lớn").
      const t = line.trim();
      const m = t.match(/^(\d{1,2})\b/);
      if (!m) return null;
      const rest = removeDiacritics(t.slice(m[0].length)).toLowerCase();
      if (/(nguoi|khach|guest|adult|child|tre em|dem|night)/.test(rest)) return null;
      const n = Number(m[1]);
      return n >= 1 && n <= 16 ? String(n) : null;
    }
    case 'payment':
      return nonEmpty(line);
    default:
      return null;
  }
}

/**
 * The heart of the extraction engine. Pure and deterministic: it takes the raw
 * pasted Booking.com text plus the list of known branches and returns the fully
 * structured booking, generated stay nights and validation warnings — without
 * touching the database or ever inventing a monetary value. It tolerates the
 * noise (duplicated labels, navigation chrome, values on the next line, weekday
 * dates, non-breaking spaces) of text copied straight from a reservation page.
 */
export function parseBooking(
  rawText: string,
  branches: readonly MatchableBranch[],
  /** Which platform's current identities to resolve the hotel name against. */
  platform: IdentityPlatform = 'BOOKING_COM',
): ParsedBooking {
  const lines = toLines(rawText);

  // --- Pass 1: classify every line and build the section list ---------------
  // A "section" is one detected room header, carrying a quantity that expands
  // into that many physical rooms in Pass 3.
  const classified: Classified[] = [];
  const roomOrdinalOf: number[] = []; // per line -> index into `sections` (-1 = none yet)
  const sections: { roomName: string | null; quantity: number; startLine: number }[] = [];
  let pendingQuantity: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let kind: Classified = { raw: line, kind: 'other' };

    const room = detectRoom(line);
    // A numbered ("ordinal") header is always a real, distinct physical room —
    // it bypasses the phantom-heading guard, so two identical "1 Phòng…" /
    // "2 Phòng…" rooms are both kept even though their type names match.
    if (room && (room.ordinal || isRealRoomHeading(lines, i, room.name, sections))) {
      let quantity = room.quantity;
      // An ordinal header's number is its index, never a quantity, and it must
      // not absorb a pending "Số phòng: N" from before it.
      if (!room.ordinal && quantity === 1 && pendingQuantity !== null) quantity = pendingQuantity;
      pendingQuantity = null;
      sections.push({ roomName: room.name, quantity, startLine: i });
      kind = { raw: line, kind: 'room' };
    } else if (room) {
      // A room-type heading with no pricing/date context that repeats an existing
      // room or sits in a policy section — treat as ordinary noise, not a room.
      kind = { raw: line, kind: 'other' };
    } else {
      const quantity = detectRoomQuantity(line);
      if (quantity !== null) {
        // Attach the quantity to the current section, or hold it for the next.
        const current = sections[sections.length - 1];
        if (current && current.quantity === 1) current.quantity = quantity;
        else if (!current) pendingQuantity = quantity;
        // Left as an 'other' meta line: it carries no date, so later passes ignore it.
      } else {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = normalizeText(line.slice(0, colon));
          const field = LABEL_LOOKUP.get(key);
          if (field) {
            const value = line.slice(colon + 1).trim();
            kind = value.length > 0
              ? { raw: line, kind: 'labeled', field, value }
              : { raw: line, kind: 'bareLabel', field };
          }
        }
        if (kind.kind === 'other') {
          const field = LABEL_LOOKUP.get(normalizeText(line));
          if (field) kind = { raw: line, kind: 'bareLabel', field };
        }
      }
    }

    classified.push(kind);
    roomOrdinalOf.push(sections.length - 1);
  }

  // --- Pass 2: capture scalar fields ---------------------------------------
  const captured: Record<string, FieldCapture> = {};

  const offer = (field: string, value: string | null, raw: string | null): void => {
    const prev = captured[field];
    if (!prev) {
      captured[field] = { value, raw, ambiguous: false };
      return;
    }
    if (value === null) return;
    if (prev.value === null) {
      prev.value = value;
      prev.raw = raw;
    } else if (prev.value !== value) {
      prev.ambiguous = true; // conflicting values -> keep the first, flag it
    }
  };

  const scanForwardValue = (start: number, field: string): { value: string; raw: string } | null => {
    let seen = 0;
    for (let j = start + 1; j < classified.length && seen < VALUE_LOOKAHEAD; j += 1) {
      const entry = classified[j]!;
      if (entry.kind === 'labeled' || entry.kind === 'bareLabel' || entry.kind === 'room') break;
      seen += 1;
      const value = extractField(field, entry.raw);
      if (value !== null) return { value, raw: entry.raw };
    }
    return null;
  };

  for (let i = 0; i < classified.length; i += 1) {
    const entry = classified[i]!;
    // Guest-name protection: a "Tên khách" label *inside* a room section names a
    // room occupant, not the reservation-level customer. Once the reservation
    // (pre-room) guest name is captured, room-level ones are ignored — never
    // overwriting it and never raising a duplicate-label conflict.
    if (
      entry.field === 'guestName' &&
      roomOrdinalOf[i]! >= 0 &&
      captured.guestName?.value != null
    ) {
      continue;
    }
    if (entry.kind === 'labeled') {
      offer(entry.field!, extractField(entry.field!, entry.value!), entry.value!);
    } else if (entry.kind === 'bareLabel') {
      const found = scanForwardValue(i, entry.field!);
      if (found) offer(entry.field!, found.value, found.raw);
    }
  }

  // --- Hotel / branch resolution -------------------------------------------
  const hotelLabel = captured.hotel?.value ?? null;
  const otherLines = classified.filter((c) => c.kind === 'other').map((c) => c.raw);
  const scan = findBestBranch(otherLines, branches);
  const labelMatch = hotelLabel ? matchBranch(hotelLabel, branches) : null;

  let branchMatchScore = scan.match?.score ?? 0;
  let branchLine = scan.line;
  let branchCandidate = scan.match?.branch ?? null;
  if (labelMatch && labelMatch.score >= branchMatchScore) {
    branchMatchScore = labelMatch.score;
    branchLine = hotelLabel;
    branchCandidate = labelMatch.branch;
  }

  // EXACT resolution against the branch's CURRENT platform identity, its
  // internal name, or a trusted stable code. This is the ONLY thing that may
  // auto-assign a branch: the similarity scan above now feeds suggestions and
  // the preview score, never the assignment itself. A wrong automatic branch
  // sends a real guest to the wrong hotel.
  const identity = resolveBranchIdentityFromLines(
    [hotelLabel, ...otherLines],
    platform,
    branches as readonly IdentityBranch[],
  );
  const exactBranch =
    identity.resolution.branchId !== null
      ? (branches.find((b) => b.id === identity.resolution.branchId) ?? null)
      : null;

  // A similarity hit is still shown to the Admin as a candidate, but it never
  // makes the match "confident" and therefore never assigns the branch.
  const suggestedBranch =
    exactBranch ?? (branchMatchScore >= BRANCH_MATCH_THRESHOLD ? branchCandidate : null);
  const branchConfident = exactBranch !== null;
  const branchAmbiguous = identity.resolution.reason === 'AMBIGUOUS';
  const hotelName = cleanHotelName(
    hotelLabel ?? identity.matchedLine ?? branchLine ?? otherLines[0] ?? null,
  );

  // --- Scalar fields --------------------------------------------------------
  const guestName = captured.guestName?.value ?? null;
  // Prefer a labelled phone; otherwise read it from the primary guest block, where
  // Booking.com often lists the number with no "Số điện thoại:" label of its own.
  const phone = captured.phone?.value ?? extractPrimaryGuestPhone(classified);
  const bookingCode = captured.bookingCode?.value ?? null;
  const checkIn = captured.checkIn?.value ?? null;
  const checkOut = captured.checkOut?.value ?? null;
  const totalAmount = captured.total?.value !== undefined && captured.total?.value !== null
    ? Number(captured.total.value)
    : null;
  const currency = detectCurrency(captured.total?.raw) ?? 'VND';
  const paymentStatus = resolvePaymentStatus(rawText, captured.payment?.value ?? null);
  const specialRequest = extractSpecialRequest(rawText);

  // Authoritative room count from an explicit label ("Tổng số căn", "Số phòng",
  // "Number of rooms", …). It takes priority over any count inferred from guest
  // counts, occupancy, nights, prices or ids. When it is greater than a single
  // detected room, that room is treated as a quantity-based group and expanded by
  // the existing Pass-3 quantity logic (which never divides or duplicates prices).
  const authoritativeRoomCount =
    captured.roomCount?.value != null ? Number(captured.roomCount.value) : null;
  if (
    authoritativeRoomCount !== null &&
    authoritativeRoomCount > 1 &&
    sections.length === 1 &&
    sections[0]!.quantity === 1
  ) {
    sections[0]!.quantity = authoritativeRoomCount;
  }

  const warnings: ExtractWarning[] = [];
  const rangeValid = checkIn !== null && checkOut !== null && checkOut > checkIn;
  const expectedNights = rangeValid ? generateStayDates(checkIn, checkOut) : [];
  const expectedSet = new Set(expectedNights);

  // --- Pass 3: nightly price association ------------------------------------
  // Collect (date, amount, room) candidates from loose lines. A candidate is a
  // date-bearing line whose amount is on the same line or the immediately
  // following money-only line. Only dates within the stay range count (when the
  // range is known), which keeps cancellation-deadline fees out of the nights.
  // The year is not printed on nightly-rate-table rows ("23 - 24 Tháng 7"); infer
  // it from the reservation's own check-in/out year.
  const yearHint = checkIn ? Number(checkIn.slice(0, 4)) : checkOut ? Number(checkOut.slice(0, 4)) : null;

  // Labels that end a room's nightly rows — the amount after them is a subtotal /
  // room total / booking total, never a night's price.
  const STOP_AMOUNT_LABEL = /\b(?:tong phu|tong gia phong|tong tien phong|tong cong|tong thanh toan|subtotal|sub total|grand total)\b/;

  /**
   * The nightly amount for a rate-table date row whose price sits a couple of
   * lines below it, after the rate-plan description ("Fully flexible, …"). Skips
   * such description lines and returns the first money value, but stops at the
   * next date row or a subtotal/total label so a room total is never read as a
   * night's price.
   */
  const scanNightAmount = (start: number): number | null => {
    const limit = Math.min(classified.length, start + 4);
    for (let j = start + 1; j < limit; j += 1) {
      const e = classified[j]!;
      if (e.kind !== 'other') break; // a label/room header ends the room's rows
      if (findDate(e.raw) || parseDateRangeStayDate(e.raw, yearHint)) break; // next night
      if (STOP_AMOUNT_LABEL.test(normalizeText(e.raw))) break; // subtotal / total
      if (looksLikeMoney(e.raw)) return amountOnLine(e.raw);
      // otherwise a rate-plan description line: keep scanning
    }
    return null;
  };

  interface Candidate { date: string; amount: number | null; room: number }
  const candidates: Candidate[] = [];
  for (let i = 0; i < classified.length; i += 1) {
    const entry = classified[i]!;
    if (entry.kind !== 'other') continue;
    // A full date ("Thứ Năm, 23 tháng 7 2026") or a year-less rate-table range
    // ("23 - 24 Tháng 7", first day = the stay night).
    const date = findDate(entry.raw) ?? parseDateRangeStayDate(entry.raw, yearHint);
    if (!date) continue;
    if (rangeValid && !expectedSet.has(date)) continue;
    let amount = amountOnLine(entry.raw);
    if (amount === null) amount = scanNightAmount(i);
    candidates.push({ date, amount, room: roomOrdinalOf[i]! });
  }

  const defaultRoomFallback = sections.length === 0;
  const activeSections = sections.length > 0
    ? sections
    : (candidates.length > 0 ? [{ roomName: null, quantity: 1, startLine: 0 }] : []);

  const emptyByDate = new Map<string, number | null>();

  const nightsFrom = (byDate: Map<string, number | null>): ParsedNight[] => {
    if (rangeValid) {
      return expectedNights.map((date) => ({
        stayDate: date,
        amount: byDate.get(date) ?? null,
        currency,
        isEstimated: false,
      }));
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, amount]) => ({ stayDate: date, amount, currency, isEstimated: false }));
  };
  const foundCount = (byDate: Map<string, number | null>): number =>
    new Set([...byDate.keys()].filter((d) => expectedSet.has(d))).size;
  const sectionSignalText = (si: number): string => {
    if (defaultRoomFallback) return '';
    const start = activeSections[si]!.startLine;
    const end = si + 1 < activeSections.length ? activeSections[si + 1]!.startLine : lines.length;
    return normalizeText(lines.slice(start, end).join(' '));
  };

  /**
   * The single room price stated in a section *before* its stay-date rows, e.g.
   * "Phòng … / VND 510.138 / T3, 21 tháng 7 2026". Only the few lines between the
   * room header and the first date are inspected (bounded window), so commission,
   * policy and chat amounts far below can never be mistaken for the room price.
   * Returns the amount only when the window holds exactly one distinct value.
   */
  const priceBeforeDates = (si: number): number | null => {
    if (defaultRoomFallback) return null;
    const start = activeSections[si]!.startLine;
    const nextStart = si + 1 < activeSections.length ? activeSections[si + 1]!.startLine : lines.length;
    const limit = Math.min(nextStart, start + 8, lines.length);
    const amounts: number[] = [];
    for (let j = start + 1; j < limit; j += 1) {
      const l = lines[j]!;
      if (findDate(l)) break; // reached the stay-date rows
      if (looksLikeMoney(l)) {
        const a = amountOnLine(l);
        if (a !== null) amounts.push(a);
      }
    }
    const distinct = [...new Set(amounts)];
    return distinct.length === 1 ? distinct[0]! : null;
  };

  const finalRooms: ParsedRoom[] = [];
  let physicalIndex = 0;

  const pushRoom = (
    roomName: string | null,
    byDate: Map<string, number | null>,
    conflict: boolean,
    emitWarnings: boolean,
  ): void => {
    physicalIndex += 1;
    const nights = nightsFrom(byDate);
    if (emitWarnings) {
      const found = foundCount(byDate);
      if (rangeValid && found !== expectedNights.length) {
        warnings.push({
          code: 'NIGHT_COUNT_MISMATCH',
          severity: 'WARNING',
          message: `Phòng ${physicalIndex}: số đêm không khớp (mong đợi ${expectedNights.length}, tìm thấy ${found}).`,
        });
      }
      if (nights.some((n) => n.amount === null)) {
        warnings.push({
          code: 'MISSING_NIGHTLY_PRICE',
          severity: 'WARNING',
          message: `Phòng ${physicalIndex}: có đêm chưa xác định giá.`,
        });
      }
      if (conflict) {
        warnings.push({
          code: 'AMBIGUOUS_NIGHTLY_PRICE',
          severity: 'WARNING',
          message: `Phòng ${physicalIndex}: có giá đêm mâu thuẫn, vui lòng kiểm tra.`,
        });
      }
    }
    finalRooms.push({
      roomIndex: physicalIndex,
      roomName,
      roomTotal: computeRoomTotal(nights),
      nights,
    });
  };

  for (let si = 0; si < activeSections.length; si += 1) {
    const section = activeSections[si]!;
    const mine = candidates.filter((c) => (defaultRoomFallback ? true : c.room === si));

    // Amounts by date, preferring a real amount over a null placeholder and
    // flagging a genuine conflict (two different prices for the same date).
    const byDate = new Map<string, number | null>();
    let priceConflict = false;
    for (const c of mine) {
      if (!byDate.has(c.date)) {
        byDate.set(c.date, c.amount);
      } else {
        const existing = byDate.get(c.date) ?? null;
        if (existing === null) byDate.set(c.date, c.amount);
        else if (c.amount !== null && c.amount !== existing) priceConflict = true;
      }
    }
    const hasPerNight = [...byDate.values()].some((v) => v !== null);

    if (section.quantity <= 1) {
      // Single room, single night, with the price stated before the date: assign
      // that one section price to the one stay night (never divide or invent).
      if (rangeValid && expectedNights.length === 1) {
        const only = expectedNights[0]!;
        if ((byDate.get(only) ?? null) === null) {
          const price = priceBeforeDates(si);
          if (price !== null) byDate.set(only, price);
        }
      }
      pushRoom(section.roomName, byDate, priceConflict, true);
      continue;
    }

    // --- Room quantity aggregation: one section = `quantity` physical rooms ---
    const text = sectionSignalText(si);
    const perRoom = PER_ROOM_SIGNAL.test(text);
    const combined = COMBINED_SIGNAL.test(text);

    if (hasPerNight && perRoom && !combined) {
      // Case B: an explicit per-room nightly price is copied to each room. The
      // values are real (not estimated), just shared across identical rooms.
      for (let k = 0; k < section.quantity; k += 1) {
        pushRoom(section.roomName, byDate, priceConflict, k === 0);
      }
    } else {
      // Cases C/D: per-room pricing cannot be established safely. Never divide or
      // duplicate a combined amount — keep each nightly amount null (the combined
      // total, if any, is preserved on the booking) and flag for Admin review.
      warnings.push({
        code: 'AMBIGUOUS_ROOM_QUANTITY_PRICE',
        severity: 'WARNING',
        message: `Phòng "${section.roomName ?? '?'}" (số lượng ${section.quantity}): không xác định được giá cho từng phòng, cần Admin kiểm tra.`,
      });
      if (hasPerNight && !combined) {
        warnings.push({
          code: 'AMBIGUOUS_NIGHTLY_PRICE',
          severity: 'WARNING',
          message: `Phòng "${section.roomName ?? '?'}": không rõ giá là cho mỗi phòng hay tổng, giữ trống giá đêm.`,
        });
      }
      for (let k = 0; k < section.quantity; k += 1) {
        pushRoom(section.roomName, emptyByDate, false, false);
      }
    }
  }

  // --- Booking-level validation & confidence warnings -----------------------
  if (branchAmbiguous) {
    warnings.unshift({
      code: 'AMBIGUOUS_HOTEL',
      severity: 'WARNING',
      message: hotelName
        ? `Tên khách sạn "${hotelName}" khớp với nhiều chi nhánh. Vui lòng chọn chi nhánh thủ công.`
        : 'Tên khách sạn khớp với nhiều chi nhánh. Vui lòng chọn chi nhánh thủ công.',
    });
  } else if (!suggestedBranch) {
    warnings.unshift({
      code: 'UNKNOWN_HOTEL',
      severity: 'WARNING',
      message: hotelName
        ? `Không nhận diện được khách sạn "${hotelName}". Vui lòng chọn chi nhánh thủ công.`
        : 'Không tìm thấy tên khách sạn. Vui lòng chọn chi nhánh thủ công.',
    });
  } else if (!branchConfident) {
    // A similarity suggestion — offered, never applied.
    warnings.unshift({
      code: 'LOW_BRANCH_CONFIDENCE',
      severity: 'WARNING',
      message: `Chưa chắc chắn khách sạn là "${suggestedBranch.hotelName}". Vui lòng xác nhận chi nhánh.`,
    });
  }
  // Authoritative room count disagrees with the rooms actually built (e.g. the
  // count conflicts with explicit separate room sections). Preserve the safe
  // detected rooms and flag it — never silently delete, merge or invent rooms.
  if (authoritativeRoomCount !== null && authoritativeRoomCount !== finalRooms.length) {
    warnings.push({
      code: 'ROOM_COUNT_MISMATCH',
      severity: 'WARNING',
      message: `Số căn khai báo (${authoritativeRoomCount}) khác số phòng nhận diện (${finalRooms.length}); vui lòng kiểm tra.`,
    });
  }
  if (!guestName) {
    warnings.push({ code: 'MISSING_GUEST', severity: 'WARNING', message: 'Thiếu tên khách.' });
  }
  if (!bookingCode) {
    warnings.push({ code: 'MISSING_BOOKING_CODE', severity: 'WARNING', message: 'Thiếu mã đặt phòng.' });
  } else if (captured.bookingCode?.ambiguous) {
    warnings.push({
      code: 'AMBIGUOUS_BOOKING_CODE',
      severity: 'WARNING',
      message: 'Có nhiều mã đặt phòng khác nhau; vui lòng kiểm tra.',
    });
  }
  if (captured.total?.ambiguous) {
    warnings.push({
      code: 'AMBIGUOUS_TOTAL',
      severity: 'WARNING',
      message: 'Có nhiều tổng tiền khác nhau; vui lòng kiểm tra.',
    });
  }
  for (const field of ['guestName', 'phone', 'checkIn', 'checkOut'] as const) {
    if (captured[field]?.ambiguous) {
      warnings.push({
        code: 'DUPLICATED_LABEL_CONFLICT',
        severity: 'WARNING',
        message: 'Nội dung dán có nhãn lặp lại với giá trị khác nhau; vui lòng kiểm tra.',
      });
      break;
    }
  }
  if (!checkIn || !checkOut) {
    warnings.push({
      code: 'MISSING_DATES',
      severity: 'ERROR',
      message: 'Thiếu hoặc không đọc được ngày nhận/trả phòng.',
    });
  } else if (checkOut <= checkIn) {
    warnings.push({
      code: 'INVALID_DATE_RANGE',
      severity: 'ERROR',
      message: 'Ngày trả phòng phải sau ngày nhận phòng.',
    });
  }
  if (finalRooms.length === 0) {
    warnings.push({
      code: 'MISSING_ROOM',
      severity: 'ERROR',
      message: 'Không tìm thấy phòng nào trong nội dung.',
    });
  }

  const fieldConfidence: Record<string, FieldConfidence> = {
    guestName: confidenceOf(captured.guestName),
    phone: confidenceOf(captured.phone),
    bookingCode: confidenceOf(captured.bookingCode),
    checkIn: confidenceOf(captured.checkIn),
    checkOut: confidenceOf(captured.checkOut),
    total: confidenceOf(captured.total),
  };

  // 0–100 scale of the matcher score for the *suggested* branch; 0 when the hotel
  // is unknown (no branch reached the suggest threshold).
  const branchConfidence = branchConfident
    ? 100
    : suggestedBranch
      ? Math.round(branchMatchScore * 100)
      : 0;
  const parserQuality = computeParserQuality({
    bookingCode,
    guestName,
    checkIn,
    checkOut,
    totalAmount,
    rooms: finalRooms,
    rangeValid,
    branchConfident,
    requiresManualConfirmation: !branchConfident,
    warnings,
    phone,
    specialRequest,
  });

  return {
    hotelName,
    guestName,
    phone,
    bookingCode,
    checkIn,
    checkOut,
    currency,
    totalAmount,
    specialRequest,
    paymentStatus,
    paymentStatusKnown: true,
    rooms: finalRooms,
    suggestedBranch,
    branchMatchScore,
    branchConfidence,
    branchConfident,
    requiresManualConfirmation: !branchConfident,
    fieldConfidence,
    parserQuality,
    warnings,
    parserVersion: PARSER_VERSION,
  };
}

/** The critical fields a receptionist cannot dispatch without. */
const CRITICAL_FIELDS = [
  'bookingCode',
  'customerName',
  'checkInDate',
  'checkOutDate',
  'rooms',
  'totalAmount',
] as const;

interface QualityInput {
  bookingCode: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  totalAmount: number | null;
  rooms: readonly ParsedRoom[];
  rangeValid: boolean;
  branchConfident: boolean;
  requiresManualConfirmation: boolean;
  warnings: readonly ExtractWarning[];
  phone: string | null;
  specialRequest: string | null;
}

/**
 * A deterministic, weighted *completeness* score (0–100) for the extraction. It
 * measures how much of what a receptionist needs was extracted cleanly — it is
 * not a probabilistic confidence. Optional fields (phone, special request) carry
 * negligible weight, so a complete booking that simply lacks a phone stays HIGH.
 * A missing critical field or any blocking (ERROR) warning forces admin review.
 */
function computeParserQuality(input: QualityInput): ParserQuality {
  const has = (code: string): boolean => input.warnings.some((w) => w.code === code);
  const roomsOk = input.rooms.length > 0;
  const everyNightPresent =
    roomsOk && input.rooms.every((r) => r.nights.length > 0 && r.nights.every((n) => n.amount !== null));
  const everyNightDatePresent = roomsOk && input.rangeValid && !has('NIGHT_COUNT_MISMATCH');
  const roomStructureOk = roomsOk && !has('ROOM_COUNT_MISMATCH');

  let score = 0;
  if (input.bookingCode) score += 15;
  if (input.guestName) score += 10;
  if (input.checkIn) score += 10;
  if (input.checkOut) score += 10;
  if (roomStructureOk) score += 10;
  if (everyNightDatePresent) score += 10;
  if (everyNightPresent) score += 15;
  if (input.totalAmount !== null) score += 10;
  if (input.branchConfident) score += 5;
  score += 3; // payment status is always resolved to a definite value
  if (input.phone) score += 1;
  if (input.specialRequest) score += 1;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const missingCriticalFields: string[] = [];
  if (!input.bookingCode) missingCriticalFields.push('bookingCode');
  if (!input.guestName) missingCriticalFields.push('customerName');
  if (!input.checkIn) missingCriticalFields.push('checkInDate');
  if (!input.checkOut) missingCriticalFields.push('checkOutDate');
  if (!roomsOk) missingCriticalFields.push('rooms');
  if (input.totalAmount === null) missingCriticalFields.push('totalAmount');
  void CRITICAL_FIELDS; // documents the critical-field set

  const hasBlockingWarning = input.warnings.some((w) => w.severity === 'ERROR');
  const requiresAdminReview =
    score < 90 ||
    hasBlockingWarning ||
    missingCriticalFields.length > 0 ||
    input.requiresManualConfirmation;

  const level: ParserQuality['level'] = score >= 90 ? 'HIGH' : score >= 75 ? 'MEDIUM' : 'LOW';

  return {
    score,
    level,
    requiresAdminReview,
    missingCriticalFields,
    warningCount: input.warnings.length,
  };
}

function confidenceOf(capture: FieldCapture | undefined): FieldConfidence {
  if (!capture || capture.value === null) return 'MISSING';
  return capture.ambiguous ? 'AMBIGUOUS' : 'CONFIDENT';
}

function computeRoomTotal(nights: readonly ParsedNight[]): number | null {
  if (nights.length === 0) return null;
  let sum = 0;
  for (const night of nights) {
    if (night.amount === null) return null; // incomplete -> do not invent a total
    sum += night.amount;
  }
  return sum;
}
