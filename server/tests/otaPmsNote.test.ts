/**
 * The exact PMS-note string contract for Agoda and CTrip.
 *
 * Every assertion here is a whole-string equality against a note the operator
 * confirmed. The receptionist pastes this into the hotel system, so a stray
 * space, a missing underscore or an extra line is a production defect, not a
 * cosmetic one — which is why nothing here matches loosely.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_BREAKFAST_TEXT,
  OTA_PAYMENT_LABEL,
  buildOtaPmsNote,
  formatVndDots,
  type OtaNoteInput,
} from '../src/booking/otaPmsNote';

/** The confirmed Agoda sample: booking 1756162808, CN7, 1x Superior, 4 nights. */
const AGODA: OtaNoteInput = {
  source: 'AGODA',
  bookingCode: '1756162808',
  rooms: [{ quantity: 1, pmsCode: 'SUP' }],
  nights: 4,
  branchPrice: 2_728_024, // Net rate
  guestBookedPrice: 4_507_750, // Reference sell rate
  paymentMode: 'CN',
  breakfastIncluded: false,
};

/**
 * The confirmed CTrip sample: reservation 1658113703317875, CN5, 1x Standard.
 *
 * `createdAt` is pinned so the second line's date is deterministic: 07:00 UTC
 * on 7 August is 14:00 the same day in Asia/Ho_Chi_Minh, so the note reads
 * "07.08". It is the CREATION day, and no field of this reservation is that
 * date — the check-in is not even in the fixture.
 */
const CTRIP: OtaNoteInput = {
  source: 'CTRIP',
  bookingCode: '1658113703317875',
  rooms: [{ quantity: 1, pmsCode: 'STAN' }],
  nights: 7,
  branchPrice: 4_645_956, // Your payout
  guestBookedPrice: 6_637_080, // Original room rate — no longer on the note
  paymentMode: 'CN',
  breakfastIncluded: false,
  createdAt: new Date('2026-08-07T07:00:00.000Z'),
};

function text(input: OtaNoteInput): string {
  const result = buildOtaPmsNote(input);
  if (!result.ok) throw new Error(`expected a note, got: ${result.error}`);
  return result.text;
}

/* ================================================================== */
/* The four confirmed notes, exactly                                   */
/* ================================================================== */

describe('confirmed note strings', () => {
  it('1. Agoda + CN', () => {
    expect(text(AGODA)).toBe(
      'AGD 1756162808_1SUP_4DEM 2.728.024 CN\nGIÁ KHÁCH ĐẶT 4.507.750 KHONG AN SANG',
    );
  });

  it('2. Agoda + hotel payment', () => {
    expect(text({ ...AGODA, paymentMode: 'HOTEL_PAYMENT' })).toBe(
      'AGD 1756162808_1SUP_4DEM 2.728.024 THANH TOÁN TẠI KHÁCH SẠN',
    );
  });

  it('3. CTrip + CN', () => {
    expect(text(CTRIP)).toBe(
      'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n07.08 KHONG AN SANG',
    );
  });

  it('4. CTrip + hotel payment', () => {
    expect(text({ ...CTRIP, paymentMode: 'HOTEL_PAYMENT' })).toBe(
      'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN TẠI KHÁCH SẠN\n07.08 KHONG AN SANG',
    );
  });
});

/* ================================================================== */
/* CTrip's second line: the creation date, never a price               */
/* ================================================================== */

describe("CTrip's second line", () => {
  it('carries the creation day as DD.MM and no guest-booked price', () => {
    const note = text(CTRIP);
    const line2 = note.split('\n')[1]!;
    expect(line2).toBe('07.08 KHONG AN SANG');
    expect(note).not.toContain('GIÁ KHÁCH ĐẶT');
    expect(note).not.toContain('6.637.080');
  });

  it('follows line 1 immediately — never a blank line between them', () => {
    for (const mode of ['CN', 'HOTEL_PAYMENT'] as const) {
      const lines = text({ ...CTRIP, paymentMode: mode }).split('\n');
      expect(lines, mode).toHaveLength(2);
      expect(lines[1]!.trim().length, mode).toBeGreaterThan(0);
    }
  });

  it('reads the CREATION date, not the stay', () => {
    // A different creation day moves the line; nothing about the stay does.
    expect(text({ ...CTRIP, createdAt: new Date('2026-12-25T07:00:00.000Z') })).toContain(
      '\n25.12 KHONG AN SANG',
    );
  });

  it('uses Asia/Ho_Chi_Minh, so a late-evening UTC time is already tomorrow', () => {
    // 18:30 UTC on the 6th is 01:30 on the 7th in Ho Chi Minh City.
    expect(text({ ...CTRIP, createdAt: new Date('2026-08-06T18:30:00.000Z') })).toContain(
      '\n07.08 ',
    );
  });

  it('is built without a guest-booked price at all', () => {
    const result = buildOtaPmsNote({ ...CTRIP, guestBookedPrice: null });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toBe(
      'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n07.08 KHONG AN SANG',
    );
  });
});

/* ================================================================== */
/* The two prefix rules that are easiest to get wrong                  */
/* ================================================================== */

describe('prefix separators', () => {
  it('AGD is followed by exactly one space, then the booking code', () => {
    const line1 = text(AGODA).split('\n')[0]!;
    expect(line1.startsWith('AGD 1756162808_')).toBe(true);
    expect(line1).not.toMatch(/^AGD {2,}/); // never two spaces
    expect(line1).not.toMatch(/^AGD_/); // never an underscore
  });

  it('CTRIP is followed immediately by an underscore, with no space', () => {
    const line1 = text(CTRIP).split('\n')[0]!;
    expect(line1.startsWith('CTRIP_1658113703317875_')).toBe(true);
    expect(line1).not.toMatch(/^CTRIP /); // never a space
  });
});

/* ================================================================== */
/* Hotel-payment notes carry nothing extra                             */
/* ================================================================== */

describe('hotel-payment notes', () => {
  const agodaHotel = text({ ...AGODA, paymentMode: 'HOTEL_PAYMENT' });
  const ctripHotel = text({ ...CTRIP, paymentMode: 'HOTEL_PAYMENT' });

  it('are exactly one line for AGODA', () => {
    // CTrip is the exception: its second line is the creation date and is
    // printed whichever way the guest pays.
    expect(agodaHotel.split('\n')).toHaveLength(1);
    expect(agodaHotel).not.toContain('\n');
    expect(ctripHotel.split('\n')).toHaveLength(2);
  });

  it('never carry the guest-booked price', () => {
    expect(agodaHotel).not.toContain('GIÁ KHÁCH ĐẶT');
    expect(ctripHotel).not.toContain('GIÁ KHÁCH ĐẶT');
    expect(agodaHotel).not.toContain('4.507.750');
    expect(ctripHotel).not.toContain('6.637.080');
  });

  it('never carry a breakfast suffix on AGODA', () => {
    expect(agodaHotel).not.toContain(NO_BREAKFAST_TEXT);
  });

  it('use the exact wording THANH TOÁN TẠI KHÁCH SẠN', () => {
    // The operator confirmed "TẠI" belongs in this phrase.
    expect(OTA_PAYMENT_LABEL.HOTEL_PAYMENT).toBe('THANH TOÁN TẠI KHÁCH SẠN');
    expect(agodaHotel).toContain('THANH TOÁN TẠI KHÁCH SẠN');
    expect(ctripHotel).toContain('THANH TOÁN TẠI KHÁCH SẠN');
  });

  it('are generated even when the guest-booked price is unknown', () => {
    // It is never rendered, so it is never required.
    const result = buildOtaPmsNote({
      ...AGODA,
      paymentMode: 'HOTEL_PAYMENT',
      guestBookedPrice: null,
    });
    expect(result.ok).toBe(true);
  });
});

/* ================================================================== */
/* Multiple room types                                                 */
/* ================================================================== */

describe('multiple room fragments', () => {
  it('renders one fragment per room line, in order', () => {
    expect(
      text({
        ...AGODA,
        bookingCode: '123456789',
        rooms: [
          { quantity: 2, pmsCode: 'SUP' },
          { quantity: 1, pmsCode: 'DEL' },
        ],
        nights: 3,
        branchPrice: 6_500_000,
        guestBookedPrice: 8_200_000,
      }),
    ).toBe(
      'AGD 123456789_2SUP_1DEL_3DEM 6.500.000 CN\nGIÁ KHÁCH ĐẶT 8.200.000 KHONG AN SANG',
    );
  });

  it('never merges different room types, even with equal quantities', () => {
    const line1 = text({
      ...CTRIP,
      rooms: [
        { quantity: 1, pmsCode: 'STAN' },
        { quantity: 1, pmsCode: 'SUP' },
        { quantity: 1, pmsCode: 'DEL' },
      ],
    }).split('\n')[0]!;
    expect(line1).toContain('_1STAN_1SUP_1DEL_7DEM');
  });

  it('keeps branch-specific codes verbatim, including the underscored one', () => {
    // CN2's Premium-Twin code is PRE_DD in this system's catalogue.
    const line1 = text({
      ...AGODA,
      rooms: [
        { quantity: 1, pmsCode: 'LUXDEL' },
        { quantity: 2, pmsCode: 'PRE_DD' },
      ],
    }).split('\n')[0]!;
    expect(line1).toContain('_1LUXDEL_2PRE_DD_4DEM');
  });
});

/* ================================================================== */
/* Refusals — nothing is ever guessed                                  */
/* ================================================================== */

describe('refusals', () => {
  const refusal = (over: Partial<OtaNoteInput>) => buildOtaPmsNote({ ...AGODA, ...over });

  it('refuses an unresolved room mapping and names the reason', () => {
    const r = refusal({ rooms: [{ quantity: 1, pmsCode: null }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('mã hạng phòng nội bộ');
  });

  it('refuses a missing branch price, naming the platform field', () => {
    expect(refusal({ branchPrice: null }).ok).toBe(false);
    const agoda = refusal({ branchPrice: null });
    expect(agoda.ok === false && agoda.error).toContain('Net rate');

    const ctrip = buildOtaPmsNote({ ...CTRIP, branchPrice: null });
    expect(ctrip.ok === false && ctrip.error).toContain('Your payout');
  });

  it('refuses an AGODA CN note without the guest-booked price', () => {
    // Agoda's CN note prints GIÁ KHÁCH ĐẶT, so the figure is required.
    const agoda = refusal({ guestBookedPrice: null });
    expect(agoda.ok === false && agoda.error).toContain('Reference sell rate');
  });

  it('does NOT refuse a CTrip note without the guest-booked price', () => {
    // CTrip prints the creation date in that position and never reads the
    // price, so requiring it would block a dispatch over an unused figure.
    expect(buildOtaPmsNote({ ...CTRIP, guestBookedPrice: null }).ok).toBe(true);
    expect(
      buildOtaPmsNote({ ...CTRIP, paymentMode: 'HOTEL_PAYMENT', guestBookedPrice: null }).ok,
    ).toBe(true);
  });

  it('refuses missing booking code, nights, rooms and bad quantities', () => {
    expect(refusal({ bookingCode: null }).ok).toBe(false);
    expect(refusal({ bookingCode: '   ' }).ok).toBe(false);
    expect(refusal({ nights: null }).ok).toBe(false);
    expect(refusal({ nights: 0 }).ok).toBe(false);
    expect(refusal({ rooms: [] }).ok).toBe(false);
    expect(refusal({ rooms: [{ quantity: 0, pmsCode: 'SUP' }] }).ok).toBe(false);
  });

  it('refuses a breakfast-included CN note rather than inventing wording', () => {
    // Only the no-breakfast phrase has been approved.
    const r = refusal({ breakfastIncluded: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('ăn sáng');
  });

  it('refuses a breakfast-included CTrip note in either payment mode', () => {
    // CTrip now prints the breakfast wording on both, so both must refuse.
    for (const mode of ['CN', 'HOTEL_PAYMENT'] as const) {
      const r = buildOtaPmsNote({ ...CTRIP, paymentMode: mode, breakfastIncluded: true });
      expect(r.ok, mode).toBe(false);
    }
  });
});

/* ================================================================== */
/* Money formatting                                                    */
/* ================================================================== */

describe('formatVndDots', () => {
  it('groups thousands with dots and never adds a currency symbol', () => {
    expect(formatVndDots(2_728_024)).toBe('2.728.024');
    expect(formatVndDots(4_645_956)).toBe('4.645.956');
    expect(formatVndDots(500)).toBe('500');
    expect(formatVndDots(1_000)).toBe('1.000');
    expect(formatVndDots(0)).toBe('0');
  });
});
