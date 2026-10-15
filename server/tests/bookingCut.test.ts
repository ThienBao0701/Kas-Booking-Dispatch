/**
 * CẮT — taking the three fields off a dispatched order.
 *
 * THE PROPERTY UNDER TEST IS "ONE ORDER, ONE CLAIM, ONE TIMER". Three buttons
 * exist, and a receptionist presses all three in the course of creating a
 * reservation; the first press claims the order and starts the three minutes,
 * and the other two must change nothing about that claim. A bug here would be
 * invisible in the UI and catastrophic in effect — a timer that restarts on
 * every cut is a claim that never expires.
 *
 * The second property is that CẮT hides and never destroys: the Booking row is
 * byte-for-byte unchanged afterwards, and an Admin sees all of it.
 *
 * The clock is injected, so "three minutes later" is exact. Nothing here sleeps.
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
import { resetClock, setClock } from '../src/lib/clock';
import { CLAIM_WINDOW_MS, CUT_FIELDS } from '../src/booking/claim';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanA: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanB: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanAId: number;
let cn1: number;

const BASE = new Date('2026-08-10T03:00:00.000Z');

const CUSTOMER = 'NGUYEN VAN A';
const TOTAL = 2_511_000;

function at(offsetMs: number): Date {
  const t = new Date(BASE.getTime() + offsetMs);
  setClock({ now: () => t });
  return t;
}

async function dispatchOrder(branchId = cn1): Promise<string> {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: CUSTOMER,
      totalAmount: TOTAL,
      adminPmsNote: 'BK 5832646843_1SUP_2 DEM',
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

const cut = (agent: typeof letanA, id: string, field: string) =>
  agent.post(`/api/bookings/${id}/cut`).send({ field });

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  const branches = await testPrisma.branch.findMany({ orderBy: { id: 'asc' } });
  cn1 = branches[0]!.id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letanA = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  letanAId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letana' } })).id;

  await createReceptionist(cn1, { username: 'letanb', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.bookingCreationProof.deleteMany({});
  await testPrisma.booking.deleteMany({});
  at(0);
});

afterEach(() => resetClock());

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* The first CẮT is the claim                                          */
/* ================================================================== */

describe('the first CẮT claims the order', () => {
  it('starts exactly ONE claim, whichever field is cut first', async () => {
    for (const field of CUT_FIELDS) {
      await testPrisma.bookingAuditEvent.deleteMany({});
      await testPrisma.booking.deleteMany({});
      at(0);

      const id = await dispatchOrder();
      const res = await cut(letanA, id, field);
      expect(res.status).toBe(200);

      const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row.claimedByUserId).toBe(letanAId);
      expect(row.claimCycle).toBe(0);
    }
  });

  it('starts exactly one 3-minute countdown', async () => {
    const id = await dispatchOrder();
    const now = at(0);
    const res = await cut(letanA, id, 'CUSTOMER_NAME');

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimExpiresAt!.getTime() - now.getTime()).toBe(CLAIM_WINDOW_MS);
    expect(new Date(res.body.claimExpiresAt).getTime() - now.getTime()).toBe(CLAIM_WINDOW_MS);
    expect(CLAIM_WINDOW_MS).toBe(3 * 60 * 1000);
  });

  it('reports which field was taken, and only that one', async () => {
    const id = await dispatchOrder();
    const res = await cut(letanA, id, 'TOTAL_AMOUNT');
    expect(res.body.cutFields).toEqual(['TOTAL_AMOUNT']);
  });

  it('refuses an unknown field name', async () => {
    const id = await dispatchOrder();
    const res = await cut(letanA, id, 'CARD_NUMBER');
    expect(res.status).toBe(422);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimedByUserId).toBeNull();
  });

  it('refuses an ADMIN — Admin does no creation work and cuts nothing', async () => {
    const id = await dispatchOrder();
    const res = await adminAgent.post(`/api/bookings/${id}/cut`).send({ field: 'CUSTOMER_NAME' });
    expect(res.status).toBe(403);
  });

  it('is safe under a concurrent race on TWO DIFFERENT fields — one winner', async () => {
    // The nastiest shape of the bug: two receptionists press two different
    // buttons at the same instant. Both are "first", and only one may claim.
    const id = await dispatchOrder();
    at(0);

    const [a, b] = await Promise.all([
      cut(letanA, id, 'CUSTOMER_NAME'),
      cut(letanB, id, 'PMS_NOTE'),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await testPrisma.booking.findMany({ where: { id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimedByUserId).not.toBeNull();
    expect(rows[0]!.claimCycle).toBe(0);
  });
});

/* ================================================================== */
/* Later CẮTs change nothing about the claim                           */
/* ================================================================== */

describe('the second and third CẮT', () => {
  it('do NOT reset or extend the deadline', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');
    const first = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimExpiresAt!;

    at(60_000);
    await cut(letanA, id, 'TOTAL_AMOUNT');
    at(120_000);
    const third = await cut(letanA, id, 'PMS_NOTE');

    const after = (await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimExpiresAt!;
    expect(after.toISOString()).toBe(first.toISOString());
    // And the response agrees with the row — the client is told the truth.
    expect(new Date(third.body.claimExpiresAt).toISOString()).toBe(first.toISOString());
  });

  it('do NOT increment claimCycle', async () => {
    const id = await dispatchOrder();
    at(0);
    for (const field of CUT_FIELDS) await cut(letanA, id, field);

    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id } })).claimCycle).toBe(0);
  });

  it('do NOT create a second claim or a second Booking', async () => {
    const id = await dispatchOrder();
    at(0);
    for (const field of CUT_FIELDS) await cut(letanA, id, field);

    expect(await testPrisma.booking.count()).toBe(1);
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBe(letanAId);
  });

  it('accumulate — each cut adds its own field and leaves the others alone', async () => {
    const id = await dispatchOrder();
    at(0);

    expect((await cut(letanA, id, 'CUSTOMER_NAME')).body.cutFields).toEqual(['CUSTOMER_NAME']);
    expect((await cut(letanA, id, 'TOTAL_AMOUNT')).body.cutFields).toEqual([
      'CUSTOMER_NAME',
      'TOTAL_AMOUNT',
    ]);
    expect((await cut(letanA, id, 'PMS_NOTE')).body.cutFields).toEqual([
      'CUSTOMER_NAME',
      'TOTAL_AMOUNT',
      'PMS_NOTE',
    ]);
  });

  it('are idempotent — cutting the same field twice records it once', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'PMS_NOTE');
    const again = await cut(letanA, id, 'PMS_NOTE');

    expect(again.status).toBe(200);
    expect(again.body.cutFields).toEqual(['PMS_NOTE']);
    const events = await testPrisma.bookingAuditEvent.findMany({
      where: { bookingId: id, newValue: { contains: 'PMS_NOTE' } },
    });
    expect(events).toHaveLength(1);
  });
});

/* ================================================================== */
/* CẮT hides; it never destroys                                        */
/* ================================================================== */

describe('the underlying data', () => {
  it('is COMPLETELY unchanged after all three fields are cut', async () => {
    const id = await dispatchOrder();
    const before = await testPrisma.booking.findUniqueOrThrow({ where: { id } });

    at(0);
    for (const field of CUT_FIELDS) await cut(letanA, id, field);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(after.customerName).toBe(CUSTOMER);
    expect(Number(after.totalAmount)).toBe(TOTAL);
    expect(after.adminPmsNote).toBe(before.adminPmsNote);
    expect(after.deletedAt).toBeNull();
  });

  it('is still fully visible to ADMIN, who never receives a cut list', async () => {
    const id = await dispatchOrder();
    at(0);
    for (const field of CUT_FIELDS) await cut(letanA, id, field);

    const res = await adminAgent.get(`/api/bookings/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.booking.customerName).toBe(CUSTOMER);
    expect(Number(res.body.booking.totalAmount)).toBe(TOTAL);
    expect(res.body.booking.cutFields).toEqual([]);
  });

  it('tells the receptionist which fields they have taken, on a fresh request', async () => {
    // §13/§14: the state is the server's, so a refresh and a second tab agree.
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');

    const reload = await letanA.get(`/api/bookings/${id}`);
    expect(reload.body.booking.cutFields).toEqual(['CUSTOMER_NAME']);
    // The value itself is still delivered — hiding is the client's job, and the
    // booking is not mutilated for one role.
    expect(reload.body.booking.customerName).toBe(CUSTOMER);
    expect(reload.body.serverNow).toBeTruthy();
  });
});

/* ================================================================== */
/* Resend resets the cut state                                         */
/* ================================================================== */

describe('after an Admin resend', () => {
  async function lapseAndResend(id: string): Promise<void> {
    at(CLAIM_WINDOW_MS + 1);
    const resent = await adminAgent.post(`/api/bookings/${id}/resend`);
    expect(resent.status).toBe(200);
  }

  it('the new cycle starts with NOTHING cut', async () => {
    const id = await dispatchOrder();
    at(0);
    for (const field of CUT_FIELDS) await cut(letanA, id, field);
    await lapseAndResend(id);

    const res = await letanA.get(`/api/bookings/${id}`);
    expect(res.body.booking.cutFields).toEqual([]);
    expect(res.body.booking.claimCycle).toBe(1);
  });

  it('does NOT start a timer on its own — only a new CẮT does', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');
    await lapseAndResend(id);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimExpiresAt).toBeNull();
  });

  it('starts a FRESH three minutes on the next CẮT', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');
    await lapseAndResend(id);

    const now = at(CLAIM_WINDOW_MS + 5_000);
    const res = await cut(letanB, id, 'TOTAL_AMOUNT');
    expect(res.status).toBe(200);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.claimExpiresAt!.getTime() - now.getTime()).toBe(CLAIM_WINDOW_MS);
    expect(res.body.cutFields).toEqual(['TOTAL_AMOUNT']);
    // Same booking throughout. A resend is a new cycle, never a new row.
    expect(await testPrisma.booking.count()).toBe(1);
    expect(row.claimCycle).toBe(1);
  });
});

/* ================================================================== */
/* Expiry                                                              */
/* ================================================================== */

describe('when the window runs out', () => {
  it('CẮT is refused and nothing is recorded', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');

    at(CLAIM_WINDOW_MS + 1);
    const res = await cut(letanA, id, 'TOTAL_AMOUNT');
    expect(res.status).toBe(409);

    const events = await testPrisma.bookingAuditEvent.findMany({
      where: { bookingId: id, newValue: { contains: 'TOTAL_AMOUNT' } },
    });
    expect(events).toHaveLength(0);
  });

  it('another receptionist cannot CẮT it either — it is Admin\'s now', async () => {
    const id = await dispatchOrder();
    at(0);
    await cut(letanA, id, 'CUSTOMER_NAME');

    at(CLAIM_WINDOW_MS + 1);
    expect((await cut(letanB, id, 'CUSTOMER_NAME')).status).toBe(409);
  });
});
