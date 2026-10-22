/**
 * The dispatch claim ("CUT"), its three-minute window, and Admin resend.
 *
 * THE CLAIM IS THE FEATURE; THE COUNTDOWN IS DECORATION. Every test here is
 * ultimately about one property: two receptionists must never both believe they
 * own the creation work for the same order, because that is how the same
 * reservation gets made twice in the hotel system. The timer only bounds how
 * long one of them may hold it.
 *
 * The clock is injected via `setClock` so "three minutes later" is exact and
 * instant. Nothing here sleeps.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { pngBuffer } from './helpers/images';
import { resetClock, setClock } from '../src/lib/clock';
import { CLAIM_WINDOW_MS } from '../src/booking/claim';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
/** Two receptionists AT THE SAME BRANCH — the duplicate risk this prevents. */
let letanA: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanB: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanAId: number;
let letanBId: number;
let cn1: number;
let cn2: number;

const BASE = new Date('2026-08-09T10:00:00.000Z');

/** Freeze the server clock at an offset from BASE. */
function at(offsetMs: number): Date {
  const t = new Date(BASE.getTime() + offsetMs);
  setClock({ now: () => t });
  return t;
}

/** A dispatched order the branch must create. */
async function dispatchOrder(branchId = cn1): Promise<string> {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'NGUYEN VAN A',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER',
      branchId,
      status: 'NEW',
      verificationStatus: 'NOT_SUBMITTED',
      sentAt: BASE,
    },
  });
  return booking.id;
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  const branches = await testPrisma.branch.findMany({ orderBy: { id: 'asc' } });
  cn1 = branches[0]!.id;
  cn2 = branches[1]!.id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letanA = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  letanAId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letana' } })).id;

  await createReceptionist(cn1, { username: 'letanb', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;
  /*
    Every receptionist checks in to a shift.

    Submitting a proof IS the receptionist asserting "I created this
    reservation", so the server now takes the order's creator from the shift
    they are working and refuses the submission when there is none. That rule
    is the subject of bookingCreatorAttribution.test.ts; here it is only the
    precondition these cases need.
  */
  await letanA
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
  await letanB
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
  letanBId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letanb' } })).id;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.bookingCreationProof.deleteMany({});
  await testPrisma.booking.deleteMany({});
  at(0);
});

afterEach(() => {
  resetClock();
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* Claiming                                                            */
/* ================================================================== */

describe('CUT — claiming a dispatched order', () => {
  it('lets a receptionist claim an eligible order', async () => {
    const id = await dispatchOrder();
    const res = await letanA.post(`/api/bookings/${id}/claim`);
    expect(res.status).toBe(200);
  });

  it('persists claimedByUserId, claimedAt and claimExpiresAt', async () => {
    const id = await dispatchOrder();
    const now = at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBe(letanAId);
    expect(row.claimedAt?.toISOString()).toBe(now.toISOString());
    expect(row.claimExpiresAt).not.toBeNull();
  });

  it('sets the deadline EXACTLY three minutes from the server clock', async () => {
    // Not "about three minutes": the window is a business rule, and a test that
    // tolerated drift would not notice the constant being changed.
    const id = await dispatchOrder();
    const now = at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimExpiresAt!.getTime() - now.getTime()).toBe(CLAIM_WINDOW_MS);
    expect(CLAIM_WINDOW_MS).toBe(3 * 60 * 1000);
  });

  it('REFUSES a second receptionist while the claim is active', async () => {
    const id = await dispatchOrder();
    expect((await letanA.post(`/api/bookings/${id}/claim`)).status).toBe(200);

    const res = await letanB.post(`/api/bookings/${id}/claim`);
    expect(res.status).toBe(409);

    // And ownership did not move.
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBe(letanAId);
  });

  it('names the current holder so the loser knows what happened', async () => {
    const id = await dispatchOrder();
    await letanA.post(`/api/bookings/${id}/claim`);
    const res = await letanB.post(`/api/bookings/${id}/claim`);
    expect(JSON.stringify(res.body)).toMatch(/đã được .* nhận|lễ tân khác/i);
  });

  it('re-claiming by the SAME receptionist does not extend the deadline', async () => {
    // A receptionist mashing CUT must not buy themselves another three minutes.
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    const first = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimExpiresAt!;

    at(60_000);
    const again = await letanA.post(`/api/bookings/${id}/claim`);
    expect(again.status).toBe(409);

    const after = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimExpiresAt!;
    expect(after.toISOString()).toBe(first.toISOString());
  });

  it('refuses an order belonging to another branch', async () => {
    const id = await dispatchOrder(cn2);
    const res = await letanA.post(`/api/bookings/${id}/claim`);
    expect([403, 404, 409]).toContain(res.status);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimedByUserId).toBeNull();
  });

  it('refuses an ADMIN — an Admin has no creation work to own', async () => {
    const id = await dispatchOrder();
    expect((await adminAgent.post(`/api/bookings/${id}/claim`)).status).toBe(403);
  });

  it('writes a BOOKING_CLAIMED audit row', async () => {
    const id = await dispatchOrder();
    await letanA.post(`/api/bookings/${id}/claim`);
    const events = await testPrisma.bookingAuditEvent.findMany({
      where: { bookingId: id, action: 'BOOKING_CLAIMED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(letanAId);
  });

  it('is safe under a concurrent race — exactly one winner', async () => {
    // The property the whole feature rests on. Both requests are in flight
    // before either resolves; the conditional update serialises them.
    const id = await dispatchOrder();
    const [a, b] = await Promise.all([
      letanA.post(`/api/bookings/${id}/claim`),
      letanB.post(`/api/bookings/${id}/claim`),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect([letanAId, letanBId]).toContain(row.claimedByUserId);
  });
});

/* ================================================================== */
/* Expiry                                                              */
/* ================================================================== */

describe('the three-minute window', () => {
  it('an expired claim can NOT be taken again by reception — it belongs to Admin now', async () => {
    // The order does not fall back into the pool when the window runs out: it
    // goes to the Admin resend list, and an Admin sending it back is the only
    // thing that makes it takeable again. Letting the next receptionist grab it
    // straight from here would route around the review of what just lapsed.
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    at(CLAIM_WINDOW_MS + 1);
    const res = await letanB.post(`/api/bookings/${id}/claim`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/chờ Admin gửi lại/i);

    // Still recorded against the receptionist who let it lapse.
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimedByUserId).toBe(letanAId);
  });

  it('refuses proof submission after the deadline', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    at(CLAIM_WINDOW_MS + 1);
    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'muộn')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.verificationStatus).toBe('NOT_SUBMITTED');
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: id } })).toBe(0);
  });

  it('ACCEPTS a submission just inside the deadline', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    at(CLAIM_WINDOW_MS - 1000);
    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'kịp')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(201);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).verificationStatus).toBe(
      'PENDING_REVIEW',
    );
  });

  it('refuses proof submission from a receptionist who does not hold the claim', async () => {
    const id = await dispatchOrder();
    await letanA.post(`/api/bookings/${id}/claim`);

    const res = await letanB
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'không phải của tôi')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
  });

  it('REFUSES submission when nobody has claimed the order — CUT is mandatory', async () => {
    // The rule the whole feature rests on: creation work must be owned before
    // it is done, because the duplicate happens in the external hotel system
    // before any proof exists.
    const id = await dispatchOrder();
    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'chưa CUT')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: id } })).toBe(0);
  });

  it('REMOVES an expired order from the receptionist queue the instant it lapses', async () => {
    // §6. Not hidden by the client, not swept by a job — the list query itself
    // stops returning it, so the disappearance is exact to the second and needs
    // no scheduler. The row is untouched; it is now Admin's to resend.
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    // One millisecond before the deadline it is still theirs to work on.
    at(CLAIM_WINDOW_MS - 1);
    const before = await letanA.get('/api/bookings/new');
    expect((before.body.bookings as { id: string }[]).map((b) => b.id)).toContain(id);

    at(CLAIM_WINDOW_MS + 1);
    const after = await letanA.get('/api/bookings/new');
    expect((after.body.bookings as { id: string }[]).map((b) => b.id)).not.toContain(id);

    // Gone from reception, present for Admin — the same row, not a copy.
    const resend = await adminAgent.get('/api/bookings/expired-claims');
    expect((resend.body.bookings as { id: string }[]).map((b) => b.id)).toContain(id);
    expect(await testPrisma.booking.count({ where: { id } })).toBe(1);
  });

  it('keeps an elapsed order on the ADMIN overview — they must see the lapse', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);

    at(CLAIM_WINDOW_MS + 1);
    const adminList = await adminAgent.get('/api/bookings/new');
    expect((adminList.body.bookings as { id: string }[]).map((b) => b.id)).toContain(id);
  });
});

/* ================================================================== */
/* Gửi lại đơn                                                         */
/* ================================================================== */

describe('Admin resend ("Gửi lại đơn")', () => {
  async function expiredOrder(): Promise<string> {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    at(CLAIM_WINDOW_MS + 1);
    return id;
  }

  it('lists an expired, uncompleted order', async () => {
    const id = await expiredOrder();
    const res = await adminAgent.get('/api/bookings/expired-claims');
    expect(res.status).toBe(200);
    expect((res.body.bookings as { id: string }[]).map((b) => b.id)).toContain(id);
  });

  it('does NOT list an order whose claim is still active', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    at(60_000);
    const res = await adminAgent.get('/api/bookings/expired-claims');
    expect((res.body.bookings as { id: string }[]).map((b) => b.id)).not.toContain(id);
  });

  it('does NOT list an order that was completed in time', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'xong')
      .attach('image', pngBuffer(), 'proof.png');

    at(CLAIM_WINDOW_MS + 1);
    const res = await adminAgent.get('/api/bookings/expired-claims');
    expect((res.body.bookings as { id: string }[]).map((b) => b.id)).not.toContain(id);
  });

  it('resend clears the claim and increments claimCycle', async () => {
    const id = await expiredOrder();
    const res = await adminAgent.post(`/api/bookings/${id}/resend`);
    expect(res.status).toBe(200);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.claimExpiresAt).toBeNull();
    expect(row.claimCycle).toBe(1);
  });

  it('a resent order can be claimed again, starting a fresh window', async () => {
    const id = await expiredOrder();
    await adminAgent.post(`/api/bookings/${id}/resend`);

    const claimAt = at(CLAIM_WINDOW_MS + 5000);
    expect((await letanB.post(`/api/bookings/${id}/claim`)).status).toBe(200);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBe(letanBId);
    expect(row.claimExpiresAt!.getTime() - claimAt.getTime()).toBe(CLAIM_WINDOW_MS);
  });

  it('the PREVIOUS receptionist cannot submit after a new cycle began', async () => {
    const id = await expiredOrder();
    await adminAgent.post(`/api/bookings/${id}/resend`);
    at(CLAIM_WINDOW_MS + 5000);
    await letanB.post(`/api/bookings/${id}/claim`);

    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'lượt cũ')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
  });

  it('refuses to resend an order whose claim is still active', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    at(60_000);
    expect((await adminAgent.post(`/api/bookings/${id}/resend`)).status).toBe(409);
  });

  it('a double-clicked resend increments the cycle only once', async () => {
    const id = await expiredOrder();
    const [a, b] = await Promise.all([
      adminAgent.post(`/api/bookings/${id}/resend`),
      adminAgent.post(`/api/bookings/${id}/resend`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimCycle).toBe(1);
  });

  it('records why it came back and that it went back out', async () => {
    const id = await expiredOrder();
    await adminAgent.post(`/api/bookings/${id}/resend`);
    const actions = (
      await testPrisma.bookingAuditEvent.findMany({ where: { bookingId: id } })
    ).map((e) => e.action);
    expect(actions).toContain('BOOKING_CLAIM_EXPIRED');
    expect(actions).toContain('BOOKING_RESENT');
  });

  it('refuses a RECEPTIONIST on the Admin endpoints', async () => {
    const id = await expiredOrder();
    expect((await letanA.get('/api/bookings/expired-claims')).status).toBe(403);
    expect((await letanA.post(`/api/bookings/${id}/resend`)).status).toBe(403);
  });
});

/* ================================================================== */
/* "Cần tạo lại" gets the same protection                              */
/* ================================================================== */

describe('rejected orders ("Cần tạo lại") are claimable and protected', () => {
  async function rejectedOrder(): Promise<string> {
    const id = await dispatchOrder();
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'REJECTED' },
    });
    return id;
  }

  it('a receptionist can claim one', async () => {
    const id = await rejectedOrder();
    expect((await letanA.post(`/api/bookings/${id}/claim`)).status).toBe(200);
  });

  it('a second receptionist cannot', async () => {
    const id = await rejectedOrder();
    await letanA.post(`/api/bookings/${id}/claim`);
    expect((await letanB.post(`/api/bookings/${id}/claim`)).status).toBe(409);
  });

  it('resubmission is blocked while ANOTHER receptionist holds the claim', async () => {
    const id = await rejectedOrder();
    await letanA.post(`/api/bookings/${id}/claim`);
    const res = await letanB
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'không phải của tôi')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
  });

  it('resubmission requires CUT here too', async () => {
    const id = await rejectedOrder();
    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'chưa CUT')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
  });
});

/* ================================================================== */
/* Existing behaviour must be intact                                   */
/* ================================================================== */

describe('existing dispatch behaviour is unchanged', () => {
  it('a claimed order still completes through the normal proof flow', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'đã tạo')
      .attach('image', pngBuffer(), 'proof.png');

    expect(res.status).toBe(201);
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.verificationStatus).toBe('PENDING_REVIEW');
    // The guest-stay lifecycle is a different axis and must not have moved.
    expect(row.status).toBe('NEW');
    expect(row.receivedAt).toBeNull();
  });

  it('an ADMIN may still submit on behalf of a branch without a claim', async () => {
    const id = await dispatchOrder();
    const res = await adminAgent
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'admin ho tro')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(201);
  });

  it('CUT does not touch the guest-stay lifecycle', async () => {
    // RECEIVED / receivedAt / receivedByUserId belong to a different axis
    // entirely (RECEIVED is what CHECK_IN transitions FROM). If claiming ever
    // starts writing them, the two workflows have been conflated.
    const id = await dispatchOrder();
    await letanA.post(`/api/bookings/${id}/claim`);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('NEW');
    expect(row.receivedAt).toBeNull();
    expect(row.receivedByUserId).toBeNull();
  });

  it('a successful submission ends the claim workflow and never reaches the resend list', async () => {
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    expect(
      (
        await letanA
          .post(`/api/bookings/${id}/proofs`)
          .field('note', 'xong')
          .attach('image', pngBuffer(), 'proof.png')
      ).status,
    ).toBe(201);

    // Long past the deadline, a completed order is still not recoverable work.
    at(CLAIM_WINDOW_MS * 10);
    const res = await adminAgent.get('/api/bookings/expired-claims');
    expect((res.body.bookings as { id: string }[]).map((b) => b.id)).not.toContain(id);

    // And it cannot be resent.
    expect((await adminAgent.post(`/api/bookings/${id}/resend`)).status).toBe(409);
  });

  it('a holder from a PREVIOUS cycle is refused even before anyone re-claims', async () => {
    // Resend clears the claim, so the old holder matches no claim at all —
    // which is why no separate stored cycle is needed to enforce this.
    const id = await dispatchOrder();
    at(0);
    await letanA.post(`/api/bookings/${id}/claim`);
    at(CLAIM_WINDOW_MS + 1);
    await adminAgent.post(`/api/bookings/${id}/resend`);

    const res = await letanA
      .post(`/api/bookings/${id}/proofs`)
      .field('note', 'lượt cũ')
      .attach('image', pngBuffer(), 'proof.png');
    expect(res.status).toBe(409);
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: id } })).toBe(0);
  });
});
