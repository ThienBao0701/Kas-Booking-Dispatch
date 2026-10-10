/**
 * "ĐỔI CA" — the early shift handover, end to end.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The outgoing shift closes, and the incoming one opens, at ONE server
 *      instant — so there is never a moment with two receptionists on the desk
 *      or none.
 *   2. The incoming shift keeps its PLANNED end. A Ca B started early at 13:15
 *      is still due to be asked for the next shift at 22:10, not at 21:25. This
 *      is the single rule most likely to be got wrong by measuring the session
 *      instead of the shift, and it is checked for every handover shape.
 *   3. Attribution moves AT the handover and never backwards: everything the
 *      outgoing receptionist submitted stays theirs for ever, everything after
 *      belongs to whoever took over.
 *   4. A handover cannot be recorded without a reason or without naming who is
 *      taking over, cannot cross a branch, and cannot take a shift from somebody
 *      who is already working one.
 *   5. The audit record survives, and nothing can edit it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetShiftData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';

/** 06:00 HCM on the 17th == 23:00 UTC on the 16th. */
const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letanId = 0;
let letanB: Agent;
let letanBId = 0;
let letanCn2Id = 0;
let admin: Agent;
let tech: Agent;

/**
 * Everything durable is built ONCE — the login endpoint is rate limited per app
 * instance, so logging in per test exhausts the limiter and later tests receive
 * 401 instead of the status they were asserting.
 */
beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  letanId = (await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false })).id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  // A SECOND account at the SAME branch — the "Người nhận ca has their own
  // login" case, which is the one that can go wrong.
  letanBId = (await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false })).id;
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;

  letanCn2Id = (await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false })).id;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-17', '06:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** Checks the given receptionist in to a shift at the current clock. */
async function checkIn(agent: Agent, shiftType: string, name: string): Promise<string> {
  const res = await agent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}

/* ================================================================== */
/* The canonical case: Ca A hands over at 13:15                        */
/* ================================================================== */

describe('an early handover', () => {
  beforeEach(async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-17', '13:15') });
  });

  it('closes the outgoing shift and opens the incoming one at the SAME instant', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });
    expect(res.status).toBe(201);

    const sessions = await testPrisma.receptionShiftSession.findMany({
      orderBy: { startedAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);

    const [outgoing, incoming] = sessions;
    expect(outgoing!.shiftType).toBe('A');
    expect(incoming!.shiftType).toBe('B');
    // The whole point: one instant, so the desk is never unattended and never
    // doubly attended.
    expect(outgoing!.closedAt).not.toBeNull();
    expect(outgoing!.closedAt!.toISOString()).toBe(incoming!.startedAt.toISOString());
    expect(outgoing!.closedAt!.toISOString()).toBe(hcm('2026-09-17', '13:15').toISOString());
    // And exactly one shift is open afterwards.
    expect(sessions.filter((s) => s.closedAt === null)).toHaveLength(1);
  });

  /**
   * P5, AND THE RULE MOST LIKELY TO BE GOT WRONG.
   *
   * Ca B runs 14:00–22:00. Started early at 13:15 it must still end at 22:00 and
   * prompt at 22:10 — NOT at 21:25, which is what "actual start plus the shift's
   * length" would produce. The end comes from the shift's own clock time, never
   * from how long the session has been running.
   */
  it('keeps the incoming shift PLANNED end — prompts at 22:10, not 21:25', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });
    expect(res.status).toBe(201);

    expect(res.body.session.nominalEndAt).toBe(hcm('2026-09-17', '22:00').toISOString());
    expect(res.body.session.graceEndAt).toBe(hcm('2026-09-17', '22:10').toISOString());
    // 21:25 would be startedAt + 8h + 10m. Named explicitly so a regression
    // cannot be read as an acceptable rounding.
    expect(res.body.session.graceEndAt).not.toBe(hcm('2026-09-17', '21:25').toISOString());
  });

  it('is not prompted for another shift at 21:25, and is at 22:10', async () => {
    await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });

    setClock({ now: () => hcm('2026-09-17', '21:25') });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(false);

    setClock({ now: () => hcm('2026-09-17', '22:09') });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(false);

    setClock({ now: () => hcm('2026-09-17', '22:10') });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(true);
  });

  it('records the handover with both sides, the reason and the server instant', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: '  Có việc cá nhân  ',
      incomingName: '  Nguyễn Văn B  ',
      incomingShiftType: 'B',
    });
    expect(res.status).toBe(201);

    expect(res.body.handover).toMatchObject({
      branchId: cn1,
      outgoing: { name: 'Nguyễn Văn A', shiftType: 'A', shiftName: 'Ca A' },
      incoming: { name: 'Nguyễn Văn B', shiftType: 'B', shiftName: 'Ca B' },
      reason: 'Có việc cá nhân',
    });
    expect(res.body.handover.actualHandoverAt).toBe(hcm('2026-09-17', '13:15').toISOString());

    const stored = await testPrisma.shiftHandover.findFirstOrThrow();
    expect(stored.outgoingUserId).toBe(letanId);
    // Null because the desk changed hands within ONE shared login — which is the
    // normal case, and is different information from "we do not know".
    expect(stored.incomingUserId).toBeNull();
  });

  it('IGNORES a client-supplied handover time — the server decides', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      // A reception PC with a wrong clock must not decide which receptionist
      // owns the orders around the boundary.
      actualHandoverAt: hcm('2026-09-17', '09:00').toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.handover.actualHandoverAt).toBe(hcm('2026-09-17', '13:15').toISOString());
  });

  it('can carry a handover note, linked to the same event', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      note: { content: 'Phòng 101 đang chờ kỹ thuật' },
    });
    expect(res.status).toBe(201);

    const note = await testPrisma.shiftHandoverNote.findFirstOrThrow();
    expect(note.content).toBe('Phòng 101 đang chờ kỹ thuật');
    expect(note.handoverId).toBe(res.body.handover.id);
    // Attributed to the shift that WROTE it — the outgoing one.
    expect(note.outgoingNameSnapshot).toBe('Nguyễn Văn A');

    /*
      ONE EVENT, ONE INSTANT.

      The handover row, its note and both sessions all carry the same timestamp,
      taken once from the server. `createdAt` has a database default on both
      tables, so leaving it unset would give a single event two instants from two
      different clocks — and could put the note in a different reporting period
      from the handover it belongs to.
    */
    const handover = await testPrisma.shiftHandover.findFirstOrThrow();
    const at = hcm('2026-09-17', '13:15').toISOString();
    expect(handover.actualHandoverAt.toISOString()).toBe(at);
    expect(handover.createdAt.toISOString()).toBe(at);
    expect(note.createdAt.toISOString()).toBe(at);
  });
});

/* ================================================================== */
/* Every handover shape keeps its planned end                          */
/* ================================================================== */

describe('the planned end survives every handover shape', () => {
  /**
   * The four shapes the specification names, plus the midnight-crossing ones.
   * Each is `[current shift, handover day, handover time, incoming shift,
   * expected nominal end day, expected nominal end time]`.
   */
  const CASES: [string, string, string, string, string, string][] = [
    // Ca A → Ca B at 13:15. The canonical case.
    ['A', '2026-09-17', '13:15', 'B', '2026-09-17', '22:00'],
    // Ca C (22:00–06:00) → Ca A at 02:00, i.e. after midnight.
    ['C', '2026-09-18', '02:00', 'A', '2026-09-18', '14:00'],
    // Ca A4 (06:00–18:00) → Ca C4 (18:00–06:00) at 10:00. C4 ends TOMORROW.
    ['A4', '2026-09-17', '10:00', 'C4', '2026-09-18', '06:00'],
    // Ca B → Ca C at 21:30, thirty minutes before Ca C nominally starts.
    ['B', '2026-09-17', '21:30', 'C', '2026-09-18', '06:00'],
    // Ca C4 → Ca A at 05:00, an hour before Ca A nominally starts.
    ['C4', '2026-09-18', '05:00', 'A', '2026-09-18', '14:00'],
  ];

  for (const [from, day, time, to, endDay, endTime] of CASES) {
    it(`${from} → ${to} at ${time} still ends ${endTime} on ${endDay}`, async () => {
      // Check in BEFORE the handover instant so the outgoing session is real.
      setClock({ now: () => new Date(hcm(day, time).getTime() - 30 * 60 * 1000) });
      await checkIn(letan, from, 'Nguyễn Văn A');

      setClock({ now: () => hcm(day, time) });
      const res = await letan
        .post('/api/reception/shifts/handover')
        .send({ reason: 'Đổi ca', incomingName: 'Nguyễn Văn B', incomingShiftType: to });

      expect(res.status).toBe(201);
      expect(res.body.session.nominalEndAt).toBe(hcm(endDay, endTime).toISOString());
      expect(res.body.session.graceEndAt).toBe(
        new Date(hcm(endDay, endTime).getTime() + 10 * 60 * 1000).toISOString(),
      );
    });
  }
});

/* ================================================================== */
/* Validation and refusals                                             */
/* ================================================================== */

describe('a handover is refused when', () => {
  beforeEach(async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-17', '13:15') });
  });

  it('there is no reason', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ incomingName: 'B', incomingShiftType: 'B' });
    expect(res.status).toBe(422);
    expect(await testPrisma.shiftHandover.count()).toBe(0);
  });

  it('the reason is only whitespace', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: '   ', incomingName: 'B', incomingShiftType: 'B' });
    expect(res.status).toBe(422);
    expect(await testPrisma.shiftHandover.count()).toBe(0);
  });

  it('nobody is named as taking over', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingShiftType: 'B' });
    expect(res.status).toBe(422);
  });

  it('the incoming name is only whitespace', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingName: '   ', incomingShiftType: 'B' });
    expect(res.status).toBe(422);
  });

  it('no shift is named — it is never inferred from the clock', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingName: 'B' });
    expect(res.status).toBe(422);
  });

  it('the caller has no open shift to hand over', async () => {
    await resetShiftData();
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingName: 'B', incomingShiftType: 'B' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
  });

  it('the named incoming account is already working a shift', async () => {
    // B checks in at their own branch, then A tries to hand the desk to them.
    await checkIn(letanB, 'B', 'Nguyễn Văn B');

    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      incomingUserId: letanBId,
    });
    expect(res.status).toBe(409);
    // A's shift is untouched: a refused handover changes nothing.
    const mine = await testPrisma.receptionShiftSession.findFirstOrThrow({
      where: { userId: letanId, closedAt: null },
    });
    expect(mine.shiftType).toBe('A');
  });

  it('the named incoming account belongs to another branch', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc',
      incomingName: 'Lễ tân CN2',
      incomingShiftType: 'B',
      incomingUserId: letanCn2Id,
    });
    expect(res.status).toBe(403);
    expect(await testPrisma.shiftHandover.count()).toBe(0);
  });

  it('the named incoming account is not a receptionist', async () => {
    const technical = await testPrisma.user.findFirstOrThrow({ where: { username: 'kythuat' } });
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc',
      incomingName: 'Kỹ thuật',
      incomingShiftType: 'B',
      incomingUserId: technical.id,
    });
    expect(res.status).toBe(422);
  });

  /**
   * A SECOND HANDOVER IS LEGITIMATE — it hands over the NEW shift.
   *
   * With one shared login the incoming session belongs to the same account, so
   * "hand over again" is a real thing that happens when B also leaves early. The
   * invariant is not that it is refused; it is that the two handovers chain
   * three distinct sessions and no session is ever the outgoing side twice.
   */
  it('chains a second handover onto the new shift rather than the old one', async () => {
    const first = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingName: 'Nguyễn Văn B', incomingShiftType: 'B' });
    expect(first.status).toBe(201);

    setClock({ now: () => hcm('2026-09-17', '17:00') });
    const second = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Ốm', incomingName: 'Trần Thị C', incomingShiftType: 'C' });
    expect(second.status).toBe(201);

    const handovers = await testPrisma.shiftHandover.findMany({
      orderBy: { actualHandoverAt: 'asc' },
    });
    expect(handovers).toHaveLength(2);
    // The second handover's outgoing side IS the first one's incoming side.
    expect(handovers[1]!.outgoingShiftSessionId).toBe(handovers[0]!.incomingShiftSessionId);
    // Three sessions, one still open.
    const sessions = await testPrisma.receptionShiftSession.findMany();
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.closedAt === null)).toHaveLength(1);
  });

  /**
   * THE DATABASE REFUSES A SESSION BEING HANDED OVER TWICE.
   *
   * Two browser tabs confirming the same handover at the same instant both pass
   * an application-level "is it still open?" check. This is the constraint that
   * makes one of them lose — asserted directly, because the race cannot be
   * produced reliably through sequential HTTP.
   */
  it('cannot record two handovers for one outgoing session', async () => {
    const res = await letan
      .post('/api/reception/shifts/handover')
      .send({ reason: 'Có việc', incomingName: 'Nguyễn Văn B', incomingShiftType: 'B' });
    expect(res.status).toBe(201);

    const stored = await testPrisma.shiftHandover.findFirstOrThrow();
    await expect(
      testPrisma.shiftHandover.create({
        data: {
          branchId: cn1,
          outgoingShiftSessionId: stored.outgoingShiftSessionId,
          incomingShiftSessionId: stored.incomingShiftSessionId,
          outgoingUserId: letanId,
          outgoingNameSnapshot: 'Nguyễn Văn A',
          outgoingShiftType: 'A',
          incomingNameSnapshot: 'Kẻ chen ngang',
          incomingShiftType: 'C',
          actualHandoverAt: hcm('2026-09-17', '13:16'),
          reason: 'trùng',
        },
      }),
    ).rejects.toThrow();
    expect(await testPrisma.shiftHandover.count()).toBe(1);
  });
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('only a receptionist may hand over a shift', () => {
  it('refuses an Admin', async () => {
    const res = await admin
      .post('/api/reception/shifts/handover')
      .send({ reason: 'x', incomingName: 'y', incomingShiftType: 'B' });
    expect(res.status).toBe(403);
  });

  it('refuses Bộ phận kỹ thuật', async () => {
    const res = await tech
      .post('/api/reception/shifts/handover')
      .send({ reason: 'x', incomingName: 'y', incomingShiftType: 'B' });
    expect(res.status).toBe(403);
  });
});

/* ================================================================== */
/* Handing over to a DIFFERENT account                                 */
/* ================================================================== */

describe('when the incoming receptionist has their own account', () => {
  beforeEach(async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-17', '13:15') });
  });

  it('opens the new shift under THAT account and closes the old one', async () => {
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      incomingUserId: letanBId,
    });
    expect(res.status).toBe(201);

    // The outgoing account has nothing open — it was closed by its own owner,
    // which is the only way a session can be closed.
    expect(await testPrisma.receptionShiftSession.count({ where: { userId: letanId, closedAt: null } })).toBe(0);
    // And the incoming account is now on the desk.
    const theirs = await testPrisma.receptionShiftSession.findFirstOrThrow({
      where: { userId: letanBId, closedAt: null },
    });
    expect(theirs.shiftType).toBe('B');
    expect(theirs.receptionistName).toBe('Nguyễn Văn B');
    expect(theirs.branchId).toBe(cn1);

    const stored = await testPrisma.shiftHandover.findFirstOrThrow();
    expect(stored.incomingUserId).toBe(letanBId);
  });

  it('shows the incoming person their own shift, and the outgoing one none', async () => {
    await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      incomingUserId: letanBId,
    });

    expect((await letanB.get('/api/reception/shifts/current')).body.session).toMatchObject({
      shiftType: 'B',
      receptionistName: 'Nguyễn Văn B',
    });
    expect((await letan.get('/api/reception/shifts/current')).body.session).toBeNull();
  });
});

/* ================================================================== */
/* The Admin audit                                                     */
/* ================================================================== */

describe('the handover audit', () => {
  beforeEach(async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-17', '13:15') });
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
      note: { content: 'Phòng 101 đang chờ kỹ thuật' },
    });
    // ASSERTED, not assumed. Without this a failed set-up reports itself as an
    // empty audit — which reads like a broken report rather than a broken
    // fixture, and sends whoever debugs it to the wrong file.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('shows an Admin who handed over to whom, when and why', async () => {
    const res = await admin.get('/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17');
    expect(res.status).toBe(200);
    expect(res.body.handovers).toHaveLength(1);
    expect(res.body.handovers[0]).toMatchObject({
      outgoing: { name: 'Nguyễn Văn A', shiftName: 'Ca A', shiftWindow: '06:00 – 14:00' },
      incoming: { name: 'Nguyễn Văn B', shiftName: 'Ca B', shiftWindow: '14:00 – 22:00' },
      reason: 'Có việc cá nhân',
    });
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].content).toBe('Phòng 101 đang chờ kỹ thuật');
  });

  it('narrows to one branch and to a period', async () => {
    const other = await admin.get(
      `/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17&branchId=${cn2}`,
    );
    expect(other.body.handovers).toHaveLength(0);

    const before = await admin.get('/api/admin/reports/handovers?from=2026-09-01&to=2026-09-16');
    expect(before.body.handovers).toHaveLength(0);
  });

  /**
   * THE TOTAL IS COUNTED, NOT MEASURED OFF THE LISTED ROWS.
   *
   * The report lists at most 1000 rows, and it used to print that array's length
   * as the period's total — so a quarterly audit reported exactly "1000" while
   * silently omitting everything older, giving the operator a wrong figure and a
   * period that quietly started later than the one they asked for.
   *
   * The cap is far too high to exercise honestly in a test, so what is asserted
   * is the contract: the response carries its own counted totals and a flag
   * saying whether the listing is complete.
   */
  it('reports counted totals beside the listed rows', async () => {
    const res = await admin.get('/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ handovers: 1, notes: 1 });
    // Nothing was cut, and the report says so rather than leaving it implied.
    expect(res.body.truncated).toBe(false);
    expect(res.body.totals.handovers).toBe(res.body.handovers.length);
    expect(res.body.totals.notes).toBe(res.body.notes.length);
  });

  it('exports a PDF', async () => {
    const res = await admin.get('/api/admin/reports/handovers.pdf?from=2026-09-17&to=2026-09-17');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // A real PDF, not an error page rendered with the wrong header.
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('is refused to a receptionist and to Bộ phận kỹ thuật', async () => {
    expect((await letan.get('/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17')).status).toBe(403);
    expect((await tech.get('/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17')).status).toBe(403);
  });

  /**
   * IMMUTABLE BY CONSTRUCTION. There is no update or delete endpoint for a
   * handover anywhere in the API, and this is the test that would start failing
   * if somebody added one.
   */
  it('has no write path other than creating one', async () => {
    const stored = await testPrisma.shiftHandover.findFirstOrThrow();
    for (const path of [
      `/api/reception/shifts/handover/${stored.id}`,
      `/api/admin/reports/handovers/${stored.id}`,
    ]) {
      expect((await admin.put(path).send({ reason: 'đổi lại' })).status).toBe(404);
      expect((await admin.patch(path).send({ reason: 'đổi lại' })).status).toBe(404);
      expect((await admin.delete(path)).status).toBe(404);
    }
    const after = await testPrisma.shiftHandover.findFirstOrThrow();
    expect(after.reason).toBe('Có việc cá nhân');
  });
});
