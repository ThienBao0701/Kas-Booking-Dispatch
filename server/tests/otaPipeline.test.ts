/**
 * The OTA extraction pipeline, end to end through the REAL HTTP route.
 *
 * Phase 4.5's parser tests passed while text pasted in the browser still came
 * back with empty fields, because every one of those tests called a parser
 * function directly. Nothing exercised the path a real paste takes:
 *
 *   request body → zod → source routing → adapter → field mapper → review →
 *   room resolution against the database → JSON response
 *
 * A value can be read correctly and still be lost at any of those joins — by a
 * schema that strips an undeclared key, by a mapper that rebuilds an object
 * field by field, or by a `||` that turns a legitimate 0 into a fallback. These
 * tests therefore assert the FINAL JSON, for the two reservations the operator
 * confirmed, and they use the raw text exactly as it was supplied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';
import { hcmDayMonthDots } from '../src/booking/otaPmsNote';

/** CTrip's second line is the creation day — today for a review built now. */
const CREATED = hcmDayMonthDots(new Date());

const AGODA_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '08-real-bilingual-inline.txt'),
  'utf8',
);
const CTRIP_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '06-real-page-property-above.txt'),
  'utf8',
);

let app: ReturnType<typeof createApp>;
let agent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  await createAdmin({ mustChangePassword: false });
  agent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

afterAll(async () => testPrisma.$disconnect());

/** Posts exactly what the browser posts. */
const review = (body: Record<string, unknown>) =>
  agent.post('/api/admin/ota/review').send(body);

/* ================================================================== */
/* F. The mappings the samples depend on really exist                  */
/* ================================================================== */
describe('mapping integration', () => {
  it.each([
    ['CTRIP', 'Standard Double Room No Window', 'STAN'],
    ['AGODA', 'Superior Double Room', 'SUP'],
  ])('%s + CN5 + %s resolves to %s', async (platform, otaRoomName, pmsCode) => {
    const row = await testPrisma.branchOtaRoomMapping.findFirst({
      where: { branchId: cn5, platform: platform as 'AGODA' | 'CTRIP', otaRoomName },
      select: { pmsCode: true, active: true },
    });
    expect(row, `${platform}/${otaRoomName}`).not.toBeNull();
    expect(row!.pmsCode).toBe(pmsCode);
    expect(row!.active).toBe(true);
  });

  it('keeps the two platforms’ rows independent', async () => {
    const rows = await testPrisma.branchOtaRoomMapping.findMany({
      where: { branchId: cn5, otaRoomName: 'Superior Double Room' },
      select: { id: true, platform: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });
});

/* ================================================================== */
/* B. The confirmed CTrip reservation, through the route               */
/* ================================================================== */
describe('CTrip sample through the real route', () => {
  it('returns every field the Admin screen needs', async () => {
    const res = await review({ source: 'CTRIP', rawText: CTRIP_RAW });
    expect(res.status).toBe(200);
    const r = res.body.review;

    expect(r).toMatchObject({
      source: 'CTRIP',
      branchId: cn5,
      branchCode: 'LE_THANH_TON_278',
      requiresManualBranch: false,
      bookingCode: '1658113703317875',
      guestName: 'LEE/JENSON HWEE',
      checkIn: '2026-08-01',
      checkOut: '2026-08-08',
      nights: 7,
      branchPrice: 4_645_956,
      guestBookedPrice: 6_637_080,
      breakfastIncluded: false,
    });
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]).toMatchObject({
      quantity: 1,
      otaRoomName: 'Standard Double Room No Window',
      pmsCode: 'STAN',
      requiresManualMapping: false,
    });
  });

  it('reads the property header printed ABOVE the reservation line', async () => {
    // The detail block starts at "Reservation:", but the property is printed
    // above it. Slicing the page at that line threw the branch away entirely.
    expect(CTRIP_RAW.indexOf('KAS Zody Boutique Hotel')).toBeLessThan(
      CTRIP_RAW.indexOf('Reservation:'),
    );
    const r = (await review({ source: 'CTRIP', rawText: CTRIP_RAW })).body.review;
    expect(r.branchCode).toBe('LE_THANH_TON_278');
  });

  it('reads a price that sits behind a qualifier or a bare currency line', async () => {
    // "Original room rate" / "(incl. taxes and fees)" / "6637080.00" and
    // "Your payout" / "VND" / "4645956.00" — taking the next line blindly gave
    // "(incl. taxes and fees)" and "VND", which parse to no amount at all.
    expect(CTRIP_RAW).toContain('(incl. taxes and fees)');
    expect(CTRIP_RAW).toMatch(/Your payout\r?\nVND/);
    const r = (await review({ source: 'CTRIP', rawText: CTRIP_RAW })).body.review;
    expect(r.branchPrice).toBe(4_645_956);
    expect(r.guestBookedPrice).toBe(6_637_080);
  });

  it('raises no false missing-field warnings', async () => {
    const r = (await review({ source: 'CTRIP', rawText: CTRIP_RAW })).body.review;
    expect(r.warnings).toEqual([]);
    expect(r.blockingReasons).toEqual([]);
    expect(r.noteError).toBeNull();
  });

  it('produces the exact note for each payment mode', async () => {
    const cn = (await review({ source: 'CTRIP', rawText: CTRIP_RAW, overrides: { paymentMode: 'CN' } }))
      .body.review;
    expect(cn.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(cn.canDispatch).toBe(true);

    const hotel = (
      await review({ source: 'CTRIP', rawText: CTRIP_RAW, overrides: { paymentMode: 'HOTEL_PAYMENT' } })
    ).body.review;
    expect(hotel.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN TẠI KHÁCH SẠN\n${CREATED} KHONG AN SANG`,
    );
  });
});

/* ================================================================== */
/* B. The confirmed Agoda booking, through the route                   */
/* ================================================================== */
describe('Agoda sample through the real route', () => {
  it('returns every field the Admin screen needs', async () => {
    const res = await review({ source: 'AGODA', rawText: AGODA_RAW });
    expect(res.status).toBe(200);
    const r = res.body.review;

    expect(r).toMatchObject({
      source: 'AGODA',
      branchId: cn5,
      branchCode: 'LE_THANH_TON_278',
      requiresManualBranch: false,
      bookingCode: '1756224954',
      guestName: 'Nga Đỗ',
      checkIn: '2026-08-04',
      checkOut: '2026-08-05',
      nights: 1,
      branchPrice: 529_537,
      guestBookedPrice: 875_000,
      breakfastIncluded: false,
    });
    expect(r.rooms).toEqual([
      {
        quantity: 1,
        otaRoomName: 'Superior Double Room',
        rawOtaRoomName: 'Superior Double Room',
        otaRoomTypeId: null,
        pmsCode: 'SUP',
        requiresManualMapping: false,
        sourceNightlyTotal: 529_537,
        perRoomNightlyRate: 529_537,
      },
    ]);
  });

  it('reads a bilingual label pair and its value from one line', async () => {
    // "Customer First Name Tên Khách Hàng Nga" — two labels and the value, all
    // separated by SINGLE spaces, so the whole row arrives as one cell.
    expect(AGODA_RAW).toContain('Customer First Name Tên Khách Hàng Nga');
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.guestName).toBe('Nga Đỗ');
  });

  it('reads a value below a vertically stacked label pair', async () => {
    // "Booking ID" / "Mã số đặt phòng" / "1756224954".
    expect(AGODA_RAW).toMatch(/Booking ID\r?\nMã số đặt phòng\r?\n1756224954/);
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.bookingCode).toBe('1756224954');
  });

  it('reads the room row under stacked bilingual headers', async () => {
    // The headers are one per line and the data row is single-spaced:
    // "Superior Double Room 1 2 Adults 0". Read wrongly, the room name
    // swallows the counts and the occupancy becomes the quantity.
    expect(AGODA_RAW).toContain('Superior Double Room 1 2 Adults 0');
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.rooms[0].otaRoomName).toBe('Superior Double Room');
    expect(r.rooms[0].quantity).toBe(1);
  });

  it('reads a nightly row whose amount wrapped onto the next line', async () => {
    expect(AGODA_RAW).toMatch(/August 4, 2026\r?\nVND 529,537\.00/);
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.nightlyRates).toEqual([
      { stayDate: '2026-08-04', amount: 529_537, perRoomAmount: 529_537 },
    ]);
  });

  it('raises no false missing-field warnings', async () => {
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.warnings).toEqual([]);
    expect(r.blockingReasons).toEqual([]);
    expect(r.noteError).toBeNull();
  });

  it('produces the exact note for each payment mode', async () => {
    const cn = (await review({ source: 'AGODA', rawText: AGODA_RAW, overrides: { paymentMode: 'CN' } }))
      .body.review;
    expect(cn.note).toBe('AGD 1756224954_1SUP_1DEM 529.537 CN\nGIÁ KHÁCH ĐẶT 875.000 KHONG AN SANG');
    expect(cn.canDispatch).toBe(true);

    const hotel = (
      await review({ source: 'AGODA', rawText: AGODA_RAW, overrides: { paymentMode: 'HOTEL_PAYMENT' } })
    ).body.review;
    expect(hotel.note).toBe('AGD 1756224954_1SUP_1DEM 529.537 THANH TOÁN TẠI KHÁCH SẠN');
  });
});

/* ================================================================== */
/* C. Values survive the joins between layers                          */
/* ================================================================== */
describe('parsed values survive every layer', () => {
  it('does not let the schema strip a room line’s extra fields', async () => {
    // Zod drops undeclared keys. When the browser echoes a room line back, an
    // undeclared field would survive the first response and vanish on the next
    // edit — indistinguishable from a parser failure.
    const first = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    const echoed = (
      await review({ source: 'AGODA', rawText: AGODA_RAW, overrides: { rooms: first.rooms } })
    ).body.review;

    expect(echoed.rooms[0].rawOtaRoomName).toBe('Superior Double Room');
    expect(echoed.rooms[0].sourceNightlyTotal).toBe(529_537);
    expect(echoed.rooms[0].perRoomNightlyRate).toBe(529_537);
    expect(echoed.rooms[0].pmsCode).toBe('SUP');
  });

  it('keeps every field when a room line resolves to a code', async () => {
    // The resolve path used to REBUILD the line field by field, silently
    // dropping anything not listed there.
    const r = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(r.rooms[0].requiresManualMapping).toBe(false);
    expect(r.rooms[0].rawOtaRoomName).not.toBeUndefined();
    expect(r.rooms[0].sourceNightlyTotal).not.toBeUndefined();
  });

  it('does not let a zero price be replaced by a fallback', async () => {
    // `value || fallback` turns a real 0 into "missing"; `??` does not.
    const r = (
      await review({
        source: 'AGODA',
        rawText: AGODA_RAW,
        overrides: { branchPrice: 0, guestBookedPrice: 0 },
      })
    ).body.review;
    expect(r.branchPrice).toBe(0);
    expect(r.guestBookedPrice).toBe(0);
    expect(r.blockingReasons).not.toContain('Thiếu giá chi nhánh.');
  });
});

/* ================================================================== */
/* D/E. Statelessness and stale drafts                                 */
/* ================================================================== */
describe('the review is stateless', () => {
  it('writes nothing, so re-submitting the same text gives the same answer', async () => {
    const before = await testPrisma.booking.count();
    const first = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    const second = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;

    expect(second).toEqual(first);
    // No draft is stored, so there is no stale draft to go out of date.
    expect(await testPrisma.booking.count()).toBe(before);
  });

  it('does not carry an override from one request into the next', async () => {
    await review({
      source: 'AGODA',
      rawText: AGODA_RAW,
      overrides: { guestName: 'SOMEONE ELSE', branchPrice: 1 },
    });
    const fresh = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(fresh.guestName).toBe('Nga Đỗ');
    expect(fresh.branchPrice).toBe(529_537);
  });

  it('re-extracts authoritative values rather than keeping stale nulls', async () => {
    // A previously-empty screen must not pin the fields to null: omitting an
    // override means "I did not touch this", so the parsed value returns.
    const stale = (
      await review({ source: 'AGODA', rawText: AGODA_RAW, overrides: { branchPrice: null } })
    ).body.review;
    expect(stale.branchPrice).toBeNull();

    const resubmitted = (await review({ source: 'AGODA', rawText: AGODA_RAW })).body.review;
    expect(resubmitted.branchPrice).toBe(529_537);
    expect(resubmitted.checkIn).toBe('2026-08-04');
  });

  it('preserves a genuine Admin correction for as long as it is sent', async () => {
    const r = (
      await review({
        source: 'AGODA',
        rawText: AGODA_RAW,
        overrides: { guestName: 'NGA DO (corrected)' },
      })
    ).body.review;
    expect(r.guestName).toBe('NGA DO (corrected)');
    // Everything the Admin did NOT touch still comes from the text.
    expect(r.bookingCode).toBe('1756224954');
    expect(r.branchPrice).toBe(529_537);
  });
});

/* ================================================================== */
/* H. Whitespace the browser really produces                           */
/* ================================================================== */
describe('whitespace variants', () => {
  const variants: [string, (s: string) => string][] = [
    ['LF', (s) => s],
    ['CRLF', (s) => s.replace(/\n/g, '\r\n')],
    ['non-breaking spaces', (s) => s.replace(/ /g, ' ')],
    ['trailing spaces', (s) => s.split('\n').map((l) => `${l}   `).join('\n')],
    ['blank lines doubled', (s) => s.replace(/\n\n/g, '\n\n\n')],
  ];

  it.each(variants)('CTrip survives %s', async (_name, transform) => {
    const r = (await review({ source: 'CTRIP', rawText: transform(CTRIP_RAW) })).body.review;
    expect(r.bookingCode).toBe('1658113703317875');
    expect(r.checkIn).toBe('2026-08-01');
    expect(r.branchPrice).toBe(4_645_956);
    expect(r.guestBookedPrice).toBe(6_637_080);
    expect(r.rooms[0].pmsCode).toBe('STAN');
  });

  it.each(variants)('Agoda survives %s', async (_name, transform) => {
    const r = (await review({ source: 'AGODA', rawText: transform(AGODA_RAW) })).body.review;
    expect(r.bookingCode).toBe('1756224954');
    expect(r.guestName).toBe('Nga Đỗ');
    expect(r.checkIn).toBe('2026-08-04');
    expect(r.branchPrice).toBe(529_537);
    expect(r.rooms[0].pmsCode).toBe('SUP');
  });

  it('Agoda survives a tab-separated bilingual row', async () => {
    // An HTML-table paste separates the columns with tabs instead of spaces.
    const tabbed = AGODA_RAW
      .replace(/^(Customer First Name) (Tên Khách Hàng) (.*)$/m, '$1\t$2\t$3')
      .replace(/^(Customer Last Name) (Họ Khách Hàng) (.*)$/m, '$1\t$2\t$3')
      .replace(/^(Check-in) (Nhận phòng) (.*)$/m, '$1\t$2\t$3')
      .replace(/^(Check-out) (Trả phòng) (.*)$/m, '$1\t$2\t$3')
      .replace(/^(Superior Double Room) 1 (2 Adults) 0$/m, '$1\t1\t$2\t0');

    const r = (await review({ source: 'AGODA', rawText: tabbed })).body.review;
    expect(r.guestName).toBe('Nga Đỗ');
    expect(r.checkIn).toBe('2026-08-04');
    expect(r.checkOut).toBe('2026-08-05');
    expect(r.rooms[0].otaRoomName).toBe('Superior Double Room');
    expect(r.rooms[0].quantity).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('does not accept an empty or whitespace-only paste', async () => {
    expect((await review({ source: 'AGODA', rawText: '' })).status).toBe(422);
  });
});

/* ================================================================== */
/* Source routing                                                      */
/* ================================================================== */
describe('source routing', () => {
  it('rejects a source that is not one of the two exact enum values', async () => {
    for (const source of ['Agoda', 'CTrip', 'CTRIP.COM', 'TRIP', 'UNKNOWN', 'BOOKING_COM']) {
      expect((await review({ source, rawText: CTRIP_RAW })).status, source).toBe(422);
    }
  });

  it('keeps each platform on its own parser', async () => {
    // The same text read as the other platform must not silently succeed.
    const asAgoda = (await review({ source: 'AGODA', rawText: CTRIP_RAW })).body.review;
    expect(asAgoda.bookingCode).not.toBe('1658113703317875');
  });
});
