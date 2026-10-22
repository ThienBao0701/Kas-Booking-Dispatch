/**
 * The Admin review model for an Agoda or CTrip reservation.
 *
 * One shape serves both platforms and the UI edits it directly, so the review
 * screen, the validation and the generated note all read the same fields. The
 * server owns this rather than the client because the note is a string contract
 * the hotel PMS depends on, and because `canDispatch` must not be something a
 * browser can talk itself into.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *  - It never invents a PMS code. A room whose OTA name is not mapped for the
 *    SELECTED BRANCH stays unresolved and blocks dispatch. The legacy
 *    `mapAgodaRoomCode` regex table is branch-agnostic — it would resolve a
 *    Standard room to STAN even at CN4, which has no STAN — so the operational
 *    path resolves through `BranchOtaRoomMapping` instead.
 *  - It never derives a nightly price. Rates are carried only when the platform
 *    actually stated them.
 *  - It never overwrites an Admin correction: overrides win over parsed values.
 */
import type { OtaPlatform } from '@prisma/client';
import { buildOtaPmsNote, type OtaNoteSource, type OtaPaymentMode } from './otaPmsNote';
import {
  resolveOtaRoomCode,
  type OtaRoomMappingConfig,
} from '../room/otaRoomMappingResolver';

/** One physical room group on the reservation. */
export interface OtaReviewRoomLine {
  quantity: number;
  /** The name used for MAPPING — normalised, with any "(2)" marker removed. */
  otaRoomName: string | null;
  /** The name exactly as the platform printed it, for audit and recognition. */
  rawOtaRoomName?: string | null;
  /** The platform's room-type id when it supplied one (Agoda does). */
  otaRoomTypeId: string | null;
  /** The branch's internal code — resolved, or chosen by the Admin. */
  pmsCode: string | null;
  /** True while no code is resolved; blocks dispatch. */
  requiresManualMapping: boolean;
  /**
   * The nightly figure the SOURCE stated, when it stated one consistent rate
   * for every night. It covers all rooms on the line. Null when the platform
   * gave no nightly rows, or gave rows that differ from night to night — the
   * per-date detail is in `nightlyRates` either way, and no single figure is
   * invented to stand in for a varying rate.
   */
  sourceNightlyTotal?: number | null;
  /** `sourceNightlyTotal` divided by the room count, when that is exact. */
  perRoomNightlyRate?: number | null;
}

/** A price the platform stated per night. Empty when it stated none. */
export interface OtaReviewNightly {
  stayDate: string;
  /** Exactly as the platform stated it — may cover every room that night. */
  amount: number | null;
  /** An exact per-room share, for display only. Null when there isn't one. */
  perRoomAmount?: number | null;
}

export interface OtaReviewWarning {
  code: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
}

export interface OtaReview {
  source: OtaNoteSource;
  branchId: number | null;
  branchCode: string | null;
  branchAddress: string | null;
  /** True until an Admin has confirmed a branch; blocks dispatch. */
  requiresManualBranch: boolean;
  bookingCode: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  rooms: OtaReviewRoomLine[];
  /** Only ever what the platform stated. Never payout ÷ nights. */
  nightlyRates: OtaReviewNightly[];
  /** Agoda: Net rate. CTrip: Your payout. */
  branchPrice: number | null;
  /** Agoda: Reference sell rate. CTrip: Original room rate. */
  guestBookedPrice: number | null;
  breakfastIncluded: boolean | null;
  paymentMode: OtaPaymentMode;
  /** The exact note, or null when it cannot be generated yet. */
  note: string | null;
  /** Why the note could not be generated, in Vietnamese. */
  noteError: string | null;
  warnings: OtaReviewWarning[];
  /** False while any critical field is missing or unresolved. */
  canDispatch: boolean;
  /** Specific reasons, so the UI never shows a generic "invalid". */
  blockingReasons: string[];
}

/** The Admin's corrections. Every field is optional; each one wins when set. */
export interface OtaReviewOverrides {
  branchId?: number | null;
  bookingCode?: string | null;
  guestName?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  rooms?: OtaReviewRoomLine[];
  branchPrice?: number | null;
  guestBookedPrice?: number | null;
  breakfastIncluded?: boolean | null;
  paymentMode?: OtaPaymentMode;
}

/**
 * Breakfast for Agoda and CTrip at these eight branches: never included.
 * Operator-confirmed configuration, deliberately not inferred from the text.
 */
export const OTA_BREAKFAST_INCLUDED = false;

/**
 * The review model's own version, stamped onto every dispatched booking.
 *
 * Recorded beside `parserVersion` so a booking can be traced to the review
 * RULES that produced it, not only to the extraction that fed them.
 */
export const OTA_REVIEW_VERSION = 'ota-review-1.0.0';

/** Whole nights between two ISO dates, or null. */
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The branch context the review needs, loaded once by the caller. */
export interface OtaReviewBranch {
  id: number;
  code: string;
  address: string;
  /** Mappings for THIS branch on THIS platform only. */
  mappings: readonly OtaRoomMappingConfig[];
  /** Valid internal codes for the manual selector. */
  validPmsCodes: readonly string[];
}

export interface BuildOtaReviewInput {
  source: OtaNoteSource;
  platform: OtaPlatform;
  /** Values read from the pasted text. */
  parsed: {
    bookingCode: string | null;
    guestName: string | null;
    checkIn: string | null;
    checkOut: string | null;
    rooms: {
      quantity: number;
      otaRoomName: string | null;
      rawOtaRoomName?: string | null;
      otaRoomTypeId: string | null;
      sourceNightlyTotal?: number | null;
      perRoomNightlyRate?: number | null;
    }[];
    nightlyRates: OtaReviewNightly[];
    branchPrice: number | null;
    guestBookedPrice: number | null;
    breakfastIncluded: boolean | null;
    /**
     * Warnings raised by the PARSER that the Admin must see — most importantly,
     * that the paste held several distinct reservations and which one was used.
     *
     * The review derives everything else itself and cannot see what the parser
     * had to choose between, so these are carried through rather than
     * recomputed. They are surfaced, not blocking: the review's own checks
     * decide dispatch.
     */
    parserWarnings?: OtaReviewWarning[];
    /** Non-null only when the platform name resolved EXACTLY to a branch. */
    resolvedBranchId: number | null;
  };
  /** The branch currently in effect (resolved or Admin-selected), with mappings. */
  branch: OtaReviewBranch | null;
  overrides?: OtaReviewOverrides;
}

/**
 * Assembles the review, resolves each room line against the selected branch,
 * generates the note and computes exactly why dispatch is or is not allowed.
 */
export function buildOtaReview(input: BuildOtaReviewInput): OtaReview {
  const o = input.overrides ?? {};
  const warnings: OtaReviewWarning[] = [...(input.parsed.parserWarnings ?? [])];

  const bookingCode = o.bookingCode !== undefined ? o.bookingCode : input.parsed.bookingCode;
  const guestName = o.guestName !== undefined ? o.guestName : input.parsed.guestName;
  const checkIn = o.checkIn !== undefined ? o.checkIn : input.parsed.checkIn;
  const checkOut = o.checkOut !== undefined ? o.checkOut : input.parsed.checkOut;
  const nights = nightsBetween(checkIn, checkOut);

  // A branch is only "resolved" when the platform name matched exactly. An
  // Admin selection also counts — that IS the explicit confirmation.
  const branchId = o.branchId !== undefined ? o.branchId : input.parsed.resolvedBranchId;
  const branch = input.branch && input.branch.id === branchId ? input.branch : null;
  const requiresManualBranch = branchId == null;

  if (requiresManualBranch) {
    warnings.push({
      code: 'OTA_BRANCH_UNRESOLVED',
      message: 'Chưa xác định được chi nhánh. Vui lòng chọn chi nhánh thủ công.',
      severity: 'ERROR',
    });
  }

  // Room lines: an override replaces the parsed set entirely, so removing a row
  // actually removes it. Each line's code is resolved against the SELECTED
  // branch — never a regex table, never another branch's mapping.
  const sourceRooms =
    o.rooms !== undefined
      ? o.rooms
      : input.parsed.rooms.map((r) => ({
          quantity: r.quantity,
          otaRoomName: r.otaRoomName,
          rawOtaRoomName: r.rawOtaRoomName ?? r.otaRoomName,
          otaRoomTypeId: r.otaRoomTypeId,
          sourceNightlyTotal: r.sourceNightlyTotal ?? null,
          perRoomNightlyRate: r.perRoomNightlyRate ?? null,
          pmsCode: null,
          requiresManualMapping: true,
        }));

  const rooms: OtaReviewRoomLine[] = sourceRooms.map((line) => {
    // An Admin-chosen code is honoured, provided it is valid for this branch.
    //
    // An invalid code is DISCARDED, not merely flagged. Leaving it on the line
    // would let the note builder emit a PMS code the branch does not have — and
    // that note is copied straight into the hotel system. With no branch
    // selected there is nothing to validate against, so the code is not trusted
    // either.
    if (line.pmsCode) {
      const valid = branch !== null && branch.validPmsCodes.includes(line.pmsCode);
      return {
        ...line,
        pmsCode: valid ? line.pmsCode : null,
        requiresManualMapping: !valid,
      };
    }
    if (!branch) {
      return { ...line, pmsCode: null, requiresManualMapping: true };
    }
    // Spread, never rebuild field by field: listing the fields explicitly meant
    // every value added to a room line was silently dropped the moment the line
    // resolved, which is how correctly parsed data disappears between layers.
    const resolved = resolveOtaRoomCode(line.otaRoomName, branch.mappings);
    return {
      ...line,
      pmsCode: resolved.pmsCode,
      requiresManualMapping: resolved.pmsCode === null,
    };
  });

  for (const line of rooms) {
    if (line.requiresManualMapping) {
      warnings.push({
        code: 'OTA_ROOM_MAPPING_UNRESOLVED',
        message: line.otaRoomName
          ? `Chưa có hạng phòng nội bộ cho "${line.otaRoomName}" tại chi nhánh này. Vui lòng chọn thủ công.`
          : 'Chưa xác định được hạng phòng nội bộ. Vui lòng chọn thủ công.',
        severity: 'ERROR',
      });
    }
  }

  const branchPrice = o.branchPrice !== undefined ? o.branchPrice : input.parsed.branchPrice;
  const guestBookedPrice =
    o.guestBookedPrice !== undefined ? o.guestBookedPrice : input.parsed.guestBookedPrice;
  // Breakfast is a CONFIGURED business rule for these eight branches, not a
  // parsed field and not an Admin choice: Agoda and CTrip stays include no
  // breakfast, so every note ends "KHONG AN SANG".
  //
  // A submitted `true` is normalised to false rather than refused. This review
  // serves only Agoda and CTrip, so `true` cannot be correct here; honouring it
  // would block dispatch over a note wording that does not exist, and rejecting
  // the whole request would strand an Admin who merely toggled the wrong box.
  const breakfastIncluded = OTA_BREAKFAST_INCLUDED;
  const paymentMode: OtaPaymentMode = o.paymentMode ?? 'CN';

  const note = buildOtaPmsNote({
    source: input.source,
    bookingCode,
    rooms: rooms.map((r) => ({ quantity: r.quantity, pmsCode: r.pmsCode })),
    nights,
    branchPrice,
    guestBookedPrice,
    paymentMode,
    breakfastIncluded,
  });

  // Specific reasons, never a generic "invalid".
  const blockingReasons: string[] = [];
  if (requiresManualBranch) blockingReasons.push('Chưa chọn chi nhánh.');
  if (!bookingCode || bookingCode.trim().length === 0) blockingReasons.push('Thiếu mã đặt phòng.');
  if (!guestName || guestName.trim().length === 0) blockingReasons.push('Thiếu tên khách.');
  if (!checkIn) blockingReasons.push('Thiếu ngày nhận phòng.');
  if (!checkOut) blockingReasons.push('Thiếu ngày trả phòng.');
  if (nights == null || nights <= 0) blockingReasons.push('Số đêm không hợp lệ.');
  if (rooms.length === 0) blockingReasons.push('Chưa có dòng phòng nào.');
  if (rooms.some((r) => !Number.isInteger(r.quantity) || r.quantity <= 0)) {
    blockingReasons.push('Số lượng phòng không hợp lệ.');
  }
  if (rooms.some((r) => r.requiresManualMapping)) {
    blockingReasons.push('Còn hạng phòng chưa gán mã nội bộ.');
  }
  if (branchPrice == null) blockingReasons.push('Thiếu giá chi nhánh.');
  // Agoda only: its CN note prints GIÁ KHÁCH ĐẶT, so the figure is required to
  // build one. CTrip's note prints the creation date in that position and never
  // reads the guest-booked price, so demanding it would block a dispatch over a
  // number that appears nowhere on the note.
  if (input.source === 'AGODA' && paymentMode === 'CN' && guestBookedPrice == null) {
    blockingReasons.push('Thiếu giá khách đặt (bắt buộc khi thanh toán CN).');
  }
  if (!note.ok) blockingReasons.push(note.error);

  return {
    source: input.source,
    branchId: branchId ?? null,
    branchCode: branch?.code ?? null,
    branchAddress: branch?.address ?? null,
    requiresManualBranch,
    bookingCode,
    guestName,
    checkIn,
    checkOut,
    nights,
    rooms,
    // Carried through untouched — never generated.
    nightlyRates: input.parsed.nightlyRates,
    branchPrice,
    guestBookedPrice,
    breakfastIncluded,
    paymentMode,
    note: note.ok ? note.text : null,
    noteError: note.ok ? null : note.error,
    warnings,
    canDispatch: blockingReasons.length === 0,
    blockingReasons,
  };
}
