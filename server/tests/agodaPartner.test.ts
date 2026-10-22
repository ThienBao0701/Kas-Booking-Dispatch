import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAgodaPmsNote,
  formatVndDots,
  isAgodaEmail,
  isAgodaPartnerEmail,
  mapAgodaRoomCode,
  nightsBetween,
  parseAgodaMoney,
  parseAgodaPartnerBooking,
  type AgodaPartnerBooking,
} from '../src/booking/agodaPartner';
import { AGODA_PARSER_VERSION, AGODA_PARTNER_PARSER_VERSION, parseAgodaBooking } from '../src/booking/agoda';
import { AGODA_HOTEL_NAMES } from '../src/booking/branchMatcher';
import { allocateEvenly } from '../src/booking/money';

// Branch fixtures mirror the seed, with deterministic ids 1..8.
// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const FIXTURE = path.join(__dirname, 'fixtures', 'agoda', '05-partner-ycs-booking.txt');
const SAMPLE = fs.readFileSync(FIXTURE, 'utf8');

const parsed = (): AgodaPartnerBooking => parseAgodaPartnerBooking(SAMPLE);
/** Replaces a labelled value in the fixture (for negative cases). */
function withoutLine(pattern: RegExp): string {
  return SAMPLE.split(/\r?\n/).filter((l) => !pattern.test(l)).join('\n');
}

describe('Agoda partner — detection', () => {
  it('1. detects an Agoda partner confirmation email', () => {
    expect(isAgodaPartnerEmail(SAMPLE)).toBe(true);
    expect(isAgodaEmail(SAMPLE)).toBe(true);
  });

  it('does not classify a generic "Booking confirmation" line as Agoda partner', () => {
    expect(isAgodaPartnerEmail('Booking confirmation\nThank you for your reservation.')).toBe(false);
    expect(isAgodaEmail('Booking confirmation\nThank you for your reservation.')).toBe(false);
  });

  it('does not classify a Booking.com email as Agoda partner', () => {
    const bookingCom = 'Booking.com\nXác nhận đặt phòng\nMã số đặt phòng: 489234523\nNhận phòng: 19/07/2026';
    expect(isAgodaPartnerEmail(bookingCom)).toBe(false);
  });
});

describe('Agoda partner — core fields', () => {
  it('2. extracts the Booking ID', () => expect(parsed().bookingId).toBe('1753026280'));

  it('3. extracts the primary customer name from First + Last', () => {
    const r = parsed();
    expect(r.customerFirstName).toBe('TEST');
    expect(r.customerLastName).toBe('CUSTOMER');
    expect(r.customerFullName).toBe('TEST CUSTOMER');
  });

  it('4. ignores "Other Guests" as the primary customer', () => {
    expect(parsed().customerFullName).not.toContain('GUEST TWO');
  });

  it('5. parses English month dates', () => {
    const r = parsed();
    expect(r.checkIn).toBe('2026-07-27');
    expect(r.checkOut).toBe('2026-07-29');
  });

  it('6. calculates two nights correctly', () => expect(parsed().nights).toBe(2));

  it('7. handles a cross-month stay (July 31 → August 2 = 2 nights)', () => {
    expect(nightsBetween('2026-07-31', '2026-08-02')).toBe(2);
  });

  it('8. handles a cross-year stay (Dec 31 → Jan 2 = 2 nights)', () => {
    expect(nightsBetween('2026-12-31', '2027-01-02')).toBe(2);
  });

  it('does not infer nights from the nightly-rate row count', () => {
    // Two nightly rows AND a 2-night range agree here; the range is authoritative.
    const r = parsed();
    expect(r.nightlyRates).toHaveLength(2);
    expect(r.nights).toBe(nightsBetween(r.checkIn, r.checkOut));
  });

  it('9. extracts one room from "No. of Rooms"', () => expect(parsed().roomQuantity).toBe(1));

  it('10. does not treat two adults as two rooms', () => {
    const r = parsed();
    expect(r.occupancy).toContain('2 Adults');
    expect(r.roomQuantity).toBe(1);
  });
});

describe('Agoda partner — room-code mapping', () => {
  const code = (s: string) => mapAgodaRoomCode(s).code;

  it('11. Standard (0) → STAN', () => expect(code('Standard (0)')).toBe('STAN'));
  it('12. Standard → STAN', () => expect(code('Standard')).toBe('STAN'));
  it('13. Superior → SUP', () => expect(code('Superior')).toBe('SUP'));
  it('14. plain Deluxe → DEL', () => expect(code('Deluxe')).toBe('DEL'));
  it('15. Deluxe Room - 01 → LUXDEL', () => expect(code('Deluxe Room - 01')).toBe('LUXDEL'));
  it('16. D-D Room - 03 → DD', () => expect(code('D-D Room - 03')).toBe('DD'));
  it('17. Deluxe Giường Đôi/2 Giường Đơn → DD', () => expect(code('Deluxe Giường Đôi/2 Giường Đơn')).toBe('DD'));
  it('18. Deluxe Balcony → DEBAL', () => expect(code('Deluxe Balcony')).toBe('DEBAL'));
  it('19. King Balcony → KINGBAL', () => expect(code('King Balcony')).toBe('KINGBAL'));
  it('20. Deluxe Family → DEFAM', () => expect(code('Deluxe Family')).toBe('DEFAM'));
  it('21. Family → FAM', () => expect(code('Family')).toBe('FAM'));

  it('22. the most specific mapping wins over plain Deluxe', () => {
    expect(code('Deluxe Room - 01')).not.toBe('DEL');
    expect(code('Deluxe Balcony')).not.toBe('DEL');
    expect(code('Deluxe Family')).not.toBe('DEL');
    expect(code('Deluxe Family')).not.toBe('FAM');
  });

  it('normalises case, whitespace and the "(0)" suffix', () => {
    expect(code('  standard   (0)  ')).toBe('STAN');
    expect(code('SUPERIOR')).toBe('SUP');
  });

  it('23. an unknown room type is preserved and flagged for manual review', () => {
    const unknown = mapAgodaRoomCode('Penthouse Skyline Loft');
    expect(unknown.code).toBeNull();
    expect(unknown.known).toBe(false);
    expect(unknown.original).toBe('Penthouse Skyline Loft');

    const r = parseAgodaPartnerBooking(SAMPLE.replace('Standard (0)', 'Penthouse Skyline Loft'));
    expect(r.roomTypeOriginal).toBe('Penthouse Skyline Loft');
    expect(r.roomCode).toBeNull();
    expect(r.warnings.some((w) => w.code === 'AGODA_UNKNOWN_ROOM_TYPE' && w.severity === 'ERROR')).toBe(true);
    // It must never be silently mapped to an existing code.
    expect(buildAgodaPmsNote(r).ok).toBe(false);
  });
});

describe('Agoda partner — money', () => {
  it('24. extracts the Net rate', () => expect(parsed().netRate).toBe(1_016_710));
  it('25. extracts the Reference sell rate', () => expect(parsed().referenceSellRate).toBe(1_680_000));

  it('26–30. never uses commission / other programs / withholding / tax-on-commission / promotion', () => {
    const r = parsed();
    const forbidden = [663_290, 0];
    expect(forbidden).not.toContain(r.netRate);
    expect(r.netRate).toBe(1_016_710);
    expect(r.referenceSellRate).toBe(1_680_000);
    // Consistency check only: 508,355 × 2 = 1,016,710 (the label stays authoritative).
    expect(508_355 * 2).toBe(r.netRate);
  });

  it('normalises the Agoda money formats', () => {
    expect(parseAgodaMoney('VND 1,016,710.00')).toBe(1_016_710);
    expect(parseAgodaMoney('VND 508,355.00')).toBe(508_355);
    expect(parseAgodaMoney('1,680,000 VND')).toBe(1_680_000);
    expect(parseAgodaMoney('1.016.710 VND')).toBe(1_016_710);
    expect(parseAgodaMoney('no amount here')).toBeNull();
  });

  it('reads the amount, not the date, from a nightly row', () => {
    expect(parseAgodaMoney('July 27, 2026     VND 508,355.00')).toBe(508_355);
    expect(parsed().nightlyRates.map((n) => n.amount)).toEqual([508_355, 508_355]);
    expect(parsed().nightlyRates.map((n) => n.stayDate)).toEqual(['2026-07-27', '2026-07-28']);
  });

  it('31. formats 1016710 as 1.016.710', () => expect(formatVndDots(1_016_710)).toBe('1.016.710'));
  it('32. formats 1680000 as 1.680.000', () => expect(formatVndDots(1_680_000)).toBe('1.680.000'));
});

describe('Agoda partner — nightly debt allocation', () => {
  it('11. the Net rate is the total debt', () => {
    const r = parsed();
    expect(r.netRate).toBe(1_016_710);
  });

  it('12/13. two nights divide as 508.355 + 508.355 over check-in → day before check-out', () => {
    expect(parsed().nightlyDebt).toEqual([
      { stayDate: '2026-07-27', amount: 508_355 },
      { stayDate: '2026-07-28', amount: 508_355 },
    ]);
  });

  it('14. the nightly debt sum equals the total Net rate exactly', () => {
    const r = parsed();
    const sum = r.nightlyDebt.reduce((t, n) => t + (n.amount ?? 0), 0);
    expect(sum).toBe(r.netRate);
    expect(sum).toBe(1_016_710);
  });

  it('14. the check-out date is excluded from the schedule', () => {
    const r = parsed();
    expect(r.checkOut).toBe('2026-07-29');
    expect(r.nightlyDebt.map((n) => n.stayDate)).not.toContain('2026-07-29');
    expect(r.nightlyDebt.at(-1)!.stayDate).toBe('2026-07-28'); // day before check-out
  });

  it('16. a non-divisible total keeps the remainder on the EARLIEST nights', () => {
    expect(allocateEvenly(1_000_001, 2)).toEqual([500_001, 500_000]);
    expect(allocateEvenly(1_000_002, 4)).toEqual([250_001, 250_001, 250_000, 250_000]);
  });

  it('17. three-night allocation is deterministic', () => {
    // Evenly divisible: every night is identical.
    expect(allocateEvenly(1_000_002, 3)).toEqual([333_334, 333_334, 333_334]);
    // With a remainder of 2 the two earliest nights each take one extra đồng.
    expect(allocateEvenly(1_000_001, 3)).toEqual([333_334, 333_334, 333_333]);
    // Repeat calls are identical (pure + deterministic).
    expect(allocateEvenly(1_000_001, 3)).toEqual(allocateEvenly(1_000_001, 3));
  });

  it('never loses the remainder, rounds, or creates decimal VND', () => {
    for (const [total, parts] of [[1_000_001, 2], [1_000_002, 3], [1_016_710, 2], [999_999, 7], [1, 3]] as const) {
      const split = allocateEvenly(total, parts);
      expect(split.reduce((a, b) => a + b, 0)).toBe(total);
      for (const v of split) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('18–21. the debt is divided by NIGHTS, not adults / occupancy / other guests / extra beds', () => {
    const r = parsed();
    expect(r.occupancy).toContain('2 Adults');
    expect(r.extraBeds).toBe(0);
    expect(r.nightlyDebt).toHaveLength(r.nights!);

    // 2 adults happens to equal 2 nights here, so vary every other divisor while
    // keeping 3 nights: the schedule must always follow the NIGHT count.
    const varied = SAMPLE.replace('July 29, 2026', 'July 30, 2026') // 3 nights
      .replace('2 Adults', '4 Adults')
      .replace('No. of Extra Bed:\n0', 'No. of Extra Bed:\n2')
      .replace('Other Guests:\nGUEST TWO', 'Other Guests:\nGUEST TWO, GUEST THREE, GUEST FOUR');
    const three = parseAgodaPartnerBooking(varied);
    expect(three.nights).toBe(3);
    expect(three.occupancy).toContain('4 Adults');
    expect(three.extraBeds).toBe(2);
    expect(three.nightlyDebt).toHaveLength(3); // 3 nights — not 4 adults, not 2 beds
    expect(three.nightlyDebt.reduce((t, n) => t + (n.amount ?? 0), 0)).toBe(1_016_710);
  });

  it('22–24. commission, promotions and tax rows never affect the debt', () => {
    const r = parsed();
    // The fixture carries Commission / Other programs / Withholding tax /
    // Tax on Commission / Promotion / Compensation rows; none is used.
    expect(r.netRate).toBe(1_016_710);
    expect(r.nightlyDebt.reduce((t, n) => t + (n.amount ?? 0), 0)).toBe(1_016_710);
    // Changing a deduction row must not move the debt at all.
    const altered = SAMPLE
      .replace('Commission (incl. taxes & fees):     VND 663,290.00', 'Commission (incl. taxes & fees):     VND 900,000.00')
      .replace('Promotion:     VND 0.00', 'Promotion:     VND 250,000.00')
      .replace('Withholding tax:     VND 0.00', 'Withholding tax:     VND 50,000.00');
    const r2 = parseAgodaPartnerBooking(altered);
    expect(r2.netRate).toBe(1_016_710);
    expect(r2.referenceSellRate).toBe(1_680_000);
    expect(r2.nightlyDebt).toEqual(r.nightlyDebt);
  });

  it('10. Agoda nightly rows are diagnostics only — a mismatch warns but keeps the total', () => {
    // Change one stated Agoda row; the generated allocation and total must hold.
    const r = parseAgodaPartnerBooking(SAMPLE.replace('July 28, 2026     VND 508,355.00', 'July 28, 2026     VND 400,000.00'));
    expect(r.netRate).toBe(1_016_710);
    expect(r.nightlyDebt.map((n) => n.amount)).toEqual([508_355, 508_355]);
    const w = r.warnings.find((x) => x.code === 'AGODA_NIGHTLY_ROWS_DIFFER');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('INFO'); // non-blocking
    expect(buildAgodaPmsNote(r).text).toContain('1.016.710');
  });
});

describe('Agoda partner — benefits & payment', () => {
  it('33. does not treat Coffee & tea / water / welcome drink as breakfast', () => {
    const note = buildAgodaPmsNote(parsed());
    expect(note.text).toContain('KHONG AN SANG');
    expect(note.text).not.toContain('CO AN SANG');
  });

  it('34. extracts PREPAID as structured information', () => expect(parsed().payment).toBe('PREPAID'));

  it('35. keeps PREPAID out of the PMS note', () => {
    expect(buildAgodaPmsNote(parsed()).text).not.toContain('PREPAID');
  });
});

describe('Agoda partner — PMS note', () => {
  it('36. produces exactly two lines', () => {
    const note = buildAgodaPmsNote(parsed());
    expect(note.ok).toBe(true);
    expect(note.text!.split('\n')).toHaveLength(2);
  });

  it('37. produces the exact expected note', () => {
    expect(buildAgodaPmsNote(parsed()).text).toBe(
      'AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG',
    );
  });

  it('omits customer name, phone, dates, policy and commission', () => {
    const text = buildAgodaPmsNote(parsed()).text!;
    for (const forbidden of ['TEST', 'CUSTOMER', '2026', 'Non-refundable', '663', 'VND', '₫', ',']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('38. a missing Net rate fails safely (no arithmetic guess)', () => {
    const r = parseAgodaPartnerBooking(withoutLine(/^Net rate/));
    expect(r.netRate).toBeNull();
    expect(r.warnings.some((w) => w.code === 'AGODA_MISSING_NET_RATE' && w.severity === 'ERROR')).toBe(true);
    // Nightly data is preserved for manual review.
    expect(r.nightlyRates).toHaveLength(2);
    const note = buildAgodaPmsNote(r);
    expect(note.ok).toBe(false);
    expect(note.error).toContain('Net rate');
  });

  it('39. a missing Reference sell rate fails safely', () => {
    const r = parseAgodaPartnerBooking(withoutLine(/^Reference sell rate/));
    expect(r.referenceSellRate).toBeNull();
    expect(r.warnings.some((w) => w.code === 'AGODA_MISSING_SELL_RATE' && w.severity === 'ERROR')).toBe(true);
    expect(buildAgodaPmsNote(r).ok).toBe(false);
  });

  it('is deterministic (same input ⇒ identical note)', () => {
    expect(buildAgodaPmsNote(parsed()).text).toBe(buildAgodaPmsNote(parsed()).text);
  });
});

describe('Agoda partner — routed through parseAgodaBooking', () => {
  const routed = () => parseAgodaBooking(SAMPLE, branches);

  it('detects the partner format and stamps the partner parser version', () => {
    const r = routed();
    expect(r.parserVersion).toBe(AGODA_PARTNER_PARSER_VERSION);
    expect(r.agoda).toBeDefined();
  });

  it('maps onto the shared ParsedBooking shape', () => {
    const r = routed();
    expect(r.bookingCode).toBe('1753026280');
    expect(r.guestName).toBe('TEST CUSTOMER');
    expect(r.checkIn).toBe('2026-07-27');
    expect(r.checkOut).toBe('2026-07-29');
    // The hotel's own amount is the NET rate; the guest price is kept separately.
    expect(r.totalAmount).toBe(1_016_710);
    expect(r.agoda!.referenceSellRate).toBe(1_680_000);
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.currency).toBe('VND');
  });

  it('expands "No. of Rooms" into physical rooms carrying the debt schedule', () => {
    const r = routed();
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Standard (0)');
    expect(r.rooms[0]!.roomTotal).toBe(1_016_710);
    expect(r.rooms[0]!.nights.map((n) => n.stayDate)).toEqual(['2026-07-27', '2026-07-28']);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([508_355, 508_355]);
  });

  it('1–3. resolves the Agoda hotel name through the existing branch mapping', () => {
    const r = routed();
    expect(r.suggestedBranch?.address).toBe('40-42 Bùi Thị Xuân');
    expect(r.suggestedBranch?.code).toBe('BUI_THI_XUAN_40');
    expect(r.suggestedBranch?.id).toBe(6);
    expect(r.branchConfident).toBe(true);
  });

  it('2/4. the normalized hotel is the branch ADDRESS, not the public KAS name', () => {
    const r = routed();
    expect(r.hotelName).toBe('40-42 Bùi Thị Xuân');
    expect(r.hotelName).not.toContain('KAS');
    // The source name is kept only for Admin review.
    expect(r.agoda!.sourceHotelName).toBe('KAS Sonata Luxury Hotel');
    expect(r.agoda!.branchAddress).toBe('40-42 Bùi Thị Xuân');
    expect(r.agoda!.branchCode).toBe('BUI_THI_XUAN_40');
  });

  it('5–8. Property ID is recorded for audit but never routes a booking', () => {
    // The id used to be discarded entirely. It is now kept on the booking
    // record because operators need it for reconciliation — but ONLY as a
    // recorded fact. The reason it was discarded still holds: a property
    // renumbered on Agoda must not silently reroute a reservation, so nothing
    // resolves a branch from it, and it never contaminates the hotel name.
    const r = routed();
    expect(r.agoda!.sourcePropertyId).toBe('245858');
    expect(r.agoda!.sourceHotelName).not.toContain('245858');
    expect(r.agoda!.sourceHotelName).not.toMatch(/property\s*id/i);

    // The branch came from the configured platform identity, not the id.
    expect(r.agoda!.branchCode).not.toBeNull();
    expect(r.hotelName).not.toContain('245858');
  });

  it('9/10. an unknown or incomplete hotel name never selects a default branch', () => {
    const unresolvable = [
      // Incomplete variants of names that ARE configured — must not fuzzy-match.
      'KAS Passion Hotel',
      'Passion Boutique',
      'KAS Milestone Hotel',
      'Milestone Premium',
      'KAS Sonata Hotel',
      'Sonata Luxury',
      'KAS Luxury Hotel',
      'Unknown Hotel',
    ];
    for (const unknown of unresolvable) {
      const r = parseAgodaBooking(SAMPLE.replaceAll('KAS Sonata Luxury Hotel', unknown), branches);
      expect(r.suggestedBranch).toBeNull();
      expect(r.hotelName).toBeNull();
      expect(r.requiresManualConfirmation).toBe(true);
      expect(r.warnings.some((w) => w.message === 'Không xác định được địa chỉ chi nhánh từ tên khách sạn Agoda.')).toBe(true);
      // The source name is preserved for the Admin to act on.
      expect(r.agoda!.sourceHotelName).toBe(unknown);
    }
  });

  /** The operator-confirmed mapping: Agoda public name → stored branch address. */
  const EXPECTED_MAPPING: ReadonlyArray<[name: string, address: string]> = [
    ['KAS Passion Boutique Hotel', '05 Trương Định'],
    ['KAS Elegance Hotel', '260 Lý Tự Trọng'],
    ['KAS Ancient Boutique Hotel', '47A Nguyễn Trãi'],
    ['KAS Milestone Premium Hotel', '170-172-174 Nguyễn Thái Bình'],
    ['KAS Zody Boutique Hotel', '278 Lê Thánh Tôn'],
    ['KAS Sonata Luxury Hotel', '40-42 Bùi Thị Xuân'],
    ['KAS Eliana Luxury Hotel', '13 Bùi Thị Xuân'],
    ['KAS Dilly Hotel', '191 Lê Thánh Tôn'],
  ];

  it('1/2/4/7/8. all eight Agoda names resolve to their stored branch address', () => {
    expect(EXPECTED_MAPPING).toHaveLength(8);
    for (const [name, address] of EXPECTED_MAPPING) {
      const r = parseAgodaBooking(SAMPLE.replaceAll('KAS Sonata Luxury Hotel', name), branches);
      // The normalized hotel is the ADDRESS, never the public KAS name.
      expect(r.hotelName, name).toBe(address);
      expect(r.hotelName, name).not.toContain('KAS');
      expect(r.agoda!.branchAddress, name).toBe(address);
      expect(r.agoda!.sourceHotelName, name).toBe(name); // kept for review only
      expect(r.suggestedBranch?.address, name).toBe(address);
    }
  });

  it('3/5. the configured stable branch codes are returned, independent of array order', () => {
    // Codes come from the seed and are asserted against the ADDRESS, so a reorder
    // of the branch array (or different numeric ids) cannot change the outcome.
    const byAddress = new Map(branches.map((b) => [b.address, b.code]));
    for (const [name, address] of EXPECTED_MAPPING) {
      const r = parseAgodaBooking(SAMPLE.replaceAll('KAS Sonata Luxury Hotel', name), branches);
      expect(r.suggestedBranch?.code, name).toBe(byAddress.get(address));
      expect(r.agoda!.branchCode, name).toBe(byAddress.get(address));
      expect(r.agoda!.branchId, name).toBe(branches.find((b) => b.address === address)!.id);
    }

    // Same result when the branch array is shuffled (no positional dependence).
    const reversed = [...branches].reverse();
    for (const [name, address] of EXPECTED_MAPPING) {
      const r = parseAgodaBooking(SAMPLE.replaceAll('KAS Sonata Luxury Hotel', name), reversed);
      expect(r.hotelName, name).toBe(address);
      expect(r.suggestedBranch?.code, name).toBe(byAddress.get(address));
    }
  });

  it('6. no mapping is left unresolved', () => {
    expect(AGODA_HOTEL_NAMES).toHaveLength(8);
    expect(AGODA_HOTEL_NAMES.filter((h) => h.branchCode === null)).toEqual([]);
    // Every configured code exists in the seeded branch set.
    for (const { name, branchCode } of AGODA_HOTEL_NAMES) {
      expect(branches.some((b) => b.code === branchCode), name).toBe(true);
    }
  });

  it('carries the exact PMS note in the preview extras', () => {
    expect(routed().agoda!.pmsNote).toBe(
      'AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG',
    );
  });

  it('40. the guest-confirmation Agoda path is unchanged (no partner extras)', () => {
    const guest = fs.readFileSync(path.join(__dirname, 'fixtures', 'agoda', '01-en-one-room-prepaid.txt'), 'utf8');
    const r = parseAgodaBooking(guest, branches);
    expect(r.agoda).toBeUndefined();
    expect(r.parserVersion).toBe(AGODA_PARSER_VERSION);
    expect(r.bookingCode).toBe('895647312');
  });
});

describe('Agoda partner — structured extras', () => {
  it('preserves the useful structured fields', () => {
    const r = parsed();
    expect(r.source).toBe('AGODA');
    expect(r.sourceHotelName).toBe('KAS Sonata Luxury Hotel');
    expect(r.countryOfResidence).toBe('Vietnam');
    expect(r.ratePlan).toContain('Standard Rate');
    expect(r.cancellationPolicy).toBe('Non-refundable');
    expect(r.extraBeds).toBe(0);
    expect(r.roomTypeOriginal).toBe('Standard (0)');
    expect(r.roomCode).toBe('STAN');
    expect(r.roomTypeKnown).toBe(true);
  });

  it('matches the specified acceptance shape', () => {
    const r = parsed();
    expect({
      source: r.source,
      bookingId: r.bookingId,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      nights: r.nights,
      roomQuantity: r.roomQuantity,
      roomTypeOriginal: r.roomTypeOriginal,
      roomCode: r.roomCode,
      netRate: r.netRate,
      referenceSellRate: r.referenceSellRate,
      payment: r.payment,
    }).toEqual({
      source: 'AGODA',
      bookingId: '1753026280',
      checkIn: '2026-07-27',
      checkOut: '2026-07-29',
      nights: 2,
      roomQuantity: 1,
      roomTypeOriginal: 'Standard (0)',
      roomCode: 'STAN',
      netRate: 1_016_710,
      referenceSellRate: 1_680_000,
      payment: 'PREPAID',
    });
  });
});
