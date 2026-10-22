/**
 * CTrip structured field extraction, against the operator-confirmed
 * reservation.
 *
 * The price rules are the point of this file. CTrip shows three amounts and
 * only two are ours; reading the wrong one would misstate what the hotel is
 * owed or what the guest paid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CTRIP_PARSER_VERSION, parseCtripBooking } from '../src/booking/ctrip';
import { normalizeText } from '../src/booking/text';
import {
  extractCtripFields,
  nightsBetween,
  parseCtripAmount,
  parseCtripDate,
} from '../src/booking/ctripFields';

const CONFIRMED = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '04-confirmed-partner-reservation.txt'),
  'utf8',
);

describe('the confirmed CTrip reservation', () => {
  const f = extractCtripFields(CONFIRMED);

  it('reads every operational field exactly', () => {
    expect(f.reservationCode).toBe('1658113703317875');
    expect(f.propertyName).toBe('KAS Zody Boutique Hotel');
    expect(f.guestName).toBe('LEE/JENSON HWEE');
    expect(f.checkIn).toBe('2026-08-01');
    expect(f.checkOut).toBe('2026-08-08');
    expect(f.roomType).toBe('Standard Double Room No Window');
    expect(f.roomQuantity).toBe(1);
  });

  it('derives 7 nights from the stay dates', () => {
    expect(nightsBetween(f.checkIn, f.checkOut)).toBe(7);
  });

  it('takes the BRANCH price from "Your payout"', () => {
    expect(f.payout).toBe(4_645_956);
  });

  it('takes the GUEST-BOOKED price from "Original room rate", not "Final room rate"', () => {
    expect(f.originalRoomRate).toBe(6_637_080);
    // Final room rate is read for display only and must never become the
    // guest-booked price while Original exists.
    expect(f.finalRoomRate).toBe(4_645_956);
    expect(f.originalRoomRate).not.toBe(f.finalRoomRate);
  });

  it('ignores Discounts entirely', () => {
    // 1.991.124 appears in the source but is never one of our fields.
    expect(CONFIRMED).toContain('1991124');
    expect(Object.values(f)).not.toContain(1_991_124);
  });

  it('reads "No meals" as breakfast not included', () => {
    expect(f.breakfastIncluded).toBe(false);
  });

  it('exposes no nightly rates, because CTrip states none', () => {
    // There is no nightly field to fabricate into…
    expect(f).not.toHaveProperty('nightlyRates');
    expect(f).not.toHaveProperty('nightlyDebt');

    // …and no extracted value is the payout divided by the nights. This payout
    // happens to divide exactly (4.645.956 / 7 = 663.708), which is precisely
    // the case where an accidental "helpful" split would look like real data.
    const perNight = 4_645_956 / 7;
    expect(Number.isInteger(perNight)).toBe(true);
    expect(Object.values(f)).not.toContain(perNight);
  });
});

describe('field parsing', () => {
  it('parses raw and grouped amounts, and refuses non-numeric', () => {
    expect(parseCtripAmount('6637080')).toBe(6_637_080);
    expect(parseCtripAmount('6.637.080')).toBe(6_637_080);
    expect(parseCtripAmount('VND 6,637,080')).toBe(6_637_080);
    // Absent stays absent — never 0, which is a real price.
    expect(parseCtripAmount(null)).toBeNull();
    expect(parseCtripAmount('—')).toBeNull();
  });

  it('parses DD/MM/YYYY and ISO dates', () => {
    expect(parseCtripDate('01/08/2026')).toBe('2026-08-01');
    expect(parseCtripDate('1/8/2026')).toBe('2026-08-01');
    expect(parseCtripDate('2026-08-01')).toBe('2026-08-01');
    expect(parseCtripDate('not a date')).toBeNull();
  });

  it('returns null nights for missing or inverted stay dates', () => {
    expect(nightsBetween(null, '2026-08-08')).toBeNull();
    expect(nightsBetween('2026-08-08', '2026-08-01')).toBeNull();
    expect(nightsBetween('2026-08-01', '2026-08-01')).toBeNull();
  });
});

describe('absent fields stay absent', () => {
  it('a reservation without a Property name leaves it null for the Admin to choose', () => {
    const f = extractCtripFields(
      ['Reservation: 999', 'Guest: A B', 'Check-in: 01/08/2026', 'Check-out: 02/08/2026'].join('\n'),
    );
    expect(f.propertyName).toBeNull();
    expect(f.reservationCode).toBe('999');
  });

  it('missing prices are null, never zero or derived', () => {
    const f = extractCtripFields('Reservation: 999\nRoom type: Standard');
    expect(f.payout).toBeNull();
    expect(f.originalRoomRate).toBeNull();
    expect(f.finalRoomRate).toBeNull();
  });

  it('an unstated Meals line leaves breakfast unknown rather than assuming', () => {
    const f = extractCtripFields('Reservation: 999');
    expect(f.breakfastIncluded).toBeNull();
  });
});

/* ================================================================== */
/* The fields reach parseCtripBooking                                  */
/* ================================================================== */

describe('parseCtripBooking carries the structured fields through', () => {
  const branches = [
    {
      id: 5,
      code: 'LE_THANH_TON_278',
      hotelName: 'Boutique Zody Hotel Ben Than',
      address: '278 Lê Thánh Tôn',
      identities: [
        {
          platform: 'CTRIP' as const,
          name: 'KAS Zody Boutique Hotel',
          normalizedName: normalizeText('KAS Zody Boutique Hotel'),
        },
      ],
    },
  ];

  const parsed = parseCtripBooking(CONFIRMED, branches);

  it('resolves the branch from the CTrip property identity', () => {
    expect(parsed.suggestedBranch?.code).toBe('LE_THANH_TON_278');
    expect(parsed.branchConfident).toBe(true);
  });

  it('uses the confirmed labels for code, guest and dates', () => {
    expect(parsed.bookingCode).toBe('1658113703317875');
    expect(parsed.guestName).toBe('LEE/JENSON HWEE');
    expect(parsed.checkIn).toBe('2026-08-01');
    expect(parsed.checkOut).toBe('2026-08-08');
    expect(parsed.ctrip?.nights).toBe(7);
  });

  it('sets the booking total to the BRANCH price (Your payout)', () => {
    expect(parsed.totalAmount).toBe(4_645_956);
    expect(parsed.ctrip?.branchPrice).toBe(4_645_956);
  });

  it('keeps the guest-booked price as Original room rate, separate from the payout', () => {
    expect(parsed.ctrip?.guestBookedPrice).toBe(6_637_080);
    expect(parsed.ctrip?.guestBookedPrice).not.toBe(parsed.ctrip?.branchPrice);
    // Final room rate is exposed for review only and is never a price we use.
    expect(parsed.ctrip?.finalRoomRate).toBe(4_645_956);
  });

  it('ignores Discounts entirely', () => {
    expect(parsed.totalAmount).not.toBe(1_991_124);
    expect(parsed.ctrip?.guestBookedPrice).not.toBe(1_991_124);
  });

  it('fabricates no nightly prices', () => {
    expect(parsed.ctrip?.nightlyRates).toEqual([]);
    const perNight = 4_645_956 / 7; // divides exactly — the tempting case
    for (const room of parsed.rooms) {
      for (const night of room.nights) {
        expect(night.amount).not.toBe(perNight);
      }
    }
  });

  it('stamps the CTrip parser version', () => {
    expect(parsed.parserVersion).toBe(CTRIP_PARSER_VERSION);
  });

  it('leaves the branch unassigned when CTrip states no Property name', () => {
    const noProperty = parseCtripBooking(
      ['Reservation: 777', 'Guest: A B', 'Check-in: 01/08/2026', 'Check-out: 02/08/2026'].join('\n'),
      branches,
    );
    expect(noProperty.ctrip?.propertyName).toBeNull();
    expect(noProperty.branchConfident).toBe(false);
    expect(noProperty.requiresManualConfirmation).toBe(true);
  });
});
