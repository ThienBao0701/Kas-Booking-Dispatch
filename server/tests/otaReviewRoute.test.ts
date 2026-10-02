/**
 * The OTA review endpoint.
 *
 * This is where the browser meets the server, so the tests here are mostly
 * about what the server REFUSES to take on trust: a branch the client names, a
 * PMS code the client proposes, a platform the client claims. The note and the
 * dispatch decision are computed server-side from the database every time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { hcmDayMonthDots } from '../src/booking/otaPmsNote';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';

const CTRIP_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ctrip', '04-confirmed-partner-reservation.txt'),
  'utf8',
);

/** CTrip's second line is the creation day — today for a review built now. */
const CREATED = hcmDayMonthDots(new Date());

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
const branchIdByCode = new Map<string, number>();

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  for (const code of ['TRUONG_DINH_05', 'LE_THANH_TON_278', 'NGUYEN_THAI_BINH_170']) {
    branchIdByCode.set(
      code,
      (await testPrisma.branch.findUniqueOrThrow({ where: { code } })).id,
    );
  }
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(branchIdByCode.get('TRUONG_DINH_05')!, {
    username: 'letan_review',
    mustChangePassword: false,
  });
  receptionAgent = (await loginAgent(app, 'letan_review', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  // Nothing to reset: the review endpoint writes nothing.
});

afterAll(async () => testPrisma.$disconnect());

const review = (body: Record<string, unknown>) =>
  adminAgent.post('/api/admin/ota/review').send(body);

/**
 * The confirmed CTrip reservation names its room in ENGLISH ("Standard Double
 * Room No Window"), while the seeded CTrip mappings carry the Vietnamese Agoda
 * names — no real CTrip room names have been supplied yet. So the sample's room
 * is legitimately UNMAPPED, and an Admin has to map it. This is that correction.
 */
const MAPPED_ROOM = {
  quantity: 1,
  otaRoomName: 'Standard Double Room No Window',
  otaRoomTypeId: null,
  pmsCode: 'STAN',
  requiresManualMapping: false,
};

/* ================================================================== */
/* CTrip through the real endpoint                                     */
/* ================================================================== */

describe('CTrip review endpoint', () => {
  it('resolves the branch, every field and the room from the seeded aliases', async () => {
    const res = await review({ source: 'CTRIP', rawText: CTRIP_RAW });
    expect(res.status).toBe(200);

    const r = res.body.review;
    expect(r.source).toBe('CTRIP');
    expect(r.branchCode).toBe('LE_THANH_TON_278');
    expect(r.requiresManualBranch).toBe(false);
    expect(r.bookingCode).toBe('1658113703317875');
    expect(r.guestName).toBe('LEE/JENSON HWEE');
    expect(r.nights).toBe(7);
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0].otaRoomName).toBe('Standard Double Room No Window');
    expect(r.branchPrice).toBe(4_645_956); // Your payout
    expect(r.guestBookedPrice).toBe(6_637_080); // Original room rate
    expect(r.nightlyRates).toEqual([]); // CTrip states none

    // The English name CTrip actually prints is now a seeded CN5 alias, so it
    // resolves without an Admin having to map it by hand. It is still resolved
    // through THIS BRANCH's mappings — the name alone decides nothing.
    expect(r.rooms[0].pmsCode).toBe('STAN');
    expect(r.rooms[0].requiresManualMapping).toBe(false);
    expect(r.canDispatch).toBe(true);
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.blockingReasons).toEqual([]);
    expect(r.breakfastIncluded).toBe(false);
  });

  it('produces the exact CN note once the Admin maps the room', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { rooms: [MAPPED_ROOM] },
    });
    const r = res.body.review;
    expect(r.rooms[0].pmsCode).toBe('STAN');
    expect(r.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(r.canDispatch).toBe(true);
  });

  it('switches to the exact hotel-payment note, keeping both lines', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { paymentMode: 'HOTEL_PAYMENT', rooms: [MAPPED_ROOM] },
    });
    const note = res.body.review.note as string;
    expect(note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN TẠI KHÁCH SẠN\n${CREATED} KHONG AN SANG`,
    );
    expect(note.split('\n')).toHaveLength(2);
    expect(note).not.toContain('GIÁ KHÁCH ĐẶT');
  });

  it('requires a manual branch when CTrip states no Property name', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: ['Reservation: 777', 'Guest: A B', 'Check-in: 01/08/2026', 'Check-out: 02/08/2026'].join('\n'),
    });
    const r = res.body.review;
    expect(r.requiresManualBranch).toBe(true);
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Chưa chọn chi nhánh.');
  });

  it('lets the Admin pick the branch, which then resolves the mapping', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: ['Reservation: 777', 'Guest: A B', 'Check-in: 01/08/2026', 'Check-out: 08/08/2026',
                'Room type: Phòng Tiêu Chuẩn Không Có Cửa Sổ (Giường Đôi)', 'Your payout: 1000000',
                'Original room rate: 1500000', 'Meals: No meals'].join('\n'),
      overrides: { branchId: branchIdByCode.get('LE_THANH_TON_278') },
    });
    const r = res.body.review;
    expect(r.branchCode).toBe('LE_THANH_TON_278');
    expect(r.rooms[0].pmsCode).toBe('STAN');
    expect(r.canDispatch).toBe(true);
  });
});

/* ================================================================== */
/* The server refuses what the client asserts                          */
/* ================================================================== */

describe('the server is the authority', () => {
  it('rejects a PMS code the selected branch does not have', async () => {
    // CN4 has no STAN. A browser claiming otherwise must not be believed.
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: {
        branchId: branchIdByCode.get('NGUYEN_THAI_BINH_170'),
        rooms: [
          {
            quantity: 1,
            otaRoomName: 'Standard Double Room No Window',
            otaRoomTypeId: null,
            pmsCode: 'STAN',
            requiresManualMapping: false,
          },
        ],
      },
    });
    const r = res.body.review;
    expect(r.rooms[0].requiresManualMapping).toBe(true);
    expect(r.canDispatch).toBe(false);
    expect(r.note).toBeNull();
    expect(res.body.validPmsCodes).not.toContain('STAN');
  });

  it('accepts a code the branch really has', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: {
        branchId: branchIdByCode.get('NGUYEN_THAI_BINH_170'),
        rooms: [
          {
            quantity: 2,
            otaRoomName: 'Standard Double Room No Window',
            otaRoomTypeId: null,
            pmsCode: 'DEL12',
            requiresManualMapping: false,
          },
        ],
      },
    });
    const r = res.body.review;
    expect(r.rooms[0].pmsCode).toBe('DEL12');
    expect(r.canDispatch).toBe(true);
    expect(r.note).toContain('_2DEL12_7DEM');
  });

  it('CN4 leaves a Standard-like room unresolved when not corrected', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { branchId: branchIdByCode.get('NGUYEN_THAI_BINH_170') },
    });
    const r = res.body.review;
    expect(r.rooms[0].pmsCode).toBeNull();
    expect(r.canDispatch).toBe(false);
    expect(r.blockingReasons).toContain('Còn hạng phòng chưa gán mã nội bộ.');
  });

  it('refuses an inactive or unknown branch', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { branchId: 999_999 },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a platform that has no review workflow', async () => {
    for (const source of ['BOOKING_COM', 'TRIPADVISOR', 'TRAVELOKA']) {
      const res = await review({ source, rawText: CTRIP_RAW });
      expect(res.status, source).toBe(422);
    }
  });

  it('offers only the selected branch valid codes for the manual selector', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { branchId: branchIdByCode.get('NGUYEN_THAI_BINH_170') },
    });
    const codes = res.body.validPmsCodes as string[];
    expect(codes).toContain('SUP');
    expect(codes).toContain('DEL12');
    expect(codes).not.toContain('STAN'); // CN4 genuinely has none
  });

  it('lists every active branch so a wrong match can always be corrected', async () => {
    const res = await review({ source: 'CTRIP', rawText: CTRIP_RAW });
    const options = res.body.branchOptions as { code: string }[];
    expect(options.length).toBeGreaterThanOrEqual(8);
    expect(options.map((o) => o.code)).toContain('NGUYEN_THAI_BINH_170');
  });
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('authorization', () => {
  it('is Admin-only', async () => {
    const res = await receptionAgent
      .post('/api/admin/ota/review')
      .send({ source: 'CTRIP', rawText: CTRIP_RAW });
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const anon = await import('supertest').then((m) => m.default(app));
    const res = await anon.post('/api/admin/ota/review').send({ source: 'CTRIP', rawText: CTRIP_RAW });
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* Admin corrections and validation                                    */
/* ================================================================== */

describe('Admin corrections', () => {
  it('applies edited prices to the note immediately', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { branchPrice: 5_000_000, guestBookedPrice: 7_000_000, rooms: [MAPPED_ROOM] },
    });
    // The branch price reaches the note. The guest-booked price no longer
    // appears on a CTrip note at all, edited or not.
    expect(res.body.review.note).toBe(
      `CTRIP_1658113703317875_1STAN_7DEM 5.000.000 CN\n${CREATED} KHONG AN SANG`,
    );
    expect(res.body.review.note).not.toContain('7.000.000');
  });

  it('supports adding a second room line', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: {
        rooms: [
          {
            quantity: 1,
            otaRoomName: 'Standard Double Room No Window',
            otaRoomTypeId: null,
            pmsCode: 'STAN',
            requiresManualMapping: false,
          },
          {
            quantity: 2,
            otaRoomName: 'Phòng Superior Có Cửa Sổ (Giường Queen)',
            otaRoomTypeId: null,
            pmsCode: 'SUP',
            requiresManualMapping: false,
          },
        ],
      },
    });
    expect(res.body.review.note).toContain('_1STAN_2SUP_7DEM');
  });

  it('dispatches a CTrip reservation with no guest-booked price, in either mode', async () => {
    // The figure no longer reaches a CTrip note, so it can no longer block one.
    for (const paymentMode of ['CN', 'HOTEL_PAYMENT'] as const) {
      const res = await review({
        source: 'CTRIP',
        rawText: CTRIP_RAW,
        overrides: { guestBookedPrice: null, paymentMode, rooms: [MAPPED_ROOM] },
      });
      expect(res.body.review.canDispatch, paymentMode).toBe(true);
      expect(res.body.review.blockingReasons, paymentMode).toEqual([]);
      expect(res.body.review.note, paymentMode).toContain(`\n${CREATED} KHONG AN SANG`);
    }
  });

  it('rejects a malformed override rather than coercing it', async () => {
    const res = await review({
      source: 'CTRIP',
      rawText: CTRIP_RAW,
      overrides: { branchPrice: -5 },
    });
    expect(res.status).toBe(422);
  });
});
