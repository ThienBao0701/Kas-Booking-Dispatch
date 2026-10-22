/**
 * Stage identity: the same Agoda email must produce the SAME values at every
 * stage of the production pipeline.
 *
 *   parser  ->  field mapper  ->  review  ->  HTTP JSON  ->  PMS note
 *
 * Each earlier phase found a defect at a JOIN rather than inside a stage: a
 * mapper that emitted one room line out of three, a schema that stripped an
 * undeclared key, a resolver that rebuilt an object field by field. Those are
 * invisible to tests that assert one stage against a hand-written expectation,
 * because the expectation is written to match whatever that stage does.
 *
 * These tests therefore assert stages against EACH OTHER, not against
 * constants: whatever the parser read is what the route must return, and what
 * the route returns is what the note must be built from. A value that changes
 * between two stages fails here even if nobody knew what it should have been.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';
import { parseAgodaPartnerBooking } from '../src/booking/agodaPartner';
import { parseAgodaBooking } from '../src/booking/agoda';
import { agodaParsedFields } from '../src/booking/otaReviewService';

const raw = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'agoda', name), 'utf8');

/** Sanitized copies of the real layouts, plus the synthetic multi-room case. */
const SAMPLES: [string, string][] = [
  ['single reservation after a list page', raw('10-list-page-above-reservation.txt')],
  ['amended thread', raw('09-amended-thread-two-bookings.txt')],
  ['multi room types (synthetic)', raw('11-SYNTHETIC-multi-room-types.txt')],
  ['bilingual inline', raw('08-real-bilingual-inline.txt')],
  ['bilingual wrapped', raw('07-real-bilingual-wrapped.txt')],
];

let app: ReturnType<typeof createApp>;
let agent: Awaited<ReturnType<typeof loginAgent>>['agent'];

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  agent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

afterAll(async () => testPrisma.$disconnect());

const post = (body: Record<string, unknown>) =>
  agent.post('/api/admin/ota/review').send(body);

/* ================================================================== */
/* Parser == mapper == route JSON                                      */
/* ================================================================== */
describe.each(SAMPLES)('%s', (_label, text) => {
  it('carries the parser’s values unchanged to the HTTP response', async () => {
    const parsed = parseAgodaPartnerBooking(text);
    const res = await post({ source: 'AGODA', rawText: text });
    expect(res.status).toBe(200);
    const review = res.body.review;

    // Identity, guest and stay: whatever the parser read is what is returned.
    expect(review.bookingCode).toBe(parsed.bookingId);
    expect(review.guestName).toBe(parsed.customerFullName);
    expect(review.checkIn).toBe(parsed.checkIn);
    expect(review.checkOut).toBe(parsed.checkOut);
    expect(review.nights).toBe(parsed.nights);

    // Money: never rounded, scaled, divided or defaulted between stages.
    expect(review.branchPrice).toBe(parsed.netRate);
    expect(review.guestBookedPrice).toBe(parsed.referenceSellRate);
  });

  it('loses no room line between the parser and the response', async () => {
    const parsed = parseAgodaPartnerBooking(text);
    const review = (await post({ source: 'AGODA', rawText: text })).body.review;

    expect(review.rooms).toHaveLength(parsed.roomLines.length);
    expect(review.rooms.map((r: { otaRoomName: string }) => r.otaRoomName)).toEqual(
      parsed.roomLines.map((r) => r.roomTypeNormalized),
    );
    expect(review.rooms.map((r: { quantity: number }) => r.quantity)).toEqual(
      parsed.roomLines.map((r) => r.quantity),
    );
    // The raw name is preserved for audit alongside the mapping key.
    expect(review.rooms.map((r: { rawOtaRoomName: string }) => r.rawOtaRoomName)).toEqual(
      parsed.roomLines.map((r) => r.roomTypeOriginal),
    );
  });

  it('agrees with the field mapper it is built from', async () => {
    const mapped = agodaParsedFields(parseAgodaBooking(text, []), null);
    const review = (await post({ source: 'AGODA', rawText: text })).body.review;

    expect(review.bookingCode).toBe(mapped.bookingCode);
    expect(review.guestName).toBe(mapped.guestName);
    expect(review.checkIn).toBe(mapped.checkIn);
    expect(review.checkOut).toBe(mapped.checkOut);
    expect(review.branchPrice).toBe(mapped.branchPrice);
    expect(review.guestBookedPrice).toBe(mapped.guestBookedPrice);
    expect(review.nightlyRates).toEqual(mapped.nightlyRates);
  });

  it('never invents a nightly row the parser did not read', async () => {
    const parsed = parseAgodaPartnerBooking(text);
    const review = (await post({ source: 'AGODA', rawText: text })).body.review;

    expect(review.nightlyRates).toHaveLength(parsed.nightlyRates.length);
    expect(review.nightlyRates.map((n: { stayDate: string }) => n.stayDate)).toEqual(
      parsed.nightlyRates.map((n) => n.stayDate),
    );
    expect(review.nightlyRates.map((n: { amount: number }) => n.amount)).toEqual(
      parsed.nightlyRates.map((n) => n.amount),
    );
  });

  it('reports breakfast false at every stage', async () => {
    expect(parseAgodaPartnerBooking(text).breakfastIncluded).toBe(false);
    const review = (await post({ source: 'AGODA', rawText: text })).body.review;
    expect(review.breakfastIncluded).toBe(false);
  });
});

/* ================================================================== */
/* The note is built from exactly what the response shows              */
/* ================================================================== */
describe('the PMS note matches the values on screen', () => {
  const SAMPLE = raw('10-list-page-above-reservation.txt');

  /** Formats whole VND the way the note does, for cross-checking. */
  const dots = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  it('states the same booking code, rooms, nights and price the review shows', async () => {
    const review = (
      await post({ source: 'AGODA', rawText: SAMPLE, overrides: { paymentMode: 'CN' } })
    ).body.review;

    expect(review.note).not.toBeNull();
    // Every component of the note is a value the Admin can see on the screen.
    expect(review.note).toContain(review.bookingCode);
    expect(review.note).toContain(`${review.nights}DEM`);
    expect(review.note).toContain(dots(review.branchPrice));
    expect(review.note).toContain(dots(review.guestBookedPrice));
    for (const room of review.rooms) {
      expect(review.note).toContain(`${room.quantity}${room.pmsCode}`);
    }
    // Breakfast is false everywhere, so the note always says so.
    expect(review.note).toContain('KHONG AN SANG');
  });

  it('changes only the payment phrase between the two modes', async () => {
    const cn = (await post({ source: 'AGODA', rawText: SAMPLE, overrides: { paymentMode: 'CN' } }))
      .body.review;
    const hotel = (
      await post({ source: 'AGODA', rawText: SAMPLE, overrides: { paymentMode: 'HOTEL_PAYMENT' } })
    ).body.review;

    // The first line's booking/room/night/price segment is identical.
    const segment = (note: string) => note.split('\n')[0]!.replace(/ (CN|THANH TOÁN TẠI KHÁCH SẠN)$/, '');
    expect(segment(hotel.note)).toBe(segment(cn.note));
    expect(cn.note.split('\n')[0]).toMatch(/ CN$/);
    expect(hotel.note).toMatch(/ THANH TOÁN TẠI KHÁCH SẠN$/);
    // Everything else the review reports is unchanged by the payment mode.
    expect(hotel.branchPrice).toBe(cn.branchPrice);
    expect(hotel.guestName).toBe(cn.guestName);
    expect(hotel.rooms).toEqual(cn.rooms);
  });

  it('withholds the note rather than emitting a partial one', async () => {
    // A room with no internal code cannot produce a note, and must not produce
    // a truncated one either.
    const unmapped = SAMPLE.replace('Superior Double Room\t1', 'Nonexistent Room Type\t1');
    const review = (await post({ source: 'AGODA', rawText: unmapped })).body.review;

    expect(review.rooms[0].requiresManualMapping).toBe(true);
    expect(review.note).toBeNull();
    expect(review.canDispatch).toBe(false);
    expect(review.noteError).not.toBeNull();
  });
});

/* ================================================================== */
/* Round trip: the browser sends the review back unchanged             */
/* ================================================================== */
describe('a round trip through the browser changes nothing', () => {
  const SAMPLE = raw('11-SYNTHETIC-multi-room-types.txt');

  it('returns identical values when the response is echoed as overrides', async () => {
    // The panel re-posts the review on every edit. Echoing it back untouched
    // must be a no-op — otherwise a value decays each time an Admin types.
    const first = (await post({ source: 'AGODA', rawText: SAMPLE })).body.review;
    const second = (
      await post({
        source: 'AGODA',
        rawText: SAMPLE,
        overrides: {
          bookingCode: first.bookingCode,
          guestName: first.guestName,
          checkIn: first.checkIn,
          checkOut: first.checkOut,
          rooms: first.rooms,
          branchPrice: first.branchPrice,
          guestBookedPrice: first.guestBookedPrice,
          paymentMode: first.paymentMode,
        },
      })
    ).body.review;

    expect(second.bookingCode).toBe(first.bookingCode);
    expect(second.guestName).toBe(first.guestName);
    expect(second.checkIn).toBe(first.checkIn);
    expect(second.checkOut).toBe(first.checkOut);
    expect(second.branchPrice).toBe(first.branchPrice);
    expect(second.guestBookedPrice).toBe(first.guestBookedPrice);
    expect(second.rooms).toEqual(first.rooms);
    expect(second.note).toBe(first.note);
  });

  it('survives ten consecutive round trips without drift', async () => {
    let current = (await post({ source: 'AGODA', rawText: SAMPLE })).body.review;
    const original = current;

    for (let i = 0; i < 10; i += 1) {
      current = (
        await post({
          source: 'AGODA',
          rawText: SAMPLE,
          overrides: {
            rooms: current.rooms,
            branchPrice: current.branchPrice,
            guestBookedPrice: current.guestBookedPrice,
            guestName: current.guestName,
          },
        })
      ).body.review;
    }

    expect(current.rooms).toEqual(original.rooms);
    expect(current.branchPrice).toBe(original.branchPrice);
    expect(current.guestBookedPrice).toBe(original.guestBookedPrice);
    expect(current.guestName).toBe(original.guestName);
  });
});

/* ================================================================== */
/* The branch is never mutated                                         */
/* ================================================================== */
describe('branch identity', () => {
  const SAMPLE = raw('10-list-page-above-reservation.txt');

  it('matches the property the parser read', async () => {
    const parsed = parseAgodaPartnerBooking(SAMPLE);
    expect(parsed.sourceHotelName).toBe('KAS Zody Boutique Hotel');

    const review = (await post({ source: 'AGODA', rawText: SAMPLE })).body.review;
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { id: review.branchId } });
    expect(branch.code).toBe('LE_THANH_TON_278');
    expect(review.branchCode).toBe(branch.code);
    expect(review.branchAddress).toBe(branch.address);
  });

  it('honours an Admin branch change without altering anything else', async () => {
    const before = (await post({ source: 'AGODA', rawText: SAMPLE })).body.review;
    const cn1 = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } });

    const after = (
      await post({ source: 'AGODA', rawText: SAMPLE, overrides: { branchId: cn1.id } })
    ).body.review;

    expect(after.branchCode).toBe('TRUONG_DINH_05');
    // The reservation itself is untouched by the branch change.
    expect(after.bookingCode).toBe(before.bookingCode);
    expect(after.guestName).toBe(before.guestName);
    expect(after.branchPrice).toBe(before.branchPrice);
    expect(after.checkIn).toBe(before.checkIn);
  });
});
