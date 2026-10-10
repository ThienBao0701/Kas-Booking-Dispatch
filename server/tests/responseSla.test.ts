/**
 * The Admin-sent → reception-started response SLA, server side.
 *
 * The server contributes exactly two things to this feature: the instant the
 * clock starts (`slaStartedAt`) and its own `serverNow`. Everything else is
 * display. So what is tested here is the derivation — in particular that a
 * RESENT order is measured from the resend, not from the original dispatch,
 * because the claim-expiry resend deliberately leaves `sentAt` alone.
 *
 * Nothing here touches the claim workflow; `bookingClaim.test.ts` and
 * `bookingCut.test.ts` continue to own that and are unchanged.
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
import { CLAIM_WINDOW_MS } from '../src/booking/claim';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letan: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanId: number;
let adminId: number;
let cn1: number;

const BASE = new Date('2026-08-13T05:00:00.000Z');

function at(offsetMs: number): Date {
  const t = new Date(BASE.getTime() + offsetMs);
  setClock({ now: () => t });
  return t;
}

async function dispatchedAt(sentOffsetMs: number): Promise<string> {
  const b = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'NGUYEN VAN A',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER',
      branchId: cn1,
      status: 'NEW',
      verificationStatus: 'NOT_SUBMITTED',
      sentAt: new Date(BASE.getTime() + sentOffsetMs),
      sentByUserId: adminId,
    },
  });
  return b.id;
}

/** The queue as reception sees it, keyed by booking id. */
async function queue(): Promise<{
  serverNow: string;
  items: Map<string, { slaStartedAt: string | null; claimedAt: string | null }>;
}> {
  const res = await letan.get('/api/bookings/new');
  expect(res.status).toBe(200);
  const items = new Map<string, { slaStartedAt: string | null; claimedAt: string | null }>();
  for (const b of res.body.bookings as {
    id: string;
    slaStartedAt: string | null;
    claimedAt: string | null;
  }[]) {
    items.set(b.id, { slaStartedAt: b.slaStartedAt, claimedAt: b.claimedAt });
  }
  return { serverNow: res.body.serverNow, items };
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn1 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  adminId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letan = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  letanId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letana' } })).id;
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

describe('the SLA start instant the server publishes', () => {
  it('is the dispatch time for a freshly sent order', async () => {
    const id = await dispatchedAt(0);

    const { items } = await queue();
    expect(items.get(id)!.slaStartedAt).toBe(BASE.toISOString());
    expect(items.get(id)!.claimedAt).toBeNull();
  });

  it('comes with the server clock, so the client never invents a deadline', async () => {
    await dispatchedAt(0);
    const now = at(90_000);

    const { serverNow } = await queue();
    expect(serverNow).toBe(now.toISOString());
  });

  it('stops at the claim instant — the existing CẮT event, not a new one', async () => {
    const id = await dispatchedAt(0);

    const claimedAtInstant = at(2 * 60_000 + 15_000);
    expect((await letan.post(`/api/bookings/${id}/claim`)).status).toBe(200);

    const { items } = await queue();
    expect(items.get(id)!.claimedAt).toBe(claimedAtInstant.toISOString());
    // The response time is therefore claimedAt − slaStartedAt = 2m15s.
    const started = new Date(items.get(id)!.slaStartedAt!).getTime();
    const claimed = new Date(items.get(id)!.claimedAt!).getTime();
    expect(claimed - started).toBe(135_000);
  });

  it('is unchanged by polling — three reads give the same start instant', async () => {
    const id = await dispatchedAt(0);

    at(30_000);
    const first = (await queue()).items.get(id)!.slaStartedAt;
    at(60_000);
    const second = (await queue()).items.get(id)!.slaStartedAt;
    at(200_000);
    const third = (await queue()).items.get(id)!.slaStartedAt;

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('gives each order its own start instant', async () => {
    const a = await dispatchedAt(0);
    const b = await dispatchedAt(2 * 60_000);

    at(3 * 60_000);
    const { items } = await queue();
    expect(items.get(a)!.slaStartedAt).toBe(BASE.toISOString());
    expect(items.get(b)!.slaStartedAt).toBe(new Date(BASE.getTime() + 120_000).toISOString());
  });
});

/* ================================================================== */
/* A resent order is measured from the resend                          */
/* ================================================================== */

describe('after a claim-expiry resend', () => {
  it('restarts from the resend, not the original dispatch', async () => {
    /*
      This is the case `sentAt` alone gets wrong. The claim-expiry resend
      deliberately leaves `sentAt` untouched — it releases a lapsed claim rather
      than re-dispatching — so measuring from `sentAt` would show an order that
      reappeared seconds ago as many minutes overdue.
    */
    const id = await dispatchedAt(0);

    at(0);
    await letan.post(`/api/bookings/${id}/claim`);

    const resendInstant = at(CLAIM_WINDOW_MS + 1_000);
    expect((await adminAgent.post(`/api/bookings/${id}/resend`)).status).toBe(200);

    const { items } = await queue();
    const item = items.get(id)!;
    // Back on the queue, unclaimed, and measured from the resend.
    expect(item.claimedAt).toBeNull();
    expect(new Date(item.slaStartedAt!).getTime()).toBeGreaterThanOrEqual(resendInstant.getTime() - 2_000);
    expect(item.slaStartedAt).not.toBe(BASE.toISOString());
    // `sentAt` itself is untouched — the claim workflow is unchanged.
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt!.toISOString()).toBe(BASE.toISOString());
  });

  it('measures the new response from the new start', async () => {
    const id = await dispatchedAt(0);
    at(0);
    await letan.post(`/api/bookings/${id}/claim`);
    at(CLAIM_WINDOW_MS + 1_000);
    await adminAgent.post(`/api/bookings/${id}/resend`);

    const secondClaim = at(CLAIM_WINDOW_MS + 61_000);
    expect((await letan.post(`/api/bookings/${id}/claim`)).status).toBe(200);

    const { items } = await queue();
    const item = items.get(id)!;
    const responseMs =
      new Date(item.claimedAt!).getTime() - new Date(item.slaStartedAt!).getTime();
    // 60s between the resend and the second CẮT, not the ~6 minutes since the
    // original dispatch.
    expect(responseMs).toBeLessThanOrEqual(61_000);
    expect(secondClaim.getTime()).toBeGreaterThan(BASE.getTime());
  });

  it('a redispatched (withdrawn) order also restarts', async () => {
    /*
      Redispatch refreshes `sentAt` itself, so this case restarts even without
      the audit fallback — both signals agree.

      Asserted as "later than the original dispatch" rather than against an exact
      instant: the BOOKING_RESENT row's `createdAt` is a database default, so it
      carries real wall time while this test's clock is frozen. In production the
      two are the same clock; here the later of them is whichever the database
      wrote, and pinning a literal would be testing the harness.
    */
    const id = await dispatchedAt(0);
    at(60_000);
    await adminAgent.delete(`/api/admin/bookings/${id}`);

    const redispatchInstant = at(120_000);
    expect((await adminAgent.post(`/api/admin/bookings/${id}/redispatch`)).status).toBe(200);

    const { items } = await queue();
    const startedAt = new Date(items.get(id)!.slaStartedAt!).getTime();
    expect(startedAt).toBeGreaterThanOrEqual(redispatchInstant.getTime());
    expect(items.get(id)!.slaStartedAt).not.toBe(BASE.toISOString());

    // The row's own dispatch stamp was refreshed by the redispatch.
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt!.toISOString()).toBe(redispatchInstant.toISOString());
  });
});

/* ================================================================== */
/* The claim workflow is not disturbed                                 */
/* ================================================================== */

describe('the existing workflows are untouched', () => {
  it('the claim still sets its own three-minute deadline, independent of the SLA', async () => {
    const id = await dispatchedAt(0);
    const now = at(0);
    await letan.post(`/api/bookings/${id}/claim`);

    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id } });
    // The claim window is still 3 minutes — the 5-minute SLA changed nothing.
    expect(row.claimExpiresAt!.getTime() - now.getTime()).toBe(CLAIM_WINDOW_MS);
    expect(CLAIM_WINDOW_MS).toBe(3 * 60 * 1000);
    expect(row.claimedByUserId).toBe(letanId);
  });

  it('an elapsed claim still drops the order off the queue', async () => {
    const id = await dispatchedAt(0);
    at(0);
    await letan.post(`/api/bookings/${id}/claim`);

    at(CLAIM_WINDOW_MS + 1);
    const { items } = await queue();
    expect(items.has(id)).toBe(false);
  });
});
