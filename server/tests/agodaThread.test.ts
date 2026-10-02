/**
 * Agoda mail THREADS, and the bilingual table layout the real emails use.
 *
 * A real Agoda mail is opened in Gmail as a thread, so copying it yields every
 * message in that thread — the supplied amended mail carried SIX complete
 * reservations, each with its own booking id, property, guest, dates, room row
 * and rates.
 *
 * Reading fields from the whole document did not fail loudly. It blended them:
 * the first block's booking id, a later block's guest, and the last block's
 * prices, assembled into one confident reservation that never existed. These
 * tests pin the scoping that prevents that, and the bilingual layouts that made
 * the correct blocks unreadable in the first place.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgodaPartnerBooking, reservationBlock } from '../src/booking/agodaPartner';
import { parseAgodaBooking } from '../src/booking/agoda';
import { agodaParsedFields } from '../src/booking/otaReviewService';
import { buildOtaReview, type OtaReviewBranch } from '../src/booking/otaReview';
import { normalizeText } from '../src/booking/text';

const THREAD = readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '09-amended-thread-two-bookings.txt'),
  'utf8',
);

const parsed = parseAgodaPartnerBooking(THREAD);

/** CN8 — the branch of the amended booking. */
const CN8: OtaReviewBranch = {
  id: 8,
  code: 'LE_THANH_TON_191',
  address: '191 Lê Thánh Tôn',
  mappings: [{ otaRoomName: 'Standard Room', pmsCode: 'STAN' }].map((m) => ({
    otaRoomName: m.otaRoomName,
    normalizedOtaRoomName: normalizeText(m.otaRoomName),
    otaRoomTypeId: null,
    pmsCode: m.pmsCode,
  })),
  validPmsCodes: ['STAN', 'SUP', 'DEL', 'KING', 'DEBAL', 'KINGBAL'],
};

/* ================================================================== */
/* Thread scoping                                                      */
/* ================================================================== */
describe('a mail thread is narrowed to one reservation', () => {
  it('the fixture really does carry two complete reservations', () => {
    // Guards the test itself: if the fixture stopped being a thread, the
    // scoping below would pass for the wrong reason.
    expect(THREAD.match(/Reservation Information/g)).toHaveLength(2);
    expect(THREAD).toContain('1753732591');
    expect(THREAD).toContain('1700000002');
  });

  it('picks the block the subject line names and excludes the other', () => {
    const block = reservationBlock(THREAD.split('\n')).join('\n');
    expect(block).toContain('1753732591');
    expect(block).toContain('KAS Dilly Hotel');
    // Not one line of the second reservation.
    expect(block).not.toContain('1700000002');
    expect(block).not.toContain('KAS Zody Boutique Hotel');
    expect(block).not.toContain('Linh');
  });

  it('keeps the header above the first reservation', () => {
    // Some layouts print the property name ABOVE the Booking ID label, so the
    // first block keeps what precedes it — losing that left the branch
    // unresolved on documents that had always worked.
    const block = reservationBlock(THREAD.split('\n'));
    expect(block.some((l) => l.includes('KAS Dilly Hotel'))).toBe(true);
    expect(parseAgodaPartnerBooking(THREAD).sourceHotelName).toBe('KAS Dilly Hotel');
  });

  it('takes every field from that one block, never a neighbour', () => {
    expect(parsed.bookingId).toBe('1753732591');
    expect(parsed.sourceHotelName).toBe('KAS Dilly Hotel');
    expect(parsed.customerFullName).toBe('Mai Tran');
    expect(parsed.checkIn).toBe('2026-08-06');
    expect(parsed.checkOut).toBe('2026-08-09');
    expect(parsed.roomTypeNormalized).toBe('Standard Room');
    expect(parsed.netRate).toBe(3_688_138);
    expect(parsed.referenceSellRate).toBe(5_156_900);

    // Not one value from the second reservation.
    expect(parsed.customerFullName).not.toBe('Linh Pham');
    expect(parsed.netRate).not.toBe(1_800_000);
    expect(parsed.referenceSellRate).not.toBe(2_400_000);
    expect(parsed.roomQuantity).not.toBe(2);
  });

  it('collects nightly rows from that block only', () => {
    // Before scoping these merged across every reservation in the thread.
    expect(parsed.nightlyRates.map((n) => n.stayDate)).toEqual([
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ]);
    expect(parsed.nightlyRates.every((n) => !n.stayDate.startsWith('2026-09'))).toBe(true);
  });

  it('treats an Amended confirmation exactly like a Booking Confirmation', () => {
    expect(THREAD).toContain('Agoda Amended Booking Confirmation');
    expect(parsed.warnings.filter((w) => w.severity === 'ERROR')).toEqual([]);
  });

  it('falls back to the first block when no subject id is present', () => {
    const noSubject = THREAD.split('\n').slice(6).join('\n');
    expect(parseAgodaPartnerBooking(noSubject).bookingId).toBe('1753732591');
  });

  it('leaves a single-reservation document untouched', () => {
    const single = ['Booking ID', 'Mã số đặt phòng', '1700000009'].join('\n');
    expect(reservationBlock(single.split('\n')).join('\n')).toContain('1700000009');
  });
});

/* ================================================================== */
/* The bilingual table layout                                          */
/* ================================================================== */
describe('bilingual labels with the value in the next cell', () => {
  it('reads a name whose label pair fills the cell', () => {
    // "Customer First Name Tên Khách Hàng<TAB>Mai" — the label pair occupies
    // the whole cell, so nothing matched and the reader fell through to a
    // LATER block that happened to use the plain English label.
    expect(THREAD).toContain('Customer First Name Tên Khách Hàng\tMai');
    expect(parsed.customerFirstName).toBe('Mai');
    expect(parsed.customerLastName).toBe('Tran');
  });

  it('reads dates from the same layout', () => {
    expect(parsed.checkIn).toBe('2026-08-06');
    expect(parsed.checkOut).toBe('2026-08-09');
    expect(parsed.nights).toBe(3);
  });

  it('reads the country and cancellation policy', () => {
    expect(parsed.countryOfResidence).toBe('Taiwan');
    expect(parsed.cancellationPolicy).not.toBeNull();
  });

  it('never lets Other Guests replace the primary customer', () => {
    // The block lists "Guest of Mai Tran" as an occupant.
    expect(THREAD).toContain('Guest of Mai Tran');
    expect(parsed.customerFullName).toBe('Mai Tran');
  });
});

/* ================================================================== */
/* The room table                                                      */
/* ================================================================== */
describe('the wrapped bilingual room table', () => {
  it('reads the room row under headers that wrap across lines', () => {
    // The header pairs a Vietnamese label with the NEXT English one, so there
    // is no header ROW to take column positions from.
    expect(parsed.roomTypeOriginal).toBe('Standard Room');
    expect(parsed.roomQuantity).toBe(1);
    expect(parsed.occupancy).toBe('2 Adults');
    expect(parsed.extraBeds).toBe(0);
  });

  it('does not read occupancy or extra beds as the quantity', () => {
    expect(parsed.roomQuantity).not.toBe(2);
    expect(parsed.roomQuantity).not.toBe(0);
  });

  it('exposes every room row, not only the first', () => {
    expect(parsed.roomLines).toHaveLength(1);
    expect(parsed.roomLines[0]).toMatchObject({
      roomTypeNormalized: 'Standard Room',
      quantity: 1,
      occupancy: '2 Adults',
      extraBeds: 0,
    });
  });
});

/* ================================================================== */
/* Rates                                                               */
/* ================================================================== */
describe('rates behind a Vietnamese twin label', () => {
  it('reads a Net rate stated under its Vietnamese label', () => {
    // "Net rate (incl…)" / "Giá thực tế (bao gồm…)" / "VND 3,688,138.00" —
    // stopping at the twin label lost the Net rate entirely.
    expect(parsed.netRate).toBe(3_688_138);
  });

  it('reads a Reference sell rate carried ON the twin label line', () => {
    expect(THREAD).toContain('Giá bán tham khảo (bao gồm thuế & phí)\tVND 5,156,900.00');
    expect(parsed.referenceSellRate).toBe(5_156_900);
  });

  it('ignores commission, tax and promotions', () => {
    for (const ignored of [1_031_380, 334_244, 103_138, 2_210_100]) {
      expect(parsed.netRate).not.toBe(ignored);
      expect(parsed.referenceSellRate).not.toBe(ignored);
    }
  });

  it('never takes a neighbouring rate row when its own is absent', () => {
    const noNet = THREAD.replace(/Net rate \(incl\. taxes & fees\)[\s\S]*?VND 3,688,138\.00/, '');
    expect(parseAgodaPartnerBooking(noNet).netRate).not.toBe(1_031_380);
  });
});

/* ================================================================== */
/* End to end                                                          */
/* ================================================================== */
describe('the amended booking reaches a dispatchable review', () => {
  const review = (overrides = {}) => {
    const booking = parseAgodaBooking(THREAD, []);
    return buildOtaReview({
      source: 'AGODA',
      platform: 'AGODA',
      parsed: { ...agodaParsedFields(booking, CN8.id), resolvedBranchId: CN8.id },
      branch: CN8,
      overrides,
    });
  };

  it('resolves branch, room and every field with no validation errors', () => {
    const r = review();
    expect(r).toMatchObject({
      branchCode: 'LE_THANH_TON_191',
      bookingCode: '1753732591',
      guestName: 'Mai Tran',
      checkIn: '2026-08-06',
      checkOut: '2026-08-09',
      nights: 3,
      branchPrice: 3_688_138,
      guestBookedPrice: 5_156_900,
      breakfastIncluded: false,
      requiresManualBranch: false,
    });
    expect(r.rooms[0]).toMatchObject({
      quantity: 1,
      otaRoomName: 'Standard Room',
      pmsCode: 'STAN',
      requiresManualMapping: false,
    });
    expect(r.blockingReasons).toEqual([]);
    expect(r.canDispatch).toBe(true);
  });

  it('produces the exact note for each payment mode', () => {
    expect(review({ paymentMode: 'CN' }).note).toBe(
      'AGD 1753732591_1STAN_3DEM 3.688.138 CN\nGIÁ KHÁCH ĐẶT 5.156.900 KHONG AN SANG',
    );
    expect(review({ paymentMode: 'HOTEL_PAYMENT' }).note).toBe(
      'AGD 1753732591_1STAN_3DEM 3.688.138 THANH TOÁN TẠI KHÁCH SẠN',
    );
  });
});
