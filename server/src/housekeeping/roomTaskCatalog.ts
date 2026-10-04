/**
 * THE DAILY ROOM WORK CATALOG — one source of truth for the board's room codes
 * and the "Dọn phòng" form, served to every screen (`GET /housekeeping/catalog`)
 * and validated here on every save.
 *
 * THE CODES AND ITEM NAMES ARE THE OPERATION'S OWN, kept exactly as given: the
 * board's rows (OUT, OC, VC — there is no CC), the bed-linen types King / Queen /
 * Twin, the item names of the paper housekeeping form, the six replacement
 * items and the six "Ghi nhận đặc biệt". Nothing here defines what a code
 * means; extending the form is adding a line to a list.
 */
import { ApiError } from '../lib/errors';

/** The board's rows — the room's operational code for the day. */
export const ROOM_STATUS_CODES = ['OUT', 'OC', 'VC'] as const;
export type RoomStatusCode = (typeof ROOM_STATUS_CODES)[number];

export const ROOM_WORK_STATE_LABELS = {
  NOT_STARTED: 'Chưa bắt đầu',
  IN_PROGRESS: 'Đang dọn',
  COMPLETED: 'Hoàn thành',
} as const;

/** The manager's quality review of a finished cycle. */
export const ROOM_REVIEW_LABELS = {
  PENDING: 'Chờ đánh giá',
  PASSED: 'Đạt',
  FAILED: 'Không đạt',
} as const;

/** A re-clean cycle not yet finished. */
export const RECLEAN_LABEL = 'Cần dọn lại';

/**
 * Where ONE cycle stands, in a word — the cleaning state and the review read
 * together, never merged in the data: Chưa bắt đầu / Cần dọn lại / Đang dọn /
 * Chờ đánh giá / Đạt / Không đạt (— dọn lại).
 */
export function cycleOutcomeLabel(t: {
  state: keyof typeof ROOM_WORK_STATE_LABELS;
  reviewResult: 'PASSED' | 'FAILED' | null;
  recleanRequested: boolean;
  previousTaskId: string | null;
}): string {
  if (t.reviewResult === 'PASSED') return ROOM_REVIEW_LABELS.PASSED;
  if (t.reviewResult === 'FAILED') return t.recleanRequested ? `${ROOM_REVIEW_LABELS.FAILED} — dọn lại` : ROOM_REVIEW_LABELS.FAILED;
  if (t.state === 'COMPLETED') return ROOM_REVIEW_LABELS.PENDING;
  if (t.state === 'NOT_STARTED' && t.previousTaskId) return RECLEAN_LABEL;
  return ROOM_WORK_STATE_LABELS[t.state];
}

/** Bed linen: ONE type per item — King, Queen or Twin — and how many. */
export const LINEN_ITEMS = [
  { code: 'BED_SHEET', label: 'Ga giường' },
  { code: 'DUVET_COVER', label: 'Bọc chăn' },
  { code: 'MATTRESS_PROTECTOR', label: 'Bảo vệ nệm' },
] as const;
export const LINEN_SIZES = [
  { code: 'K', label: 'King' },
  { code: 'Q', label: 'Queen' },
  { code: 'T', label: 'Twin' },
] as const;

/** Counted items — a whole number each. */
export const QUANTITY_ITEMS = [
  { code: 'PILLOWCASE', label: 'Áo gối' },
  { code: 'PILLOW_PROTECTOR', label: 'Bảo vệ gối' },
  { code: 'BATH_TOWEL', label: 'Khăn tắm' },
  { code: 'HAND_TOWEL', label: 'Khăn tay' },
  { code: 'BATH_MAT', label: 'Thảm chân' },
  { code: 'BATHROBE', label: 'Áo choàng tắm' },
  { code: 'SLIPPERS', label: 'Dép' },
  { code: 'WATER', label: 'Nước suối' },
  { code: 'RAZOR', label: 'Dao cạo râu' },
  { code: 'TOOTHBRUSH', label: 'Bàn chải đánh răng' },
  { code: 'TOILET_ROLL', label: 'Toilet roll' },
  { code: 'LAUNDRY_BAG', label: 'Laundrybag' },
] as const;

/** "Đánh dấu nếu đồ được thay thế" — ✓ when replaced: the six items, exactly as named. */
export const REPLACEMENT_ITEMS = [
  { code: 'COMB_COTTON_CAP', label: 'Lược, tăm bông, chụp tóc' },
  { code: 'TEA_COFFEE_SUGAR', label: 'Trà, cà phê, đường. Miễn phí' },
  { code: 'TISSUE', label: 'Giấy ăn, lau tay' },
  { code: 'HAND_WASH', label: 'Nước rửa tay' },
  { code: 'SHAMPOO', label: 'Dầu gội' },
  { code: 'SHOWER_GEL', label: 'Sữa tắm' },
] as const;

/**
 * "GHI NHẬN ĐẶC BIỆT" — observations about the room, apart from its code
 * (OUT / OC / VC) and from the cleaning state. Any number may apply.
 */
export const SPECIAL_STATUSES = [
  { code: 'LB', short: 'L/B', label: 'Khách có hành lý gọn nhẹ' },
  { code: 'SO', short: 'SO', label: 'Phòng có đồ nhưng khách không ngủ' },
  { code: 'DND', short: 'DND', label: 'Không làm phiền' },
  { code: 'OOO', short: 'OOO', label: 'Không thể bán phòng' },
  { code: 'OS', short: 'OS', label: 'Phòng ngưng tạm' },
  { code: 'LNL', short: 'LNL', label: 'Hàng thất lạc' },
] as const;

const SIZE_CODES: readonly string[] = LINEN_SIZES.map((z) => z.code);
const REPLACEMENT_CODES: readonly string[] = REPLACEMENT_ITEMS.map((i) => i.code);
const SPECIAL_CODES: readonly string[] = SPECIAL_STATUSES.map((i) => i.code);

/** The comb, the cotton buds and the shower cap were once ticked apart; they are one item now. */
const LEGACY_REPLACEMENTS: Record<string, string> = { COMB: 'COMB_COTTON_CAP', COTTON_BUDS: 'COMB_COTTON_CAP', SHOWER_CAP: 'COMB_COTTON_CAP' };

export const MAX_QUANTITY = 999;

export interface CleaningForm {
  /** Per linen item: its one type (K / Q / T — King / Queen / Twin) and how many. */
  linen: Record<string, { size: string; quantity: number }>;
  /** Per counted item, how many (0 is left out). */
  quantities: Record<string, number>;
  /** The replacement items ticked ✓. */
  replaced: string[];
  /** The "Ghi nhận đặc biệt" ticked. */
  special: string[];
  note: string | null;
}

/** A saved form as screens and reports read it; `quantity` is null only on linen saved before it had one. */
export interface StoredCleaning extends Omit<CleaningForm, 'linen'> {
  linen: Record<string, { size: string; quantity: number | null }>;
  savedAt?: string;
  savedByUserId?: number;
  savedByName?: string;
}

/** Everything the screens need to draw the board and the form. */
export function roomWorkCatalog() {
  return {
    statusCodes: ROOM_STATUS_CODES,
    states: ROOM_WORK_STATE_LABELS,
    linen: LINEN_ITEMS,
    linenSizes: LINEN_SIZES,
    quantities: QUANTITY_ITEMS,
    replacements: REPLACEMENT_ITEMS,
    specialStatuses: SPECIAL_STATUSES,
    maxQuantity: MAX_QUANTITY,
  };
}

export function assertStatusCode(raw: unknown): RoomStatusCode {
  if (typeof raw !== 'string' || !(ROOM_STATUS_CODES as readonly string[]).includes(raw)) {
    throw ApiError.validation('Tình trạng phòng không hợp lệ.');
  }
  return raw as RoomStatusCode;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_QUANTITY;

/** A list of codes from one catalog list, in the catalog's order; anything unknown is refused. */
function codesOf(raw: unknown, codes: readonly string[], message: string): string[] {
  const list = raw ?? [];
  if (!Array.isArray(list) || list.some((c) => !codes.includes(c as string))) throw ApiError.validation(message);
  return codes.filter((c) => (list as unknown[]).includes(c));
}

/**
 * The "Dọn phòng" form, checked against the catalog: unknown items, types or
 * counts are refused (never silently dropped), and an empty form is a valid one.
 * Each linen item is ONE type and a count — never a list of types.
 */
export function parseCleaningForm(raw: unknown): CleaningForm {
  const input = (raw ?? {}) as { linen?: unknown; quantities?: unknown; replaced?: unknown; special?: unknown; note?: unknown };
  const linen: CleaningForm['linen'] = {};
  const linenCodes = LINEN_ITEMS.map((i) => i.code as string);
  for (const [code, entry] of Object.entries((input.linen ?? {}) as Record<string, unknown>)) {
    if (!linenCodes.includes(code)) throw ApiError.validation('Đồ vải không hợp lệ.');
    if (entry === null) continue;
    const { size, quantity } = (typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as { size?: unknown; quantity?: unknown };
    if (!SIZE_CODES.includes(size as string)) throw ApiError.validation('Chọn một loại đồ vải: King, Queen hoặc Twin.');
    if (!isCount(quantity)) throw ApiError.validation(`Số lượng phải là số nguyên từ 0 đến ${MAX_QUANTITY}.`);
    linen[code] = { size: size as string, quantity };
  }
  const quantities: Record<string, number> = {};
  const quantityCodes = QUANTITY_ITEMS.map((i) => i.code as string);
  for (const [code, value] of Object.entries((input.quantities ?? {}) as Record<string, unknown>)) {
    if (!quantityCodes.includes(code)) throw ApiError.validation('Vật dụng không hợp lệ.');
    if (!isCount(value)) throw ApiError.validation(`Số lượng phải là số nguyên từ 0 đến ${MAX_QUANTITY}.`);
    if (value > 0) quantities[code] = value;
  }
  const replaced = codesOf(input.replaced, REPLACEMENT_CODES, 'Đồ thay thế không hợp lệ.');
  const special = codesOf(input.special, SPECIAL_CODES, 'Ghi nhận đặc biệt không hợp lệ.');
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > 2000) throw ApiError.validation('Ghi chú quá dài.');
  return { linen, quantities, replaced, special, note };
}

/**
 * A saved form, read in today's shape — the stored record is never rewritten.
 * An older save reads as: a list of types → its first type, with no count; the
 * comb, cotton buds or shower cap → the one item they are part of now; no
 * "Ghi nhận đặc biệt" → none.
 */
export function readCleaning(raw: unknown): StoredCleaning | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const linen: StoredCleaning['linen'] = {};
  for (const [code, value] of Object.entries((r.linen ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const size = value.find((z) => SIZE_CODES.includes(z as string)) as string | undefined;
      if (size) linen[code] = { size, quantity: null };
    } else if (value && typeof value === 'object') {
      const { size, quantity } = value as { size?: unknown; quantity?: unknown };
      if (SIZE_CODES.includes(size as string)) linen[code] = { size: size as string, quantity: typeof quantity === 'number' ? quantity : null };
    }
  }
  const replaced = Array.isArray(r.replaced) ? (r.replaced as string[]).map((c) => LEGACY_REPLACEMENTS[c] ?? c) : [];
  const special = Array.isArray(r.special) ? (r.special as string[]) : [];
  return {
    linen,
    quantities: r.quantities && typeof r.quantities === 'object' ? (r.quantities as Record<string, number>) : {},
    replaced: REPLACEMENT_CODES.filter((c) => replaced.includes(c)),
    special: SPECIAL_CODES.filter((c) => special.includes(c)),
    note: typeof r.note === 'string' ? r.note : null,
    ...(typeof r.savedAt === 'string' ? { savedAt: r.savedAt } : {}),
    ...(typeof r.savedByUserId === 'number' ? { savedByUserId: r.savedByUserId } : {}),
    ...(typeof r.savedByName === 'string' ? { savedByName: r.savedByName } : {}),
  };
}

/** A room with nothing saved yet. */
export const EMPTY_CLEANING: StoredCleaning = { linen: {}, quantities: {}, replaced: [], special: [], note: null };

const labelOf = (list: readonly { code: string; label: string }[], code: string) => list.find((i) => i.code === code)?.label ?? code;

/** One saved form in words, for a report: every field the worker filled in, labelled. */
export function describeCleaning(c: StoredCleaning) {
  return {
    linen: LINEN_ITEMS.filter((i) => c.linen[i.code]).map((i) => {
      const e = c.linen[i.code]!;
      return { item: i.code, label: i.label, size: e.size, sizeLabel: labelOf(LINEN_SIZES, e.size), quantity: e.quantity };
    }),
    quantities: QUANTITY_ITEMS.filter((i) => c.quantities[i.code]).map((i) => ({ item: i.code, label: i.label, quantity: c.quantities[i.code]! })),
    replaced: c.replaced.map((code) => ({ code, label: labelOf(REPLACEMENT_ITEMS, code) })),
    special: c.special.map((code) => {
      const s = SPECIAL_STATUSES.find((x) => x.code === code)!;
      return { code, short: s.short, label: s.label };
    }),
    note: c.note,
  };
}
