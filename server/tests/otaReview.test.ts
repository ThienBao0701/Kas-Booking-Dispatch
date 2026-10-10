/**
 * The Admin review model for Agoda and CTrip.
 *
 * This is the layer that decides what an Admin sees, what they may correct and
 * whether the booking may be dispatched at all. Two properties matter most:
 *
 *   Room codes are resolved against the SELECTED BRANCH. The legacy Agoda regex
 *   table is branch-agnostic and would resolve a Standard room to STAN even at
 *   CN4, which has no STAN — producing a note carrying a code that branch does
 *   not have. Nothing here consults that table.
 *
 *   Admin corrections win. A parse never overwrites a value the Admin set.
 */
import { describe, expect, it } from 'vitest';
import { buildOtaReview, type OtaReviewBranch } from '../src/booking/otaReview';
import { normalizeText } from '../src/booking/text';
import { hcmDayMonthDots } from '../src/booking/otaPmsNote';

/** CTrip's second line is the creation day — today for a review built now. */
const CREATED = hcmDayMonthDots(new Date());

/** A branch with only the mappings it really has. */
function branch(
  id: number,
  code: string,
  address: string,
  rooms: { name: string; pms: string; id?: string }[],
  validPmsCodes: string[],
): OtaReviewBranch {
  return {
    id,
    code,
    address,
    mappings: rooms.map((r) => ({
      otaRoomName: r.name,
      normalizedOtaRoomName: normalizeText(r.name),
      otaRoomTypeId: r.id ?? null,
      pmsCode: r.pms,
    })),
    validPmsCodes,
  };
}

/** CN7 — the branch in the confirmed Agoda sample. */
const CN7 = branch(
  7,
  'BUI_THI_XUAN_13',
  '13 Bùi Thị Xuân',
  [
    { name: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ', pms: 'SUP', id: '912918580' },
    { name: 'Phòng Deluxe Có Giường Cỡ Queen Nhìn Ra Thành Phố', pms: 'DEL', id: '912918582' },
  ],
  ['STAN', 'SUP', 'DEL', 'DEBAL', 'KING', 'SUITE'],
);

/** CN5 — the branch in the confirmed CTrip sample. */
const CN5 = branch(
  5,
  'LE_THANH_TON_278',
  '278 Lê Thánh Tôn',
  [{ name: 'Standard Double Room No Window', pms: 'STAN' }],
  ['STAN', 'SUP', 'TWIN', 'DEL', 'STU', 'SUITE'],
);

/** CN4 — deliberately has NO Standard mapping and no STAN code. */
const CN4 = branch(
  4,
  'NGUYEN_THAI_BINH_170',
  '170-172-174 Nguyễn Thái Bình',
  [{ name: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ', pms: 'SUP', id: '1170978687' }],
  ['SUP', 'DEL12', 'DEL34', 'DD', 'DEBAL', 'SUITEBAL'],
);

const AGODA_PARSED = {
  bookingCode: '1756162808',
  guestName: 'XI SUN',
  checkIn: '2026-08-01',
  checkOut: '2026-08-05',
  rooms: [
    {
      quantity: 1,
      otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ',
      otaRoomTypeId: '912918580',
    },
  ],
  nightlyRates: [
    { stayDate: '2026-08-01', amount: 747_404 },
    { stayDate: '2026-08-02', amount: 635_292 },
    { stayDate: '2026-08-03', amount: 672_664 },
    { stayDate: '2026-08-04', amount: 672_664 },
  ],
  branchPrice: 2_728_024, // Net rate
  guestBookedPrice: 4_507_750, // Reference sell rate
  breakfastIncluded: false,
  resolvedBranchId: 7,
};

const CTRIP_PARSED = {
  bookingCode: '1658113703317875',
  guestName: 'LEE/JENSON HWEE',
  checkIn: '2026-08-01',
  checkOut: '2026-08-08',
  rooms: [{ quantity: 1, otaRoomName: 'Standard Double Room No Window', otaRoomTypeId: null }],
  nightlyRates: [], // CTrip states none
  branchPrice: 4_645_956, // Your payout
  guestBookedPrice: 6_637_080, // Original room rate
  breakfastIncluded: false,
  resolvedBranchId: 5,
};

const agoda = (over = {}, overrides = {}) =>
  buildOtaReview({
    source: 'AGODA',
    platform: 'AGODA',
    parsed: { ...AGODA_PARSED, ...over },
    branch: CN7,
    overrides,
  });

const ctrip = (over = {}, overrides = {}) =>
  buildOtaReview({
    source: 'CTRIP',
    platform: 'CTRIP',
    parsed: { ...CTRIP_PARSED, ...over },
    branch: CN5,
    overrides,
  });

/* ================================================================== */
/* Agoda through the review workflow                                   */
/* ================================================================== */

describe('Agoda review', () => {
  it('produces the exact CN note and allows dispatch', () => {
    const r = agoda();
    expect(r.note).toBe(
      'AGD 1756162808_1SUP_4DEM 2.728.024 CN\nGIÁ KHÁCH ĐẶT 4.507.750 KHONG AN SANG',
    );
    expect(r.canDispatch).toBe(true);
    expect(r.blockingReasons).toEqual([]);
  });

  it('produces the exact hotel-payment note, on one line', () => {
    const r = agoda({}, { paymentMode: 'HOTEL_PAYMENT' });
    expect(r.note).toBe('AGD 1756162808_1SUP_4DEM 2.728.024 THANH TOÁN TẠI KHÁCH SẠN');
    expect(r.note!.split('\n')).toHaveLength(1);
    expect(r.note).not.toContain('GIÁ KHÁCH ĐẶT');
    expect(r.note).not.toContain('KHONG AN SANG');
    expect(r.canDispatch).toBe(true);
  });

  it('uses Net rate as the branch price and Reference sell rate as the guest price', () => {
    const r = agoda();
    expect(r.branchPrice).toBe(2_728_024);
    expect(r.guestBookedPrice).toBe(4_507_750);
    expect(r.note).toContain('2.728.024 CN');
    expect(r.note).toContain('GIÁ KHÁCH ĐẶT 4.507.750');
  });

  it('keeps nightly Net rates because Agoda stated them', () => {
    const r = agoda();
    expect(r.nightlyRates.map((n) => n.amount)).toEqual([747_404, 635_292, 672_664, 672_664]);
    // …and they sum to the Net rate, so nothing was invented or dropped.
    expect(r.nightlyRates.reduce((s, n) => s + (n.amount ?? 0), 0)).toBe(2_728_024);
  });

  it('renders multiple room fragments without merging types', () => {
    const r = agoda(
      {},
      {
        bookingCode: '123456789',
        checkIn: '2026-08-01',
        checkOut: '2026-08-04',
        branchPrice: 6_500_000,
        guestBookedPrice: 8_200_000,
        rooms: [
          {
            quantity: 2,
            otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ',
            otaRoomTypeId: '912918580',
            pmsCode: null,
            requiresManualMapping: true,
          },
          {
            quantity: 1,
            otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Nhìn Ra Thành Phố',
            otaRoomTypeId: '912918582',
            pmsCode: null,
            requiresManualMapping: true,
          },
        ],
      },
    );
    expect(r.note).toBe(
      'AGD 123456789_2SUP_1DEL_3DEM 6.500.000 CN\nGIÁ KHÁCH ĐẶT 8.200.000 KHONG AN SANG',
    );
  });
});

/* ================================================================== */
/* CTrip through the review workflow                                   */
/* ================================================================== */

describe('CTrip review', () => {
  it('produces the exact CN note, with an underscore straight after CTRIP', () => {
    const r = ctrip();
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.note!.startsWith('CTRIP_')).toBe(true);
    expect(r.note!.startsWith('CTRIP ')).toBe(false);
    expect(r.canDispatch).toBe(true);
  });

  it('produces the exact hotel-payment note, on the same two lines', () => {
    // CTrip prints the creation day whichever way the guest pays.
    const r = ctrip({}, { paymentMode: 'HOTEL_PAYMENT' });
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN TẠI KHÁCH SẠN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.note!.split('\n')).toHaveLength(2);
  });

  it('keeps Your payout and Original room rate distinct', () => {
    const r = ctrip();
    expect(r.branchPrice).toBe(4_645_956);
    expect(r.guestBookedPrice).toBe(6_637_080);
  });

  it('fabricates no nightly rates', () => {
    const r = ctrip();
    expect(r.nightlyRates).toEqual([]);
    // 4.645.956 / 7 = 663.708 exactly — the tempting split.
    expect(JSON.stringify(r.nightlyRates)).not.toContain('663708');
  });

  it('requires a manual branch when CTrip stated no Property name', () => {
    const r = buildOtaReview({
      source: 'CTRIP',
      platform: 'CTRIP',
      parsed: { ...CTRIP_PARSED, resolvedBranchId: null },
      branch: null,
    });
    expect(r.requiresManualBranch).toBe(true);
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Chưa chọn chi nhánh.');
    expect(r.warnings.map((w) => w.code)).toContain('OTA_BRANCH_UNRESOLVED');
  });
});

/* ================================================================== */
/* Room mapping is branch-scoped                                       */
/* ================================================================== */

describe('room mapping', () => {
  it('CN4 leaves a Standard-like room unresolved and blocks dispatch', () => {
    const r = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: {
        ...AGODA_PARSED,
        resolvedBranchId: 4,
        rooms: [{ quantity: 1, otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ', otaRoomTypeId: null }],
      },
      branch: CN4,
    });
    expect(r.rooms[0]!.pmsCode).toBeNull();
    expect(r.rooms[0]!.requiresManualMapping).toBe(true);
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Còn hạng phòng chưa gán mã nội bộ.');
    expect(r.warnings.map((w) => w.code)).toContain('OTA_ROOM_MAPPING_UNRESOLVED');
    // Crucially it did NOT fall back to STAN, which CN4 does not have.
    expect(CN4.validPmsCodes).not.toContain('STAN');
    expect(r.note).toBeNull();
  });

  it('an Admin can correct an unresolved mapping, which unblocks dispatch', () => {
    const unresolved = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: {
        ...AGODA_PARSED,
        resolvedBranchId: 4,
        branchPrice: 1_000_000,
        guestBookedPrice: 1_500_000,
        rooms: [{ quantity: 1, otaRoomName: 'Phòng Lạ', otaRoomTypeId: null }],
      },
      branch: CN4,
    });
    expect(unresolved.canDispatch).toBe(false);

    const corrected = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: {
        ...AGODA_PARSED,
        resolvedBranchId: 4,
        branchPrice: 1_000_000,
        guestBookedPrice: 1_500_000,
        rooms: [{ quantity: 1, otaRoomName: 'Phòng Lạ', otaRoomTypeId: null }],
      },
      branch: CN4,
      overrides: {
        rooms: [
          {
            quantity: 1,
            otaRoomName: 'Phòng Lạ',
            otaRoomTypeId: null,
            pmsCode: 'DEL12',
            requiresManualMapping: false,
          },
        ],
      },
    });
    expect(corrected.rooms[0]!.pmsCode).toBe('DEL12');
    expect(corrected.canDispatch).toBe(true);
    expect(corrected.note).toContain('_1DEL12_4DEM');
  });

  it('rejects a manual code the selected branch does not have', () => {
    const r = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: { ...AGODA_PARSED, resolvedBranchId: 4 },
      branch: CN4,
      overrides: {
        rooms: [
          {
            quantity: 1,
            otaRoomName: 'Phòng Lạ',
            otaRoomTypeId: null,
            pmsCode: 'STAN', // CN4 has no STAN
            requiresManualMapping: false,
          },
        ],
      },
    });
    expect(r.rooms[0]!.requiresManualMapping).toBe(true);
    expect(r.canDispatch).toBe(false);
  });

  it('never uses another branch mapping', () => {
    // CN5's "Standard Double Room No Window" must not resolve at CN7.
    const r = buildOtaReview({
      source: 'CTRIP',
      platform: 'CTRIP',
      parsed: { ...CTRIP_PARSED, resolvedBranchId: 7 },
      branch: CN7,
    });
    expect(r.rooms[0]!.pmsCode).toBeNull();
    expect(r.canDispatch).toBe(false);
  });
});

/* ================================================================== */
/* Validation and Admin corrections                                    */
/* ================================================================== */

describe('validation', () => {
  it('names every missing field specifically, never generically', () => {
    const r = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: {
        bookingCode: null,
        guestName: null,
        checkIn: null,
        checkOut: null,
        rooms: [],
        nightlyRates: [],
        branchPrice: null,
        guestBookedPrice: null,
        breakfastIncluded: null,
        resolvedBranchId: null,
      },
      branch: null,
    });
    expect(r.canDispatch).toBe(false);
    for (const reason of [
      'Chưa chọn chi nhánh.',
      'Thiếu mã đặt phòng.',
      'Thiếu tên khách.',
      'Thiếu ngày nhận phòng.',
      'Thiếu ngày trả phòng.',
      'Chưa có dòng phòng nào.',
      'Thiếu giá chi nhánh.',
    ]) {
      expect(r.blockingReasons, reason).toContain(reason);
    }
  });

  it('requires the guest-booked price for CN but not for hotel payment', () => {
    const cn = agoda({ guestBookedPrice: null });
    expect(cn.canDispatch).toBe(false);
    expect(cn.blockingReasons.some((b) => b.includes('giá khách đặt'))).toBe(true);

    const hotel = agoda({ guestBookedPrice: null }, { paymentMode: 'HOTEL_PAYMENT' });
    expect(hotel.canDispatch).toBe(true);
    expect(hotel.note).toContain('THANH TOÁN TẠI KHÁCH SẠN');
  });

  it('never requires the guest-booked price for CTrip, in either mode', () => {
    // CTrip's note prints the creation day where that price used to sit, so
    // blocking a dispatch on it would be blocking on a figure nobody reads.
    for (const paymentMode of ['CN', 'HOTEL_PAYMENT'] as const) {
      const r = ctrip({ guestBookedPrice: null }, { paymentMode });
      expect(r.canDispatch, paymentMode).toBe(true);
      expect(r.blockingReasons, paymentMode).toEqual([]);
      expect(r.note, paymentMode).toContain(`\n${CREATED} KHONG AN SANG`);
    }
  });

  it('normalises a submitted breakfast=true to false instead of blocking', () => {
    // These eight branches serve no breakfast on Agoda or CTrip — a configured
    // business rule, so `true` cannot be right here. It is normalised rather
    // than refused: honouring it would block dispatch over note wording that
    // does not exist, and rejecting the request would strand an Admin who had
    // merely toggled the wrong box.
    const r = agoda({}, { breakfastIncluded: true });
    expect(r.breakfastIncluded).toBe(false);
    expect(r.warnings.map((w) => w.code)).not.toContain('OTA_BREAKFAST_TEXT_UNAPPROVED');
    expect(r.blockingReasons).not.toContain('Chưa có nội dung ghi chú cho đơn có ăn sáng.');
    expect(r.note).toContain('KHONG AN SANG');
  });

  it('rejects a zero or negative room quantity', () => {
    const r = agoda(
      {},
      {
        rooms: [
          {
            quantity: 0,
            otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ',
            otaRoomTypeId: null,
            pmsCode: 'SUP',
            requiresManualMapping: false,
          },
        ],
      },
    );
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Số lượng phòng không hợp lệ.');
  });
});

describe('Admin corrections are never overwritten', () => {
  it('honours edited code, guest, dates and prices', () => {
    const r = agoda(
      {},
      {
        bookingCode: 'EDITED123',
        guestName: 'Người Khác',
        branchPrice: 999_000,
        guestBookedPrice: 1_222_000,
      },
    );
    expect(r.bookingCode).toBe('EDITED123');
    expect(r.guestName).toBe('Người Khác');
    expect(r.branchPrice).toBe(999_000);
    expect(r.note).toContain('AGD EDITED123_1SUP_4DEM 999.000 CN');
    expect(r.note).toContain('GIÁ KHÁCH ĐẶT 1.222.000');
  });

  it('recomputes nights when the Admin edits the stay dates', () => {
    const r = agoda({}, { checkOut: '2026-08-08' });
    expect(r.nights).toBe(7);
    expect(r.note).toContain('_7DEM');
  });

  it('lets the Admin switch branch, which re-resolves the mapping', () => {
    // Selecting CN4 while the room is a CN7 Superior name that CN4 also has.
    const r = buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: AGODA_PARSED,
      branch: CN4,
      overrides: { branchId: 4 },
    });
    expect(r.branchId).toBe(4);
    expect(r.rooms[0]!.pmsCode).toBe('SUP'); // CN4 maps this name too
    expect(r.branchCode).toBe('NGUYEN_THAI_BINH_170');
  });
});
