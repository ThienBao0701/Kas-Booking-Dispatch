/**
 * THE DAILY ROOM WORK CATALOG — one source of truth for the board's room codes
 * and the "Dọn phòng" form, served to every screen (`GET /housekeeping/catalog`)
 * and validated here on every save.
 *
 * THE CODES AND ITEM NAMES ARE THE OPERATION'S OWN, kept exactly as given: the
 * board's rows (OUT, OC, CC, VC — OC and CC are both kept, neither is
 * reinterpreted), the bed-linen sizes K / Q / T, and the item names of the paper
 * housekeeping form. Nothing here defines what a code means; extending the form
 * is adding a line to a list.
 */
import { ApiError } from '../lib/errors';

/** The board's rows — the room's operational code for the day. */
export const ROOM_STATUS_CODES = ['OUT', 'OC', 'CC', 'VC'] as const;
export type RoomStatusCode = (typeof ROOM_STATUS_CODES)[number];

export const ROOM_WORK_STATE_LABELS = {
  NOT_STARTED: 'Chưa bắt đầu',
  IN_PROGRESS: 'Đang dọn',
  COMPLETED: 'Hoàn thành',
} as const;

/** Bed linen: each item takes any of the size codes K / Q / T. */
export const LINEN_ITEMS = [
  { code: 'BED_SHEET', label: 'Ga giường' },
  { code: 'DUVET_COVER', label: 'Bọc chăn' },
  { code: 'MATTRESS_PROTECTOR', label: 'Bảo vệ nệm' },
] as const;
export const LINEN_SIZES = ['K', 'Q', 'T'] as const;

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

/** "Đánh dấu nếu đồ được thay thế" — ✓ when replaced. */
export const REPLACEMENT_ITEMS = [
  { code: 'COMB', label: 'Lược' },
  { code: 'COTTON_BUDS', label: 'Tăm bông' },
  { code: 'SHOWER_CAP', label: 'Chụp tóc' },
  { code: 'TISSUE', label: 'Giấy ăn' },
  { code: 'HAND_WASH', label: 'Nước rửa tay' },
  { code: 'SHAMPOO', label: 'Dầu gội' },
  { code: 'SHOWER_GEL', label: 'Sữa tắm' },
] as const;

export const MAX_QUANTITY = 999;

export interface CleaningForm {
  /** Per linen item, the size codes ticked. */
  linen: Record<string, string[]>;
  /** Per counted item, how many (0 is left out). */
  quantities: Record<string, number>;
  /** The replacement items ticked ✓. */
  replaced: string[];
  note: string | null;
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
    maxQuantity: MAX_QUANTITY,
  };
}

export function assertStatusCode(raw: unknown): RoomStatusCode {
  if (typeof raw !== 'string' || !(ROOM_STATUS_CODES as readonly string[]).includes(raw)) {
    throw ApiError.validation('Tình trạng phòng không hợp lệ.');
  }
  return raw as RoomStatusCode;
}

/**
 * The "Dọn phòng" form, checked against the catalog: unknown items, sizes or
 * counts are refused (never silently dropped), and an empty form is a valid one.
 */
export function parseCleaningForm(raw: unknown): CleaningForm {
  const input = (raw ?? {}) as { linen?: unknown; quantities?: unknown; replaced?: unknown; note?: unknown };
  const linen: Record<string, string[]> = {};
  const linenCodes = LINEN_ITEMS.map((i) => i.code as string);
  for (const [code, sizes] of Object.entries((input.linen ?? {}) as Record<string, unknown>)) {
    if (!linenCodes.includes(code)) throw ApiError.validation('Đồ vải không hợp lệ.');
    if (!Array.isArray(sizes) || sizes.some((z) => !(LINEN_SIZES as readonly string[]).includes(z as string))) {
      throw ApiError.validation('Kích cỡ đồ vải không hợp lệ.');
    }
    const unique = [...new Set(sizes as string[])];
    if (unique.length > 0) linen[code] = LINEN_SIZES.filter((z) => unique.includes(z));
  }
  const quantities: Record<string, number> = {};
  const quantityCodes = QUANTITY_ITEMS.map((i) => i.code as string);
  for (const [code, value] of Object.entries((input.quantities ?? {}) as Record<string, unknown>)) {
    if (!quantityCodes.includes(code)) throw ApiError.validation('Vật dụng không hợp lệ.');
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) {
      throw ApiError.validation(`Số lượng phải là số nguyên từ 0 đến ${MAX_QUANTITY}.`);
    }
    if (value > 0) quantities[code] = value;
  }
  const replacementCodes = REPLACEMENT_ITEMS.map((i) => i.code as string);
  const replacedRaw = input.replaced ?? [];
  if (!Array.isArray(replacedRaw) || replacedRaw.some((c) => !replacementCodes.includes(c as string))) {
    throw ApiError.validation('Đồ thay thế không hợp lệ.');
  }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > 2000) throw ApiError.validation('Ghi chú quá dài.');
  return { linen, quantities, replaced: replacementCodes.filter((c) => (replacedRaw as string[]).includes(c)), note };
}
