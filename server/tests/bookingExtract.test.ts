import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];

const SINGLE_ROOM = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 1234567890
Khách: Nguyễn Văn A
Điện thoại: 0901234567
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-20: 850.000 VND
2026-07-21: 950.000 VND
Tổng cộng: 2.650.000 VND
Thanh toán: Thanh toán tại chỗ`;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/**
 * Everything a Booking.com extraction used to write before anyone had decided
 * the order was worth sending.
 */
async function persistedCounts() {
  const [bookings, rooms, nights, warnings] = await Promise.all([
    testPrisma.booking.count(),
    testPrisma.bookingRoom.count(),
    testPrisma.bookingNightPrice.count(),
    testPrisma.bookingExtractWarning.count(),
  ]);
  return { bookings, rooms, nights, warnings };
}

const NOTHING = { bookings: 0, rooms: 0, nights: 0, warnings: 0 };

/**
 * Sends a previewed reservation the way the review screen does, so the cases
 * that used to assert "extract persisted X" can assert "SEND persists X" — the
 * same business intent, measured at the moment the record is actually made.
 */
async function dispatchPreview(res: { body: Record<string, unknown> }) {
  const body = res.body as {
    booking: Record<string, unknown>;
    suggestedBranch: { id: number } | null;
    rooms: { roomIndex: number; roomName: string | null; roomTotal: number | null; nights: { stayDate: string; amount: number | null }[] }[];
  };
  const branchId =
    body.suggestedBranch?.id ?? (await testPrisma.branch.findFirstOrThrow({ where: { active: true } })).id;
  const mapping = await testPrisma.branchRoomClass.findFirstOrThrow({
    where: { branchId, active: true, version: { status: 'ACTIVE' } },
  });

  return adminAgent.post('/api/admin/bookings/dispatch').send({
    rawText: body.booking.rawTextEcho ?? SINGLE_ROOM,
    branchId,
    hotelName: body.booking.hotelName,
    customerName: body.booking.guestName ?? '',
    phone: body.booking.phone,
    bookingCode: body.booking.bookingCode ?? '',
    checkInDate: body.booking.checkIn,
    checkOutDate: body.booking.checkOut,
    totalAmount: body.booking.totalAmount,
    paymentStatus: body.booking.paymentStatus,
    specialRequest: body.booking.specialRequest,
    rooms: body.rooms.map((room) => ({
      roomIndex: room.roomIndex,
      roomType: room.roomName,
      roomSubtotal: room.roomTotal,
      roomClassId: mapping.id,
      nights: room.nights,
    })),
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
}

describe('POST /api/bookings/extract', () => {
  it('extracts and returns the structured preview, storing NOTHING', async () => {
    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });

    expect(res.status).toBe(201);
    // No booking was created, so there is no id and no status to report. The
    // response says so outright rather than handing back a placeholder.
    expect(res.body.persisted).toBe(false);
    expect(res.body.booking.id).toBeUndefined();
    expect(res.body.booking.status).toBeUndefined();
    expect(res.body.booking.guestName).toBe('Nguyễn Văn A');
    expect(res.body.booking.bookingCode).toBe('1234567890');
    expect(res.body.booking.checkIn).toBe('2026-07-19');
    expect(res.body.booking.checkOut).toBe('2026-07-22');
    expect(res.body.booking.totalAmount).toBe(2_650_000);
    expect(res.body.booking.parserVersion).toBeTruthy();

    expect(res.body.suggestedBranch.address).toBe('05 Trương Định');
    expect(res.body.rooms).toHaveLength(1);
    expect(res.body.rooms[0].roomName).toBe('Deluxe Double Room');
    expect(res.body.rooms[0].nights).toHaveLength(3);
    expect(res.body.rooms[0].nights.map((n: { amount: number }) => n.amount)).toEqual([
      850_000, 850_000, 950_000,
    ]);
    expect(res.body.warnings).toEqual([]);

    // THE POINT OF THE CHANGE: reviewing is not an act of record. An Admin who
    // pastes the wrong page or closes the tab leaves nothing behind.
    expect(await persistedCounts()).toEqual(NOTHING);
  });

  it('flows the two-room nightly-table sample into the review payload', async () => {
    const raw = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'booking', '25-real-sample-two-room-nightly.txt'),
      'utf8',
    );
    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: raw });

    expect(res.status).toBe(201);
    // The exact review-form fields the frontend renders.
    expect(res.body.booking.hotelName).toBe('Saigon Hotel & Ben Thanh Market');
    expect(res.body.booking.guestName).toBe('Thùy Chi Phan');
    expect(res.body.booking.phone).toBe('+84 964 934 713');
    expect(res.body.booking.bookingCode).toBe('6312474567');
    expect(res.body.booking.totalAmount).toBe(3_078_000);
    expect(res.body.booking.checkIn).toBe('2026-07-23');
    expect(res.body.booking.checkOut).toBe('2026-07-25');
    expect(res.body.booking.paymentStatus).toBe('PAY_AFTER');
    expect(res.body.booking.specialRequest).toBe(
      'Khách dự kiến đến trong khoảng 13:00 - 14:00. Có thể gửi hành lý nếu phòng chưa sẵn sàng.',
    );
    expect(res.body.suggestedBranch.address).toBe('05 Trương Định');

    expect(res.body.rooms).toHaveLength(2);
    for (const room of res.body.rooms) {
      expect(room.roomName).toBe('Phòng Tiêu Chuẩn Giường Đôi');
      expect(room.roomTotal).toBe(1_539_000);
      expect(room.nights.map((n: { stayDate: string }) => n.stayDate)).toEqual([
        '2026-07-23',
        '2026-07-24',
      ]);
      expect(room.nights.map((n: { amount: number }) => n.amount)).toEqual([648_000, 891_000]);
    }
    // Since 5.1 the extranet sample's hotel line — the internal name with the
    // property id glued on — resolves by containment, so no branch-confirmation
    // warning is raised. The branch itself is unchanged (asserted above).
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual([]);

    // The preview carries both rooms and every night — and still stores nothing.
    expect(await persistedCounts()).toEqual(NOTHING);
  });

  it('reports an extraction warning in the preview without storing it', async () => {
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 999
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-20:
2026-07-21: 950.000 VND
Thanh toán: Thanh toán tại chỗ`;

    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: text });
    expect(res.status).toBe(201);
    const codes = res.body.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('MISSING_NIGHTLY_PRICE');

    // The Admin is told; the database is not. The warning becomes a row only if
    // the order is actually sent — see the dispatch case below.
    expect(await testPrisma.bookingExtractWarning.count()).toBe(0);
    expect(await persistedCounts()).toEqual(NOTHING);
  });

  it('stores the extraction warning once the order is SENT', async () => {
    // The original intent of the case above — a warning survives with the
    // booking — measured where the booking now comes into existence.
    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });
    expect(res.status).toBe(201);

    const sent = await dispatchPreview(res);
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: sent.body.booking.id as string },
      include: { warnings: true, rooms: { include: { nights: true } } },
    });
    expect(stored.status).toBe('NEW');
    // The server re-reads the pasted text, so the stored warnings are its own.
    expect(stored.warnings.map((w) => w.code)).toEqual(
      res.body.warnings.map((w: { code: string }) => w.code),
    );
  });

  it('returns an unknown-hotel warning with no suggested branch', async () => {
    const text = `Some Random Guesthouse
Mã đặt phòng: 888
Khách: Test Guest
Nhận phòng: 2026-09-01
Trả phòng: 2026-09-02
Phòng 1: Standard Room
2026-09-01: 500.000 VND
Thanh toán: Thanh toán tại chỗ`;

    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: text });
    expect(res.status).toBe(201);
    expect(res.body.suggestedBranch).toBeNull();
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('UNKNOWN_HOTEL');
  });

  it('rejects empty rawText with a validation error', async () => {
    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('forbids a receptionist from extracting', async () => {
    const branch = await testPrisma.branch.findFirstOrThrow();
    await createReceptionist(branch.id, { username: 'letan', mustChangePassword: false });
    const { agent } = await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD);

    const res = await agent.post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('POST /api/bookings/extract — branch confidence & persistence safety', () => {
  const LOW_CONFIDENCE = `Luxury Hotel Ben Thanh
Số xác nhận đặt phòng
5566778899
Nhận phòng
2026-09-01
Trả phòng
2026-09-02
Tên khách
Test Guest
Deluxe Room
2026-09-01
800.000 VND`;

  it('surfaces a low-confidence branch candidate but does not auto-assign it', async () => {
    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: LOW_CONFIDENCE });

    expect(res.status).toBe(201);
    expect(res.body.branchConfident).toBe(false);
    expect(res.body.requiresManualConfirmation).toBe(true);
    // The candidate is offered to the admin for confirmation…
    expect(res.body.suggestedBranch).not.toBeNull();
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('LOW_BRANCH_CONFIDENCE');

    // …and a branch the system is unsure about is not written ANYWHERE, because
    // nothing is written. The original guarantee — never auto-assign a shaky
    // branch — now holds by construction rather than by a careful null.
    expect(await persistedCounts()).toEqual(NOTHING);
  });

  it('writes booking, rooms, nights and warnings atomically — at SEND', async () => {
    /*
      The atomicity this case has always guarded, relocated to where the write
      happens. Extraction writes nothing; the dispatch writes the booking
      together with every one of its children, in one transaction.
    */
    const text = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 4545454545
Khách: Atomic Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Phòng 1: Deluxe Double Room
2026-07-19: 850.000 VND
2026-07-21: 950.000 VND
Thanh toán: Thanh toán tại chỗ`;

    const res = await adminAgent.post('/api/bookings/extract').send({ rawText: text });
    expect(res.status).toBe(201);
    expect(await persistedCounts()).toEqual(NOTHING);

    // The Admin picks the internal code on the review screen; the branch's
    // active mapping does not recognise Booking.com's own room name here.
    const roomClass = await testPrisma.branchRoomClass.findFirstOrThrow({
      where: { branchId: res.body.suggestedBranch.id, active: true, version: { status: 'ACTIVE' } },
    });

    const sent = await adminAgent.post('/api/admin/bookings/dispatch').send({
      rawText: text,
      branchId: res.body.suggestedBranch.id,
      hotelName: res.body.booking.hotelName,
      customerName: res.body.booking.guestName,
      phone: res.body.booking.phone,
      bookingCode: res.body.booking.bookingCode,
      checkInDate: res.body.booking.checkIn,
      checkOutDate: res.body.booking.checkOut,
      totalAmount: res.body.booking.totalAmount,
      paymentStatus: res.body.booking.paymentStatus,
      specialRequest: res.body.booking.specialRequest,
      rooms: res.body.rooms.map(
        (r: { roomIndex: number; roomName: string; roomTotal: number | null; nights: unknown[] }) => ({
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
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: sent.body.booking.id as string },
      include: { rooms: { include: { nights: true } }, warnings: true },
    });
    expect(stored.rooms).toHaveLength(1);
    expect(stored.rooms[0]!.nights).toHaveLength(3);
    expect(stored.warnings.some((w) => w.code === 'MISSING_NIGHTLY_PRICE')).toBe(true);
  });

  it('has no previous DRAFT to replace when the same code is re-extracted', async () => {
    /*
      This case used to prove that re-extracting REPLACED the earlier draft, so
      retries could not pile up rows for one confirmation code. The rows no
      longer exist to pile up: extracting twice is two reads.

      The guarantee is therefore stronger than it was, and needs no cascade
      delete to hold — the mechanism it was protecting against is gone.
    */
    const first = await adminAgent.post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });
    const second = await adminAgent.post('/api/bookings/extract').send({ rawText: SINGLE_ROOM });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // Same reservation read twice — identical preview, and no id to differ by.
    expect(second.body.booking.bookingCode).toBe(first.body.booking.bookingCode);
    expect(second.body.booking.id).toBeUndefined();

    expect(await testPrisma.booking.count({ where: { bookingCode: '1234567890' } })).toBe(0);
    expect(await persistedCounts()).toEqual(NOTHING);
  });
});
