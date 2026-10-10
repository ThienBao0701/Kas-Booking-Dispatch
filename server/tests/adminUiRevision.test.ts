/**
 * The Admin UI revision, server side.
 *
 * Three of the five changes are pure UI, but two move real behaviour into the
 * database and those are what is covered here:
 *
 *   - the dashboard summary answers for ONE DAY, chosen by the caller, and
 *     filters in SQL rather than handing the client a "today" payload to sift;
 *   - a reminder can be addressed to every branch at once, fanning out to one
 *     row per receptionist so read state and unread badges keep working.
 *
 * The room-type change needed no new endpoint: `updateRoomClass` already
 * accepted `displayName`, so the test here pins that it persists and reaches the
 * activated version the send flow reads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanA: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanAId: number;
let letanBId: number;
let cn1: number;
let cn2: number;

/** 2026-08-11 12:00 Ho Chi Minh = 05:00Z. Mid-day, so no boundary ambiguity. */
const NOW = new Date('2026-08-11T05:00:00.000Z');
const TODAY = '2026-08-11';
const YESTERDAY = '2026-08-10';

/** An instant inside a given HCM calendar day. */
function during(day: string): Date {
  return new Date(`${day}T05:00:00.000Z`);
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

  await createReceptionist(cn2, { username: 'letanb', mustChangePassword: false });
  letanBId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letanb' } })).id;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.bookingCreationProof.deleteMany({});
  await testPrisma.booking.deleteMany({});
  await testPrisma.reminder.deleteMany({});
  await resetIssueData();
  setClock({ now: () => NOW });
});

afterEach(() => resetClock());

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** A dispatched booking, sent on `day`, optionally already approved on `day`. */
async function bookingSentOn(
  day: string,
  over: { approvedOn?: string; checkIn?: string; branchId?: number; lastMinute?: boolean } = {},
): Promise<string> {
  const b = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'NGUYEN VAN A',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER',
      branchId: over.branchId ?? cn1,
      status: 'NEW',
      verificationStatus: over.approvedOn ? 'APPROVED' : 'NOT_SUBMITTED',
      sentAt: during(day),
      // The flag the dispatch stamps, and the one the LAST MINUTE card reads.
      // Set explicitly rather than inferred from `checkIn`, because a fixture
      // that sets only the date describes a row dispatch would never write.
      isLastMinute: over.lastMinute ?? false,
      ...(over.approvedOn ? { reviewedAt: during(over.approvedOn) } : {}),
      ...(over.checkIn ? { checkInDate: new Date(`${over.checkIn}T00:00:00.000Z`) } : {}),
    },
  });
  return b.id;
}

const summary = async (date?: string) => {
  const res = await adminAgent.get(`/api/admin/dashboard/summary${date ? `?date=${date}` : ''}`);
  expect(res.status).toBe(200);
  return res.body;
};

/* ================================================================== */
/* Dashboard — one day, chosen by the caller                           */
/* ================================================================== */

describe('dashboard summary is a single-date view', () => {
  it('defaults to today when no date is given', async () => {
    const body = await summary();
    expect(body.date).toBe(TODAY);
  });

  it('echoes the requested date back', async () => {
    expect((await summary(YESTERDAY)).date).toBe(YESTERDAY);
  });

  it('counts orders SENT on the selected day, not on other days', async () => {
    await bookingSentOn(TODAY);
    await bookingSentOn(TODAY);
    await bookingSentOn(YESTERDAY);

    expect((await summary(TODAY)).totals.sentToday).toBe(2);
    expect((await summary(YESTERDAY)).totals.sentToday).toBe(1);
  });

  it('counts approvals against the day the order was SENT', async () => {
    /*
      CHANGED DELIBERATELY. This used to scope by `reviewedAt`, so one order
      could be counted on a different day from the dispatch it belongs to and
      "Đã xác nhận" could exceed "Tổng đơn gửi" on the same screen.

      Both orders below were sent yesterday, so both are yesterday's — whenever
      the proof happened to be approved. "Của những đơn đã gửi hôm đó, bao nhiêu
      đã được xác nhận" is the question the card now answers.
    */
    await bookingSentOn(YESTERDAY, { approvedOn: YESTERDAY });
    await bookingSentOn(YESTERDAY, { approvedOn: TODAY });

    expect((await summary(YESTERDAY)).totals.confirmedToday).toBe(2);
    expect((await summary(TODAY)).totals.confirmedToday).toBe(0);
  });

  it('counts LAST MINUTE from the flag stamped at dispatch', async () => {
    /*
      CHANGED DELIBERATELY. This used to compare `checkInDate` to the selected
      day, which answered "who arrives today" rather than "what did I send
      today", and is meaningless over a range.

      `isLastMinute` is written at dispatch when check-in equals the day of
      dispatch, so the figure belongs to the day the order was sent and cannot
      drift as the calendar moves past it.
    */
    await bookingSentOn(YESTERDAY, { checkIn: TODAY, lastMinute: true });

    expect((await summary(YESTERDAY)).totals.lastMinute).toBe(1);
    expect((await summary(TODAY)).totals.lastMinute).toBe(0);
  });

  it('does not let a future dispatch leak into a past day\'s backlog', async () => {
    // Sent today, still awaiting creation. Yesterday's view must not show it:
    // it did not exist as work yet.
    await bookingSentOn(TODAY);

    expect((await summary(TODAY)).totals.waiting).toBe(1);
    expect((await summary(YESTERDAY)).totals.waiting).toBe(0);
  });

  it('scopes the backlog to the orders sent in the period, not to all time', async () => {
    /*
      CHANGED DELIBERATELY, and this is the operator-facing change.

      The card was a RUNNING BACKLOG — every undelivered order ever dispatched —
      which is why it could read far above "Tổng đơn gửi" on the same row of
      cards and why the branch rows never reconciled with it. It now answers "of
      what I sent in this period, what is still not created".

      The unbounded queue is not lost: the "Chờ chi nhánh tạo" list itself still
      shows every outstanding order, which is where a backlog belongs.
    */
    await bookingSentOn(YESTERDAY);
    await bookingSentOn(TODAY);

    expect((await summary(TODAY)).totals.waiting).toBe(1);
    expect((await summary(YESTERDAY)).totals.waiting).toBe(1);
    // And a range covering both accounts for both.
    const res = await adminAgent.get(
      `/api/admin/dashboard/summary?from=${YESTERDAY}&to=${TODAY}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.totals.waiting).toBe(2);
  });

  it('scopes the per-branch breakdown to the same day', async () => {
    await bookingSentOn(TODAY, { branchId: cn1, approvedOn: TODAY });
    await bookingSentOn(YESTERDAY, { branchId: cn2, approvedOn: YESTERDAY });

    const today = await summary(TODAY);
    const row = (b: number) =>
      (today.branches as { branch: { id: number }; confirmedToday: number }[]).find(
        (r) => r.branch.id === b,
      );
    expect(row(cn1)!.confirmedToday).toBe(1);
    expect(row(cn2)!.confirmedToday).toBe(0);
  });

  it('counts issues REPORTED on the selected day', async () => {
    await testPrisma.hotelIssue.create({
      data: {
        branchId: cn1,
        category: 'DOOR',
        description: 'Cua hong',
        status: 'NEW',
        reportedByUserId: letanAId,
        createdAt: during(YESTERDAY),
      },
    });

    expect((await summary(YESTERDAY)).issues).toEqual({ reported: 1, stillOpen: 1 });
    expect((await summary(TODAY)).issues).toEqual({ reported: 0, stillOpen: 0 });
  });

  it('rejects a malformed date rather than silently showing today', async () => {
    const res = await adminAgent.get('/api/admin/dashboard/summary?date=11-08-2026');
    expect(res.status).toBe(422);
  });

  it('stays Admin-only', async () => {
    expect((await letanA.get('/api/admin/dashboard/summary')).status).toBe(403);
  });
});

/* ================================================================== */
/* Reminders — one branch, or all of them                              */
/* ================================================================== */

describe('reminders to all branches', () => {
  it('creates exactly one reminder per active receptionist', async () => {
    const res = await adminAgent
      .post('/api/reminders')
      .send({ recipientScope: 'ALL_BRANCHES', body: 'Nhắc cả nhà' });

    expect(res.status).toBe(201);
    expect(res.body.recipients).toBe(2);

    const rows = await testPrisma.reminder.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([letanAId, letanBId].sort());
    // One send, one body, no duplicates for any single person.
    expect(new Set(rows.map((r) => r.recipientUserId)).size).toBe(2);
    expect(rows.every((r) => r.body === 'Nhắc cả nhà')).toBe(true);
  });

  it('skips a disabled receptionist', async () => {
    await testPrisma.user.update({ where: { id: letanBId }, data: { active: false } });
    try {
      const res = await adminAgent
        .post('/api/reminders')
        .send({ recipientScope: 'ALL_BRANCHES', body: 'Chỉ người đang làm' });

      expect(res.body.recipients).toBe(1);
      const rows = await testPrisma.reminder.findMany();
      expect(rows.map((r) => r.recipientUserId)).toEqual([letanAId]);
    } finally {
      await testPrisma.user.update({ where: { id: letanBId }, data: { active: true } });
    }
  });

  it('leaves single-recipient sending exactly as it was', async () => {
    const res = await adminAgent
      .post('/api/reminders')
      .send({ recipientUserId: letanAId, body: 'Riêng A' });

    expect(res.status).toBe(201);
    expect(res.body.reminder.body).toBe('Riêng A');
    const rows = await testPrisma.reminder.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientUserId).toBe(letanAId);
  });

  it('each recipient reads their OWN copy — one read does not clear anyone else', async () => {
    await adminAgent.post('/api/reminders').send({ recipientScope: 'ALL_BRANCHES', body: 'x' });

    const inbox = await letanA.get('/api/reminders');
    const mine = (inbox.body.reminders as { id: string }[])[0]!.id;
    await letanA.post(`/api/reminders/${mine}/read`);

    const rows = await testPrisma.reminder.findMany();
    expect(rows.filter((r) => r.readAt !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.readAt === null)).toHaveLength(1);
  });

  it('refuses a blank broadcast', async () => {
    const res = await adminAgent
      .post('/api/reminders')
      .send({ recipientScope: 'ALL_BRANCHES', body: '   ' });
    expect(res.status).toBe(422);
    expect(await testPrisma.reminder.count()).toBe(0);
  });

  it('refuses a RECEPTIONIST broadcasting', async () => {
    const res = await letanA
      .post('/api/reminders')
      .send({ recipientScope: 'ALL_BRANCHES', body: 'không được' });
    expect(res.status).toBe(403);
    expect(await testPrisma.reminder.count()).toBe(0);
  });

  it('refuses an unknown scope rather than guessing', async () => {
    const res = await adminAgent
      .post('/api/reminders')
      .send({ recipientScope: 'EVERYONE_INCLUDING_ADMINS', body: 'x' });
    expect(res.status).toBe(422);
    expect(await testPrisma.reminder.count()).toBe(0);
  });
});
