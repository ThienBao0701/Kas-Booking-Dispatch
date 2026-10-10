import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgodaBooking } from '../src/booking/agoda';
import { buildAgodaPmsNote, isAgodaPartnerEmail, parseAgodaPartnerBooking } from '../src/booking/agodaPartner';
import { matchBranch } from '../src/booking/branchMatcher';

/**
 * Regression suite for the real-world paste.
 *
 * There is NO mail integration: the operator copies the visible Agoda booking
 * content and pastes it into the existing extraction textarea. The parser
 * therefore sees plain text that may carry harmless interface noise and —
 * crucially — TABLES FLATTENED into tab/space separated lines.
 *
 * Every case below pins a defect that was observed in the UI before the fix:
 * a booking id of "Vietnam Check-in July 27 2026 LanguageEnglish", customer
 * fields that swallowed the next label, a missing check-out (hence no nights),
 * a room quantity of 120, a room type carrying the whole table row, and a phone
 * containing the guest's name.
 */
// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const PASTED = fs.readFileSync(path.join(__dirname, 'fixtures', 'agoda', '06-partner-pasted-flattened.txt'), 'utf8');
const p = () => parseAgodaPartnerBooking(PASTED);
const routed = () => parseAgodaBooking(PASTED, branches);

describe('Agoda pasted layout — input has no email dependency', () => {
  it('1/2. parses plain pasted text and ignores the interface noise', () => {
    expect(isAgodaPartnerEmail(PASTED)).toBe(true);
    const r = p();
    expect(r.warnings).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/Skip to content|Inbox|Summarize this email|screen readers|agoda\.com|to me/);
  });

  it('3. no subject line is required', () => {
    const noSubject = PASTED.split('\n').filter((l) => !/^Agoda Booking ID .* CONFIRMED/.test(l)).join('\n');
    const r = parseAgodaPartnerBooking(noSubject);
    expect(r.bookingId).toBe('1753026280');
    expect(r.checkIn).toBe('2026-07-27');
    expect(r.checkOut).toBe('2026-07-29');
    expect(r.warnings).toEqual([]);
  });

  it('5. no email metadata appears in the parser output', () => {
    const serialized = JSON.stringify(routed());
    for (const meta of ['agoda.com', 'Inbox', 'messageId', 'threadId', 'sender', 'recipient', 'subject']) {
      expect(serialized.toLowerCase()).not.toContain(meta.toLowerCase());
    }
  });

  it('6. no AGODA_PARTNER_EMAIL subtype is returned', () => {
    const serialized = JSON.stringify(routed());
    expect(serialized).not.toMatch(/AGODA_PARTNER_EMAIL|sourceSubtype/i);
  });
});

describe('Agoda pasted layout — field boundaries', () => {
  it('4. the booking id is the labelled body value, bounded to digits', () => {
    expect(p().bookingId).toBe('1753026280');
    expect(p().bookingId).not.toMatch(/Vietnam|Check-in|Language/);
  });

  it('the body id wins over a copied subject carrying a different id', () => {
    const conflicting = PASTED.replace('Agoda Booking ID 1753026280 - CONFIRMED', 'Agoda Booking ID 9999999999 - CONFIRMED');
    expect(parseAgodaPartnerBooking(conflicting).bookingId).toBe('1753026280');
  });

  it('a subject-only paste still yields just the numeric id', () => {
    const subjectOnly = [
      'Agoda Booking ID 1753026280 - CONFIRMED Hotel Country: Vietnam Check-in July 27, 2026 / Language_English',
      'Reference sell rate (incl. taxes & fees)\tVND 1,680,000.00',
      'Net rate (incl. taxes & fees)\tVND 1,016,710.00',
    ].join('\n');
    expect(parseAgodaPartnerBooking(subjectOnly).bookingId).toBe('1753026280');
  });

  it('customer fields stop at the column / next-label boundary', () => {
    const r = p();
    expect(r.customerFirstName).toBe('TEST');
    expect(r.customerLastName).toBe('CUSTOMER');
    expect(r.customerFullName).toBe('TEST CUSTOMER');
    expect(r.countryOfResidence).toBe('TEST COUNTRY');
    expect(r.customerFullName).not.toMatch(/Country of Residence|Customer Last Name/);
    expect(r.customerFullName).not.toMatch(/RmNo|Guest of/); // never "Other Guests"
  });

  it('the phone is only the number', () => {
    expect(p().customerPhone).toBe('65 80000000');
    expect(p().customerPhone).not.toMatch(/Name|Phone|TEST/i);
  });

  it('both dates parse and yield two nights', () => {
    const r = p();
    expect(r.checkIn).toBe('2026-07-27');
    expect(r.checkOut).toBe('2026-07-29');
    expect(r.nights).toBe(2);
    const codes = r.warnings.map((w) => w.code);
    expect(codes).not.toContain('AGODA_MISSING_CHECK_OUT');
    expect(codes).not.toContain('AGODA_MISSING_CHECK_IN');
  });
});

describe('Agoda pasted layout — room table', () => {
  it('reads each column, never the whole row', () => {
    const r = p();
    expect(r.roomTypeOriginal).toBe('Standard (0)');
    expect(r.roomQuantity).toBe(1);
    expect(r.occupancy).toBe('2 Adults');
    expect(r.extraBeds).toBe(0);
    expect(r.roomCode).toBe('STAN');
    expect(r.roomQuantity).not.toBe(120);
    expect(r.roomTypeOriginal).not.toMatch(/Adults|\t/);
  });

  it('values copied as separate logical lines are still mapped by column', () => {
    const stacked = PASTED.replace('Standard (0)\t1\t2 Adults\t0', 'Standard (0)\n1\n2 Adults\n0');
    const r = parseAgodaPartnerBooking(stacked);
    expect(r.roomTypeOriginal).toBe('Standard (0)');
    expect(r.roomQuantity).toBe(1);
    expect(r.occupancy).toBe('2 Adults');
    expect(r.extraBeds).toBe(0);
  });

  it('multi-space columns work as well as tabs', () => {
    const spaced = PASTED.replace(/\t/g, '    ');
    const r = parseAgodaPartnerBooking(spaced);
    expect(r.roomTypeOriginal).toBe('Standard (0)');
    expect(r.roomQuantity).toBe(1);
    expect(r.customerFullName).toBe('TEST CUSTOMER');
    expect(r.checkOut).toBe('2026-07-29');
  });
});

describe('Agoda pasted layout — hotel, money and note', () => {
  it('the hotel resolves to the branch address, never to the Property ID', () => {
    const r = routed();
    expect(r.hotelName).toBe('40-42 Bùi Thị Xuân');
    expect(r.agoda!.branchCode).toBe('BUI_THI_XUAN_40');
    expect(r.agoda!.sourceHotelName).toBe('KAS Sonata Luxury Hotel');
    // The id is recorded, but it is not part of any name and did not choose
    // the branch — that came from the configured platform identity.
    expect(r.hotelName).not.toContain('245858');
    expect(r.agoda!.sourceHotelName).not.toContain('245858');
  });

  it('money ignores commission, other programs, tax and promotions', () => {
    const r = p();
    expect(r.netRate).toBe(1_016_710);
    expect(r.referenceSellRate).toBe(1_680_000);
    expect(r.nightlyDebt).toEqual([
      { stayDate: '2026-07-27', amount: 508_355 },
      { stayDate: '2026-07-28', amount: 508_355 },
    ]);
    expect(r.nightlyDebt.reduce((t, n) => t + (n.amount ?? 0), 0)).toBe(1_016_710);
    for (const bad of [-336_000, -168_000, -108_890, -50_400, -740_740, 336_000, 740_740]) {
      expect(r.netRate).not.toBe(bad);
      expect(r.referenceSellRate).not.toBe(bad);
    }
  });

  it('breakfast is false — drinks and wifi are not breakfast', () => {
    expect(p().breakfastIncluded).toBe(false);
  });

  it('8. produces the exact two-line note, still ending in CN', () => {
    const note = buildAgodaPmsNote(p()).text;
    expect(note).toBe('AGD 1753026280_1STAN_2DEM 1.016.710 CN\nGIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG');
    expect(note).toMatch(/ CN$/m);
    expect(note).not.toContain('ĐƠN ĐỐI TÁC');
  });

  it('completeness and branch confidence are 100% with no warnings', () => {
    const r = routed();
    expect(r.parserQuality.score).toBe(100);
    expect(r.parserQuality.missingCriticalFields).toEqual([]);
    expect(r.parserQuality.requiresAdminReview).toBe(false);
    expect(r.branchConfidence).toBe(100);
    expect(r.warnings).toEqual([]);
  });

  it('7/37. the preview extras and the editable form receive the same values', () => {
    const r = routed();
    const a = r.agoda!;
    expect({
      hotel: a.branchAddress, id: a.bookingId, name: a.customerFullName, nights: a.nights,
      rooms: a.roomQuantity, code: a.roomCode, pay: a.payment, debt: a.totalDebtAmount, sell: a.referenceSellRate,
    }).toEqual({
      hotel: '40-42 Bùi Thị Xuân', id: '1753026280', name: 'TEST CUSTOMER', nights: 2,
      rooms: 1, code: 'STAN', pay: 'PREPAID', debt: 1_016_710, sell: 1_680_000,
    });
    // The editable booking form is filled from the normalized booking itself.
    expect(r.bookingCode).toBe('1753026280');
    expect(r.guestName).toBe('TEST CUSTOMER');
    expect(r.phone).toBe('65 80000000');
    expect(r.hotelName).toBe('40-42 Bùi Thị Xuân');
    expect(r.checkIn).toBe('2026-07-27');
    expect(r.checkOut).toBe('2026-07-29');
    expect(r.totalAmount).toBe(1_016_710);
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Standard (0)');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([508_355, 508_355]);
    // Guest contact metadata never becomes the booking's request note.
    expect(r.specialRequest).toBeNull();
  });
});

describe('Agoda pasted layout — Booking.com aliases stay green', () => {
  it('9/10. the renamed Booking.com properties still resolve', () => {
    expect(matchBranch('Bamboo Water Hotel', branches)?.branch.code).toBe('LY_TU_TRONG_260');
    expect(matchBranch('Bamboo Water Hotel', branches)?.branch.address).toBe('260 Lý Tự Trọng');
    expect(matchBranch('Kaliee Nata Hotel', branches)?.branch.code).toBe('NGUYEN_THAI_BINH_170');
    expect(matchBranch('Kaliee Nata Hotel', branches)?.branch.address).toBe('170-172-174 Nguyễn Thái Bình');
  });
});
