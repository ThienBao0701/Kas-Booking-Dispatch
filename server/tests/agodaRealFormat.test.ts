/**
 * Agoda's REAL partner email, as it arrives after being copied out of a mail
 * client.
 *
 * The earlier fixtures were tidy. A real paste is not: labels come in bilingual
 * pairs, values land on the line below their label, a rate wraps mid-number,
 * and the reservation is surrounded by mail chrome, promotions, commission rows
 * and cancellation dates that all look like data.
 *
 * These tests pin the confirmed booking 1756192483 end to end, and each of the
 * individual reading rules underneath it. What they mostly guard against is
 * PLAUSIBLE misreadings — a promotion date taken as the check-in, the "(2)"
 * style marker taken as a room count, "2,012,236.0" + "0" read as 20,122,360 —
 * because those produce a confident, wrong note rather than a visible failure.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeOtaRoomName,
  parseAgodaPartnerBooking,
  resolveAgodaGuestName,
} from '../src/booking/agodaPartner';
import { parseAgodaBooking } from '../src/booking/agoda';
import { agodaParsedFields } from '../src/booking/otaReviewService';
import { buildOtaReview, type OtaReviewBranch } from '../src/booking/otaReview';
import { normalizeText } from '../src/booking/text';

const REAL = readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '07-real-bilingual-wrapped.txt'),
  'utf8',
);

const parsed = parseAgodaPartnerBooking(REAL);

/** A branch carrying only the mappings it really has. */
function branch(
  id: number,
  code: string,
  address: string,
  rooms: { name: string; pms: string }[],
  validPmsCodes: string[],
): OtaReviewBranch {
  return {
    id,
    code,
    address,
    mappings: rooms.map((r) => ({
      otaRoomName: r.name,
      normalizedOtaRoomName: normalizeText(r.name),
      otaRoomTypeId: null,
      pmsCode: r.pms,
    })),
    validPmsCodes,
  };
}

/** CN1 — the branch in the confirmed sample. */
const CN1 = branch(
  1,
  'TRUONG_DINH_05',
  '05 Trương Định',
  [
    { name: 'Standard Room', pms: 'STAN' },
    { name: 'Superior Room', pms: 'SUP' },
    { name: 'Deluxe Family Room', pms: 'DEFAM' },
  ],
  ['STAN', 'SUP', 'DEFAM'],
);

/** CN4 — has no Standard room and no STAN code at all. */
const CN4 = branch(
  4,
  'NGUYEN_THAI_BINH_170',
  '170 Nguyễn Thái Bình',
  [{ name: 'Superior Room', pms: 'SUP' }],
  ['SUP', 'DEL12', 'DEL34', 'DD', 'DEBAL', 'SUITEBAL'],
);

/** Runs the REAL production path from raw text to review. */
function review(rawText: string, on: OtaReviewBranch | null, overrides = {}) {
  const booking = parseAgodaBooking(rawText, []);
  return buildOtaReview({
    source: 'AGODA',
    platform: 'AGODA',
    parsed: { ...agodaParsedFields(booking, on?.id ?? null), resolvedBranchId: on?.id ?? null },
    branch: on,
    overrides,
  });
}

/** Builds a minimal partner email around the given body lines. */
function email(...body: string[]): string {
  return [
    'Booking Confirmation',
    'Reservation Information',
    'Booking ID',
    '1700000001',
    'Reference sell rate (incl. taxes & fees)',
    'VND 2,000,000.00',
    'Net rate (incl. taxes & fees)',
    'VND 1,000,000.00',
    ...body,
  ].join('\n');
}

/* ================================================================== */
/* Labels                                                              */
/* ================================================================== */
describe('Agoda labels', () => {
  it('reads a value under a bilingual label pair', () => {
    // "Booking ID | Mã số đặt phòng" — the Vietnamese label is a LABEL, not the
    // value. Before it was recognised, the booking id came out as "Mã số...".
    expect(parsed.bookingId).toBe('1756192483');
  });

  it('reads English-only labels', () => {
    const p = parseAgodaPartnerBooking(
      email('Customer First Name', 'ANNA', 'Customer Last Name', 'TRAN'),
    );
    expect(p.customerFullName).toBe('ANNA TRAN');
  });

  it('gives each label in a bilingual row its own column value', () => {
    // "Check-in | Check-out" over two dates must not hand both labels the first.
    expect(parsed.checkIn).toBe('2026-08-03');
    expect(parsed.checkOut).toBe('2026-08-05');
  });
});

/* ================================================================== */
/* Guest name                                                          */
/* ================================================================== */
describe('Agoda guest name', () => {
  it('joins a first name with a multi-word last name', () => {
    expect(resolveAgodaGuestName('Dat', 'Phan Trong', '[RmNo.1] Dat Phan Trong')).toBe(
      'Dat Phan Trong',
    );
  });

  it('reads an Other Guests entry that carries no "Guest of"', () => {
    expect(resolveAgodaGuestName('Khuyen', 'Nguyen', '[RmNo.1] Khuyen Nguyen')).toBe(
      'Khuyen Nguyen',
    );
  });

  it('strips "Guest of" and the room marker', () => {
    expect(
      resolveAgodaGuestName(
        'Khuyen',
        'Nguyen',
        '[RmNo.1] Khuyen Nguyen, [RmNo.1] Guest of Khuyen Nguyen',
      ),
    ).toBe('Khuyen Nguyen');
  });

  it('deduplicates repeated names case-insensitively', () => {
    // Same person written three ways; the FIRST spelling is the one kept.
    expect(resolveAgodaGuestName('THU UYEN', 'HO', 'THU UYEN HO, thu uyen ho, THU UYEN HO')).toBe(
      'THU UYEN HO',
    );
  });

  it('never lets a companion in Other Guests replace the primary customer', () => {
    // The occupant list routinely names a second traveller. The booking still
    // belongs to the customer, so the customer fields always win.
    expect(resolveAgodaGuestName('Anna', 'Tran', '[RmNo.1] Anna Tran, [RmNo.2] Bao Le')).toBe(
      'Anna Tran',
    );
    expect(resolveAgodaGuestName('Anna', 'Tran', '[RmNo.1] Bao Le')).toBe('Anna Tran');
  });

  it('falls back when there is no Other Guests block', () => {
    expect(resolveAgodaGuestName('Anna', 'Tran', null)).toBe('Anna Tran');
  });

  it('uses a single unambiguous occupant when there are no customer fields', () => {
    expect(resolveAgodaGuestName(null, null, '[RmNo.1] Guest of Bao Le, [RmNo.1] Bao Le')).toBe(
      'Bao Le',
    );
  });

  it('names nobody when there are no customer fields and the occupants differ', () => {
    // Guessing which of two people the booking is under is not the parser's call.
    expect(resolveAgodaGuestName(null, null, '[RmNo.1] Anna Tran, [RmNo.2] Bao Le')).toBeNull();
  });

  it('preserves accents, slashes and capitalisation', () => {
    expect(resolveAgodaGuestName('LEE/JENSON', 'HWEE', null)).toBe('LEE/JENSON HWEE');
    expect(resolveAgodaGuestName('Nguyễn', 'Thị Ánh', '[RmNo.1] Nguyễn Thị Ánh')).toBe(
      'Nguyễn Thị Ánh',
    );
  });

  it('reads the real email as one guest despite the "Guest of" duplicate', () => {
    expect(parsed.customerFullName).toBe('THU UYEN HO');
  });

  it('keeps a surname that looks like the Vietnamese label "Họ"', () => {
    // "Họ" is the surname LABEL and folds to "ho" — exactly how the surname HO
    // is written. Treating the folded form as a label silently truncated every
    // such guest: the confirmed booking's THU UYEN HO became THU UYEN.
    expect(parsed.customerLastName).toBe('HO');
    expect(parsed.customerFullName).toBe('THU UYEN HO');
  });
});

/* ================================================================== */
/* Dates                                                               */
/* ================================================================== */
describe('Agoda dates', () => {
  it('prefers the parenthesised numeric date', () => {
    const p = parseAgodaPartnerBooking(
      email('Check-in', '6-Aug-2026 (6-08-2026)', 'Check-out', '9-Aug-2026 (9-08-2026)'),
    );
    expect(p.checkIn).toBe('2026-08-06');
    expect(p.checkOut).toBe('2026-08-09');
    expect(p.nights).toBe(3);
  });

  it('reads a full English month name', () => {
    const p = parseAgodaPartnerBooking(
      email('Check-in', 'August 2, 2026', 'Check-out', 'August 3, 2026'),
    );
    expect(p.checkIn).toBe('2026-08-02');
    expect(p.checkOut).toBe('2026-08-03');
    expect(p.nights).toBe(1);
  });

  it.each([
    ['Jan', '2026-01-05'],
    ['January', '2026-01-05'],
    ['Feb', '2026-02-05'],
    ['Mar', '2026-03-05'],
    ['Apr', '2026-04-05'],
    ['May', '2026-05-05'],
    ['Jun', '2026-06-05'],
    ['Jul', '2026-07-05'],
    ['Aug', '2026-08-05'],
    ['Sep', '2026-09-05'],
    ['Sept', '2026-09-05'],
    ['September', '2026-09-05'],
    ['Oct', '2026-10-05'],
    ['Nov', '2026-11-05'],
    ['December', '2026-12-05'],
  ])('reads the month abbreviation %s', (month, expected) => {
    const p = parseAgodaPartnerBooking(email('Check-in', `5-${month}-2026`));
    expect(p.checkIn).toBe(expected);
  });

  it('counts nights as check-out minus check-in', () => {
    expect(parsed.checkIn).toBe('2026-08-03');
    expect(parsed.checkOut).toBe('2026-08-05');
    expect(parsed.nights).toBe(2);
  });

  it('ignores promotion and cancellation dates', () => {
    // The fixture carries "before August 30, 2026" and two cancellation dates in
    // the same numeric shape as a real check-in.
    expect(REAL).toContain('August 30, 2026');
    expect(REAL).toContain('30-Jun-2026 (30-06-2026)');
    expect(parsed.checkIn).toBe('2026-08-03');
    expect(parsed.checkOut).toBe('2026-08-05');
  });

  it('warns when the words and the numbers state different days', () => {
    const p = parseAgodaPartnerBooking(email('Check-in', '7-Aug-2026 (8-08-2026)'));
    expect(p.warnings.map((w) => w.code)).toContain('AGODA_DATE_FORMS_DISAGREE');
  });
});

/* ================================================================== */
/* Room row                                                            */
/* ================================================================== */
describe('Agoda room row', () => {
  it.each([
    ['Standard Room (2)', 'Standard Room'],
    ['Standard (0)', 'Standard'],
    ['Superior Room (2)', 'Superior Room'],
    ['Deluxe Room', 'Deluxe Room'],
    ['Superior Double Room', 'Superior Double Room'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeOtaRoomName(raw)).toBe(expected);
  });

  it('keeps parentheses that are part of the name', () => {
    // Only a TRAILING numeric marker goes; a genuine qualifier stays.
    expect(normalizeOtaRoomName('Phòng Superior Có Cửa Sổ (Giường Queen)')).toBe(
      'Phòng Superior Có Cửa Sổ (Giường Queen)',
    );
  });

  it('preserves the raw name for audit alongside the normalised one', () => {
    expect(parsed.roomTypeOriginal).toBe('Superior Room (2)');
    expect(parsed.roomTypeNormalized).toBe('Superior Room');
  });

  it('takes the quantity from No. of Rooms, not the style marker', () => {
    // "Superior Room (2)" with No. of Rooms = 2 is a coincidence in this sample;
    // the marker is never the source of the count.
    expect(parsed.roomQuantity).toBe(2);
  });

  it('does not read the (0) marker as a quantity', () => {
    const p = parseAgodaPartnerBooking(
      email('Room Type\tNo. of Rooms\tOccupancy\tNo. of Extra Bed', 'Standard (0)\t1\t2 Adults\t0'),
    );
    expect(p.roomTypeNormalized).toBe('Standard');
    expect(p.roomQuantity).toBe(1);
  });

  it('does not use occupancy as the room quantity', () => {
    expect(parsed.occupancy).toBe('4 Adults');
    expect(parsed.roomQuantity).toBe(2);
  });

  it('does not use the extra-bed count as the room quantity', () => {
    const p = parseAgodaPartnerBooking(
      email('Room Type\tNo. of Rooms\tOccupancy\tNo. of Extra Bed', 'Superior Room\t1\t3 Adults\t2'),
    );
    expect(p.roomQuantity).toBe(1);
    expect(p.extraBeds).toBe(2);
  });
});

/* ================================================================== */
/* Money                                                               */
/* ================================================================== */
describe('Agoda money', () => {
  it('rejoins a Net rate wrapped mid-number', () => {
    // "VND" / "2,012,236.0" / "0" — reading the middle line alone gives
    // 20,122,360, ten times the truth, and it would be pasted into the PMS.
    expect(parsed.netRate).toBe(2_012_236);
  });

  it('rejoins a Reference sell rate wrapped mid-number', () => {
    expect(parsed.referenceSellRate).toBe(3_325_000);
  });

  it('ignores Commission', () => {
    expect(REAL).toContain('VND 465,000.00');
    expect(parsed.netRate).not.toBe(465_000);
    expect(parsed.referenceSellRate).not.toBe(465_000);
  });

  it('ignores targeted and non-targeted promotions', () => {
    expect(REAL).toContain('Non-Targeted promotions');
    expect(parsed.netRate).not.toBe(120_000);
  });

  it('ignores withholding tax, tax on commission and compensation', () => {
    for (const amount of [23_250, 46_500, 0]) {
      expect(parsed.netRate).not.toBe(amount);
      expect(parsed.referenceSellRate).not.toBe(amount);
    }
  });

  it('never glues two separate amounts together', () => {
    // The sell rate is followed by the net rate; each stops at the other label.
    expect(parsed.referenceSellRate).toBe(3_325_000);
    expect(parsed.netRate).toBe(2_012_236);
  });
});

/* ================================================================== */
/* Nightly rates                                                       */
/* ================================================================== */
describe('Agoda nightly rates', () => {
  it('keeps the source nightly total exactly as stated', () => {
    expect(parsed.nightlyRates.map((n) => [n.stayDate, n.amount])).toEqual([
      ['2026-08-03', 1_006_118],
      ['2026-08-04', 1_006_118],
    ]);
  });

  it('derives the per-room nightly rate by dividing by the room count', () => {
    // 1,006,118 covers both rooms; one room is 503,059 a night.
    expect(parsed.nightlyRates.map((n) => n.perRoomAmount)).toEqual([503_059, 503_059]);
  });

  it('does not divide the Net rate', () => {
    // The booking total stays whole even though there are two rooms.
    expect(parsed.netRate).toBe(2_012_236);
    expect(parsed.netRate).not.toBe(1_006_118);
  });

  it('leaves the per-room share null when the split is not exact', () => {
    // A rounded share would not add back to the stated total.
    const p = parseAgodaPartnerBooking(
      email(
        'Room Type\tNo. of Rooms\tOccupancy\tNo. of Extra Bed',
        'Superior Room\t3\t2 Adults\t0',
        'Rates',
        'August 3, 2026\tVND 1,000,000.00',
      ),
    );
    expect(p.nightlyRates[0]?.amount).toBe(1_000_000);
    expect(p.nightlyRates[0]?.perRoomAmount).toBeNull();
  });

  it('invents no nightly rows when the email states none', () => {
    const p = parseAgodaPartnerBooking(email('Check-in', '3-Aug-2026', 'Check-out', '5-Aug-2026'));
    expect(p.nightlyRates).toEqual([]);
  });
});

/* ================================================================== */
/* Breakfast                                                           */
/* ================================================================== */
describe('Agoda breakfast', () => {
  it('is always false, whatever the benefits say', () => {
    expect(REAL).toContain('Coffee & tea');
    expect(parsed.breakfastIncluded).toBe(false);
  });

  it('stays false even when the word breakfast appears in unrelated text', () => {
    const p = parseAgodaPartnerBooking(
      email('Rate Plan Name', 'Room only — breakfast available for purchase'),
    );
    expect(p.breakfastIncluded).toBe(false);
  });
});

/* ================================================================== */
/* Branch-scoped mapping                                               */
/* ================================================================== */
describe('Agoda room mapping is branch-scoped', () => {
  it('resolves the alias at the branch that has it', () => {
    const r = review(REAL, CN1);
    expect(r.rooms[0]?.otaRoomName).toBe('Superior Room');
    expect(r.rooms[0]?.pmsCode).toBe('SUP');
    expect(r.rooms[0]?.requiresManualMapping).toBe(false);
  });

  it('does not let one branch’s alias resolve at another', () => {
    // CN4 has no Deluxe Family Room; CN1 does. The name alone decides nothing.
    const r = review(
      email('Room Type\tNo. of Rooms', 'Deluxe Family Room\t1'),
      CN4,
    );
    expect(r.rooms[0]?.pmsCode).toBeNull();
    expect(r.rooms[0]?.requiresManualMapping).toBe(true);
  });

  it('leaves a Standard room unresolved at CN4, which has no STAN', () => {
    const r = review(email('Room Type\tNo. of Rooms', 'Standard Room\t1'), CN4);
    expect(r.rooms[0]?.pmsCode).toBeNull();
    expect(r.rooms[0]?.requiresManualMapping).toBe(true);
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Còn hạng phòng chưa gán mã nội bộ.');
  });

  it('resolves nothing at all before a branch is chosen', () => {
    const r = review(REAL, null);
    expect(r.rooms[0]?.pmsCode).toBeNull();
    expect(r.requiresManualBranch).toBe(true);
  });
});

/* ================================================================== */
/* The confirmed booking, end to end                                   */
/* ================================================================== */
describe('confirmed Agoda booking 1756192483', () => {
  it('produces the exact CN note', () => {
    const r = review(REAL, CN1, { paymentMode: 'CN' });
    expect(r.note).toBe(
      'AGD 1756192483_2SUP_2DEM 2.012.236 CN\nGIÁ KHÁCH ĐẶT 3.325.000 KHONG AN SANG',
    );
    expect(r.canDispatch).toBe(true);
  });

  it('produces the exact hotel-payment note', () => {
    const r = review(REAL, CN1, { paymentMode: 'HOTEL_PAYMENT' });
    expect(r.note).toBe('AGD 1756192483_2SUP_2DEM 2.012.236 THANH TOÁN TẠI KHÁCH SẠN');
    expect(r.canDispatch).toBe(true);
  });

  it('reviews every field the Admin screen needs', () => {
    const r = review(REAL, CN1);
    expect(r).toMatchObject({
      source: 'AGODA',
      branchCode: 'TRUONG_DINH_05',
      bookingCode: '1756192483',
      guestName: 'THU UYEN HO',
      checkIn: '2026-08-03',
      checkOut: '2026-08-05',
      nights: 2,
      branchPrice: 2_012_236,
      guestBookedPrice: 3_325_000,
      breakfastIncluded: false,
      requiresManualBranch: false,
    });
    expect(r.rooms).toEqual([
      {
        quantity: 2,
        otaRoomName: 'Superior Room',
        // The raw name keeps Agoda's "(2)" style marker for audit.
        rawOtaRoomName: 'Superior Room (2)',
        otaRoomTypeId: null,
        pmsCode: 'SUP',
        requiresManualMapping: false,
        // 1,006,118 a night covers both rooms; 503,059 is one room's share.
        sourceNightlyTotal: 1_006_118,
        perRoomNightlyRate: 503_059,
      },
    ]);
  });

  it('raises no false missing-field warnings', () => {
    const r = review(REAL, CN1);
    expect(r.warnings).toEqual([]);
    expect(r.blockingReasons).toEqual([]);
    expect(r.noteError).toBeNull();
  });

  it('blocks only on the payment mode before the Admin has chosen one', () => {
    // Payment mode defaults to CN and is always the Admin's explicit choice;
    // nothing else about this booking is outstanding.
    const r = review(REAL, CN1);
    expect(r.canDispatch).toBe(true);
    expect(r.paymentMode).toBe('CN');
  });
});
