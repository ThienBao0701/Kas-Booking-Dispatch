/**
 * Booking.com end-to-end regression guard.
 *
 * Booking.com was already operational before any OTA work began, and the OTA
 * phases have repeatedly touched shared ground: the parser signature, the
 * branch resolver, the room-mapping tables, the note builders. This file exists
 * so that a change made for Agoda or CTrip cannot quietly alter what a
 * Booking.com reservation does.
 *
 * It asserts the whole path a real booking travels — extraction, payment
 * classification, branch assignment, PMS note, dispatch, branch-scoped
 * visibility — and it asserts one negative that the other suites cannot: the
 * OTA note builder is never reached from the Booking.com path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { parseBooking } from '../src/booking/parser';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import * as otaPmsNote from '../src/booking/otaPmsNote';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';

/** A real, anonymised Booking.com extranet page already in the fixtures. */
const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'booking', '24-real-sample-extranet.txt'),
  'utf8',
);

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();

  // Fixture 24 carries CN6's current Booking.com public name.
  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'BUI_THI_XUAN_40' } })).id;
  const otherBranchId = (
    await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })
  ).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(ownBranchId, { username: 'letan_bcom', mustChangePassword: false });
  ownAgent = (await loginAgent(app, 'letan_bcom', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(otherBranchId, { username: 'letan_other_bcom', mustChangePassword: false });
  otherAgent = (await loginAgent(app, 'letan_other_bcom', RECEPTIONIST_PASSWORD)).agent;
});

afterAll(async () => testPrisma.$disconnect());

describe('Booking.com — parsing is unchanged', () => {
  it('assigns the branch from the current Booking.com identity, confidently', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseBooking(RAW, configs);

    expect(parsed.suggestedBranch?.code).toBe('BUI_THI_XUAN_40');
    expect(parsed.branchConfident).toBe(true);
    expect(parsed.requiresManualConfirmation).toBe(false);
    expect(parsed.branchConfidence).toBe(100);
  });

  it('extracts the same operational fields', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseBooking(RAW, configs);

    expect(parsed.bookingCode).toBeTruthy();
    expect(parsed.guestName).toBeTruthy();
    expect(parsed.checkIn).toBeTruthy();
    expect(parsed.checkOut).toBeTruthy();
    expect(parsed.rooms.length).toBeGreaterThan(0);
    // Nightly rows are one per stay date, check-out exclusive.
    for (const room of parsed.rooms) {
      for (const night of room.nights) {
        expect(night.stayDate >= parsed.checkIn!).toBe(true);
        expect(night.stayDate < parsed.checkOut!).toBe(true);
      }
    }
  });

  it('stamps the Booking.com parser, never an OTA one', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseBooking(RAW, configs);
    expect(parsed.parserVersion).not.toContain('agoda');
    expect(parsed.parserVersion).not.toContain('ctrip');
    // The OTA-only structures stay absent.
    expect(parsed.agoda).toBeUndefined();
    expect(parsed.ctrip).toBeUndefined();
  });

  it('preserves PAY BEFORE / PAY AFTER classification both ways', async () => {
    const configs = await loadBranchConfigs(testPrisma);

    const payAfter = parseBooking(
      ['Ben Thanh Market - Luxury Kas Boutique Hotel - Thai Cuisine Restaurant',
       'Mã đặt phòng: 4444555566',
       'Khách: Nguyễn Văn A',
       'Nhận phòng: 2026-09-01',
       'Trả phòng: 2026-09-02',
       'Phòng 1: Standard Room',
       '2026-09-01: 500.000 VND',
       'Thanh toán: Thanh toán tại chỗ'].join('\n'),
      configs,
    );
    expect(payAfter.paymentStatus).toBe('PAY_AFTER');

    const payBefore = parseBooking(
      ['Ben Thanh Market - Luxury Kas Boutique Hotel - Thai Cuisine Restaurant',
       'Mã đặt phòng: 4444555577',
       'Khách: Nguyễn Văn B',
       'Nhận phòng: 2026-09-01',
       'Trả phòng: 2026-09-02',
       'Phòng 1: Standard Room',
       '2026-09-01: 500.000 VND',
       // The real PAY_BEFORE trigger: Booking.com hides the card details when
       // it has already collected payment.
       'Quý vị không có quyền xem chi tiết thẻ tín dụng này.'].join('\n'),
      configs,
    );
    expect(payBefore.paymentStatus).toBe('PAY_BEFORE');
  });
});

/**
 * Extract, then send — the whole Booking.com path as an operator walks it.
 *
 * The review used to be an editable DRAFT and the send a state transition on it.
 * It is now one transactional create at the end of an in-browser review, so this
 * helper stands in for the review screen: it takes the preview, picks the
 * branch's internal room codes, and sends.
 */
async function extractAndSend(rawText: string, branchId: number) {
  const extract = await adminAgent
    .post('/api/bookings/extract')
    .send({ rawText, source: 'BOOKING_COM' });
  expect(extract.status).toBe(201);
  expect(extract.body.booking.sourcePlatform).toBe('BOOKING_COM');

  const roomClass = await testPrisma.branchRoomClass.findFirstOrThrow({
    where: { branchId, active: true, version: { status: 'ACTIVE' } },
  });

  const sent = await adminAgent.post('/api/admin/bookings/dispatch').send({
    rawText,
    branchId,
    hotelName: extract.body.booking.hotelName,
    customerName: extract.body.booking.guestName ?? '',
    phone: extract.body.booking.phone,
    bookingCode: extract.body.booking.bookingCode ?? '',
    checkInDate: extract.body.booking.checkIn,
    checkOutDate: extract.body.booking.checkOut,
    totalAmount: extract.body.booking.totalAmount,
    paymentStatus: extract.body.booking.paymentStatus,
    specialRequest: extract.body.booking.specialRequest,
    rooms: extract.body.rooms.map(
      (r: { roomIndex: number; roomName: string | null; roomTotal: number | null; nights: unknown[] }) => ({
        roomIndex: r.roomIndex,
        roomType: r.roomName,
        roomSubtotal: r.roomTotal,
        roomClassId: roomClass.id,
        nights: r.nights,
      }),
    ),
    acknowledgedWarningCodes: [
      'MISSING_PHONE',
      'MISSING_TOTAL',
      'NULL_NIGHTLY_PRICE',
      'MISSING_ROOM_TYPE',
      'NIGHTLY_SUBTOTAL_MISMATCH',
      'ROOM_TOTAL_MISMATCH',
      'LOW_CONFIDENCE_BRANCH',
      'UNRESOLVED_EXTRACT_WARNINGS',
    ],
  });
  return { extract, sent };
}

describe('Booking.com — never touches the OTA note builder', () => {
  it('extraction and dispatch call buildOtaPmsNote zero times', async () => {
    const spy = vi.spyOn(otaPmsNote, 'buildOtaPmsNote');
    try {
      const { sent } = await extractAndSend(RAW, ownBranchId);
      // Asserted, so this negative is proved against a dispatch that SUCCEEDED
      // rather than one that never got far enough to call anything.
      expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Booking.com — dispatch and branch-scoped visibility are unchanged', () => {
  it('dispatches through the existing path and reaches only its own branch', async () => {
    // The branch this fixture resolves to, by exact identity match — surfaced in
    // the preview now instead of pre-written onto a draft.
    const { extract, sent } = await extractAndSend(RAW, ownBranchId);
    expect(extract.body.suggestedBranch.id).toBe(ownBranchId);
    expect(extract.body.branchConfident).toBe(true);

    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);
    const bookingId = sent.body.booking.id as string;
    expect(sent.body.booking.status).toBe('NEW');
    expect(sent.body.booking.branch.code).toBe('BUI_THI_XUAN_40');

    const stored = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(stored.branchId).toBe(ownBranchId);
    expect(stored.sourcePlatform).toBe('BOOKING_COM');

    // Its own receptionist sees it…
    const inbox = await ownAgent.get('/api/bookings/new');
    expect(inbox.body.bookings.map((b: { id: string }) => b.id)).toContain(bookingId);

    // …and no one else does, by list or by id.
    const otherInbox = await otherAgent.get('/api/bookings/new');
    expect(otherInbox.body.bookings.map((b: { id: string }) => b.id)).not.toContain(bookingId);
    expect((await otherAgent.get(`/api/bookings/${bookingId}`)).status).toBe(403);
  });

  it('keeps the proof workflow reachable for the assigned receptionist', async () => {
    const { sent } = await extractAndSend(RAW, ownBranchId);
    expect(sent.status).toBe(201);
    const bookingId = sent.body.booking.id as string;

    const detail = await ownAgent.get(`/api/bookings/${bookingId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking.verificationStatus).toBe('NOT_SUBMITTED');
    // A receptionist never receives the raw OTA source text.
    expect(detail.body.booking.rawText).toBeUndefined();
  });
});
