import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { setClock, resetClock } from '../src/lib/clock';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let branch1: number;
let branch2: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  branch1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  branch2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  // Freeze "today" to 2026-07-15 (HCM) so the day-window maths is deterministic.
  setClock({ now: () => new Date('2026-07-15T05:00:00.000Z') });
});

afterEach(() => resetClock());
afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('GET /api/admin/dashboard/summary', () => {
  it('computes totals and per-branch counts in the property timezone', async () => {
    // Waiting, not last-minute, sent today.
    await createDraftBooking({ status: 'NEW', branchId: branch1, bookingCode: 'W111111111', sentAt: '2026-07-15T02:00:00.000Z' });
    // Waiting AND last-minute, sent today. `isLastMinute` is the STORED FLAG the
    // dispatch stamps when check-in equals the day of dispatch — the fixture now
    // sets it because that is the field the counter reads, and a fixture that
    // only set `checkIn` was describing a booking dispatch would never produce.
    await createDraftBooking({ status: 'NEW', branchId: branch2, bookingCode: 'LM22222222', checkIn: '2026-07-15', checkOut: '2026-07-17', isLastMinute: true, sentAt: '2026-07-15T02:00:00.000Z' });
    // Confirmed today: an APPROVED PROOF, reviewed today. "Confirmed" has
    // always meant the branch entered the reservation and an Admin verified it.
    // Since the booking and proof lifecycles were separated that is no longer
    // the same event as COMPLETED, which now means the guest's stay has ended.
    const confirmed = await createDraftBooking({ status: 'NEW', branchId: branch1, bookingCode: 'C333333333', sentAt: '2026-07-15T02:00:00.000Z' });
    await testPrisma.booking.update({
      where: { id: confirmed.id },
      data: { verificationStatus: 'APPROVED', reviewedAt: new Date('2026-07-15T03:00:00.000Z') },
    });
    // A COMPLETED stay is deliberately NOT counted as confirmed: no proof was
    // ever approved for it.
    await createDraftBooking({ status: 'COMPLETED', branchId: branch1, bookingCode: 'D444444444', sentAt: '2026-07-15T02:00:00.000Z', completedAt: '2026-07-15T03:00:00.000Z' });

    const res = await adminAgent.get('/api/admin/dashboard/summary');
    expect(res.status).toBe(200);
    // waiting counts bookings at NEW that are NOT yet approved, so the
    // confirmed one has left that queue. sentToday counts all four.
    expect(res.body.totals).toEqual({ waiting: 2, confirmedToday: 1, lastMinute: 1, sentToday: 4 });

    const b1 = res.body.branches.find((x: { branch: { id: number } }) => x.branch.id === branch1);
    const b2 = res.body.branches.find((x: { branch: { id: number } }) => x.branch.id === branch2);
    expect(b1).toMatchObject({ waiting: 1, confirmedToday: 1, lastMinute: 0 });
    expect(b2).toMatchObject({ waiting: 1, confirmedToday: 0, lastMinute: 1 });
    // All 8 seeded branches appear (even with zero activity).
    expect(res.body.branches).toHaveLength(8);
  });

  it('forbids a receptionist', async () => {
    await createReceptionist(branch1, { username: 'letan', mustChangePassword: false });
    const { agent } = await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD);
    const res = await agent.get('/api/admin/dashboard/summary');
    expect(res.status).toBe(403);
  });
});

/* ================================================================== */
/* Every card counts ONE population: the orders sent in the scope       */
/* ================================================================== */

/**
 * The rule these cases exist to pin.
 *
 * The dashboard used to count its four cards on four different date axes — a
 * running backlog, a review date, a check-in date, and a dispatch date — so
 * "Tổng đơn gửi = 4" could sit beside a "Chờ chi nhánh tạo" of 40 counting
 * orders dispatched weeks earlier, and the branch rows never summed to the
 * total printed above them.
 *
 * Now there is one population — the orders DISPATCHED inside the selected scope
 * — and every counter is a property of it. So the test that matters is not "is
 * each number right" but "can a booking outside the scope move ANY number", and
 * that is what most of these assert.
 */
describe('the dashboard counts one date-scoped population', () => {
  const DAY = '2026-09-15';
  const DAY_BEFORE = '2026-09-14';

  /** 09:00 Asia/Ho_Chi_Minh on `day` — comfortably inside it, in UTC. */
  const during = (day: string) => `${day}T02:00:00.000Z`;

  /** The first instant of `day` in Asia/Ho_Chi_Minh, as UTC. */
  const startOfHcmDay = (day: string) =>
    new Date(Date.parse(`${day}T00:00:00.000Z`) - 7 * 60 * 60 * 1000).toISOString();

  async function sent(
    day: string,
    over: { lastMinute?: boolean; approved?: boolean; branchId?: number; at?: string } = {},
  ) {
    const b = await createDraftBooking({
      status: 'NEW',
      branchId: over.branchId ?? branch1,
      bookingCode: `BK${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      isLastMinute: over.lastMinute ?? false,
      sentAt: over.at ?? during(day),
    });
    if (over.approved) {
      await testPrisma.booking.update({
        where: { id: b.id },
        data: { verificationStatus: 'APPROVED', reviewedAt: new Date(during(day)) },
      });
    }
    return b.id;
  }

  const summary = async (params: string) => {
    const res = await adminAgent.get(`/api/admin/dashboard/summary?${params}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
    return res.body;
  };

  it('CASE 1 — counts only the orders sent on the selected day', async () => {
    for (let i = 0; i < 4; i += 1) await sent(DAY);
    for (let i = 0; i < 5; i += 1) await sent(DAY_BEFORE);

    const today = await summary(`date=${DAY}`);
    expect(today.totals.sentToday).toBe(4);
    /*
      The five older orders are all still NEW and unapproved, so under the old
      running-backlog rule they counted here too. Asserting `waiting` alongside
      the total is what makes this case discriminate: on the numbers alone,
      `sentToday` behaved identically before and after the change.
    */
    expect(today.totals.waiting).toBe(4);

    // And the previous day keeps its own five — neither leaks into the other.
    const before = await summary(`date=${DAY_BEFORE}`);
    expect(before.totals.sentToday).toBe(5);
    expect(before.totals.waiting).toBe(5);
  });

  it('CASE 2 — LAST MINUTE is a property of the same four', async () => {
    await sent(DAY, { lastMinute: true });
    await sent(DAY, { lastMinute: true });
    await sent(DAY);
    await sent(DAY);
    // Last-minute, but dispatched the day before: it belongs to that day.
    await sent(DAY_BEFORE, { lastMinute: true });

    const body = await summary(`date=${DAY}`);
    expect(body.totals.sentToday).toBe(4);
    expect(body.totals.lastMinute).toBe(2);
  });

  it('CASE 3 — an older order cannot move the workflow counters', async () => {
    /*
      The defect in one case. Both older bookings are still operationally live —
      one awaiting creation, one approved — so under the old running-backlog and
      reviewed-on-day rules they counted against whichever day was being viewed.
    */
    await sent(DAY_BEFORE);
    await sent(DAY_BEFORE, { approved: true });

    const empty = await summary(`date=${DAY}`);
    expect(empty.totals).toEqual({ waiting: 0, confirmedToday: 0, lastMinute: 0, sentToday: 0 });

    // The same two orders are fully accounted for on the day they were sent.
    const theirDay = await summary(`date=${DAY_BEFORE}`);
    expect(theirDay.totals).toEqual({ waiting: 1, confirmedToday: 1, lastMinute: 0, sentToday: 2 });
  });

  it('CASE 3b — every counter is a subset of the orders sent in scope', async () => {
    // The invariant that makes the page readable: no card may exceed the total.
    await sent(DAY, { lastMinute: true });
    await sent(DAY, { approved: true });
    await sent(DAY);
    await sent(DAY_BEFORE);
    await sent(DAY_BEFORE, { approved: true });

    const { totals } = await summary(`date=${DAY}`);
    expect(totals.sentToday).toBe(3);
    expect(totals.waiting).toBeLessThanOrEqual(totals.sentToday);
    expect(totals.confirmedToday).toBeLessThanOrEqual(totals.sentToday);
    expect(totals.lastMinute).toBeLessThanOrEqual(totals.sentToday);
    // waiting = sent - approved, because every fixture here is still NEW.
    expect(totals.waiting).toBe(totals.sentToday - totals.confirmedToday);
  });

  it('CASE 4 — an inclusive range covers every day between its ends', async () => {
    for (let i = 0; i < 2; i += 1) await sent('2026-09-15');
    for (let i = 0; i < 3; i += 1) await sent('2026-09-16');
    for (let i = 0; i < 4; i += 1) await sent('2026-09-17');
    await sent('2026-09-18');

    const body = await summary('from=2026-09-15&to=2026-09-17');
    expect(body.totals.sentToday).toBe(9);
    // The 18th is outside the range and must not be counted.
    expect(body.range).toEqual({ from: '2026-09-15', to: '2026-09-17' });
  });

  it('CASE 4b — a one-day range equals the same day as ?date=', async () => {
    await sent(DAY);
    await sent(DAY);
    await sent(DAY_BEFORE);

    const byDate = await summary(`date=${DAY}`);
    const byRange = await summary(`from=${DAY}&to=${DAY}`);
    expect(byRange.totals).toEqual(byDate.totals);
  });

  it('CASE 5 — the branch breakdown uses the same scope and sums to the total', async () => {
    await sent(DAY, { branchId: branch1 });
    await sent(DAY, { branchId: branch1, lastMinute: true });
    await sent(DAY, { branchId: branch2, approved: true });
    // Older orders at both branches: invisible to this day's rows.
    await sent(DAY_BEFORE, { branchId: branch1 });
    await sent(DAY_BEFORE, { branchId: branch2, approved: true });

    const body = await summary(`date=${DAY}`);
    type Row = { branch: { id: number }; waiting: number; confirmedToday: number; lastMinute: number; sent: number };
    const rows = body.branches as Row[];
    const row = (id: number) => rows.find((r) => r.branch.id === id)!;

    expect(row(branch1)).toMatchObject({ sent: 2, waiting: 2, confirmedToday: 0, lastMinute: 1 });
    expect(row(branch2)).toMatchObject({ sent: 1, waiting: 0, confirmedToday: 1, lastMinute: 0 });

    // THE RECONCILIATION: the rows account for the card above them exactly.
    const summed = rows.reduce((t, r) => t + r.sent, 0);
    expect(summed).toBe(body.totals.sentToday);
    expect(rows.reduce((t, r) => t + r.waiting, 0)).toBe(body.totals.waiting);
    expect(rows.reduce((t, r) => t + r.confirmedToday, 0)).toBe(body.totals.confirmedToday);
    expect(rows.reduce((t, r) => t + r.lastMinute, 0)).toBe(body.totals.lastMinute);
  });

  it('CASE 6 — the scope is half-open on the property clock', async () => {
    /*
      MANDATORY BOUNDARY CASE. The window is [start of `from`, start of the day
      after `to`) in Asia/Ho_Chi_Minh. Both fixtures sit exactly on a boundary
      instant, which is where an end-of-day `lte` implementation goes wrong.
    */
    await sent(DAY, { at: startOfHcmDay(DAY) }); // 00:00:00.000 on the first day — IN
    await sent(DAY, { at: startOfHcmDay('2026-09-16') }); // 00:00:00.000 the day after — OUT

    const oneDay = await summary(`date=${DAY}`);
    expect(oneDay.totals.sentToday).toBe(1);

    // The excluded one belongs to the next day, and a range that reaches it
    // picks it up — the boundary moves, nothing is lost.
    expect((await summary('from=2026-09-15&to=2026-09-16')).totals.sentToday).toBe(2);
  });

  it('CASE 6b — the boundary is Vietnam midnight, not UTC midnight', async () => {
    // 23:30 HCM on the 15th is 16:30Z on the 15th. A UTC-midnight window would
    // put it on the 15th too — so the distinguishing fixture is the other side:
    // 00:30 HCM on the 15th is 17:30Z on the 14th, which UTC would call the 14th.
    await sent(DAY, { at: '2026-09-14T17:30:00.000Z' });

    expect((await summary(`date=${DAY}`)).totals.sentToday).toBe(1);
    expect((await summary(`date=${DAY_BEFORE}`)).totals.sentToday).toBe(0);
  });

  it('refuses an inverted range rather than showing an unexplained zero', async () => {
    const res = await adminAgent.get('/api/admin/dashboard/summary?from=2026-09-17&to=2026-09-15');
    expect(res.status).toBe(422);
  });

  it('refuses half a range, which would otherwise be completed into an inverted one', async () => {
    /*
      `?to=<past day>` alone used to be accepted and its missing start filled in
      from the clock, producing from=today..to=<past day> — the very inverted
      scope the check below exists to refuse, arriving with a 200 and a page of
      unexplained zeroes. A range needs both of its ends.
    */
    expect((await adminAgent.get('/api/admin/dashboard/summary?to=2026-09-01')).status).toBe(422);
    expect((await adminAgent.get('/api/admin/dashboard/summary?from=2026-09-01')).status).toBe(422);
  });

  it('refuses a single date and a range in the same request', async () => {
    const res = await adminAgent.get(
      '/api/admin/dashboard/summary?date=2026-09-15&from=2026-09-15&to=2026-09-16',
    );
    expect(res.status).toBe(422);
  });

  it('still echoes the scope back, so the page cannot show another period', async () => {
    expect((await summary(`date=${DAY}`)).range).toEqual({ from: DAY, to: DAY });
    expect((await summary(`date=${DAY}`)).date).toBe(DAY);
  });
});
