/**
 * "BÀN GIAO CA" — the note the outgoing shift leaves for the next one.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The next shift sees it. That is the entire feature, so it is the first
 *      thing checked.
 *   2. The author, their shift and the branch come from the OPEN SESSION and
 *      never from the request — a note that could name its own author would let
 *      one shift leave a message signed by another.
 *   3. It is immutable: no edit path exists, and the history stays readable.
 *   4. A receptionist sees their own branch and only their own branch.
 *   5. The "việc đang tồn" context is live data, shown beside the form — never
 *      copied into the note, where it would go stale the moment somebody
 *      resolved one of the items.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
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
const DEPT_PASSWORD = 'DatPhong1';

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letanId = 0;
let letanB: Agent;
let letanCn2: Agent;
let admin: Agent;
let tech: Agent;
let dept: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  letanId = (await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false })).id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  letanCn2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  // Bộ phận đặt phòng: branchless, and documented as having no part in anything
  // but Chứng từ — which is exactly why it must not be able to read this.
  await createUser({
    username: 'datphong',
    password: DEPT_PASSWORD,
    fullName: 'Bộ phận đặt phòng',
    role: 'BOOKING_DEPARTMENT',
    branchId: null,
    mustChangePassword: false,
  });
  dept = (await loginAgent(app, 'datphong', DEPT_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-17', '13:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function checkIn(agent: Agent, shiftType: string, name: string): Promise<void> {
  const res = await agent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
}

/* ================================================================== */
/* Writing one                                                         */
/* ================================================================== */

describe('writing a handover note', () => {
  beforeEach(async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
  });

  it('takes the author, the shift and the branch from the OPEN SESSION', async () => {
    const res = await letan.post('/api/reception/handover-notes').send({
      content: '  Phòng 101 đang chờ kỹ thuật.  ',
      // All three are ignored: a note that could name its own author, shift or
      // branch is a note that proves nothing about who left it.
      outgoingNameSnapshot: 'Kẻ mạo danh',
      outgoingShiftType: 'C4',
      branchId: cn2,
    });
    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({
      outgoingName: 'Nguyễn Văn A',
      outgoingShiftType: 'A',
      outgoingShiftName: 'Ca A',
      outgoingShiftWindow: '06:00 – 14:00',
      branchId: cn1,
      content: 'Phòng 101 đang chờ kỹ thuật.',
      priority: 'NORMAL',
    });

    const stored = await testPrisma.shiftHandoverNote.findFirstOrThrow();
    expect(stored.outgoingUserId).toBe(letanId);
    expect(stored.branchId).toBe(cn1);
  });

  it('carries an optional receiver and priority', async () => {
    const res = await letan.post('/api/reception/handover-notes').send({
      content: 'Khách 302 cần gọi lại trước 18:00.',
      incomingName: '  Nguyễn Văn B  ',
      priority: 'HIGH',
    });
    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({
      incomingName: 'Nguyễn Văn B',
      priority: 'HIGH',
    });
  });

  /**
   * THE NOTE IS STAMPED WITH THE BUSINESS CLOCK, NOT POSTGRESQL'S.
   *
   * `createdAt` carries a `@default(now())`, and this column is what the Admin's
   * period report filters on. Leaving it to the database default made the report
   * depend on the real wall clock: a note written by a test that had pinned the
   * clock to the 17th landed on whatever day the machine thought it was, so the
   * report found nothing — and the whole suite quietly changed behaviour when
   * the date rolled over at midnight.
   *
   * Asserted against a pinned clock precisely so that cannot come back.
   */
  it('stamps the note with the application clock, so the report can find it', async () => {
    const at = hcm('2026-09-17', '13:00');
    const res = await letan.post('/api/reception/handover-notes').send({ content: 'Đúng giờ' });
    expect(res.status).toBe(201);

    const stored = await testPrisma.shiftHandoverNote.findFirstOrThrow();
    expect(stored.createdAt.toISOString()).toBe(at.toISOString());
    // And the Admin's report for that day therefore finds it.
    const report = await admin.get('/api/admin/reports/handovers?from=2026-09-17&to=2026-09-17');
    expect(report.status).toBe(200);
    expect(report.body.notes).toHaveLength(1);
  });

  it('refuses empty or whitespace-only content', async () => {
    expect((await letan.post('/api/reception/handover-notes').send({})).status).toBe(422);
    expect(
      (await letan.post('/api/reception/handover-notes').send({ content: '   ' })).status,
    ).toBe(422);
    expect(await testPrisma.shiftHandoverNote.count()).toBe(0);
  });

  it('refuses a receptionist with no open shift', async () => {
    await resetShiftData();
    const res = await letan
      .post('/api/reception/handover-notes')
      .send({ content: 'Không có ca' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHIFT_CHECK_IN_REQUIRED');
  });

  it('refuses an Admin and Bộ phận kỹ thuật', async () => {
    expect((await admin.post('/api/reception/handover-notes').send({ content: 'x' })).status).toBe(403);
    expect((await tech.post('/api/reception/handover-notes').send({ content: 'x' })).status).toBe(403);
  });
});

/* ================================================================== */
/* Reading it — the whole point                                        */
/* ================================================================== */

describe('the next shift reads it', () => {
  it('shows a note left by the previous shift to whoever comes on next', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/handover-notes').send({
      content: 'Phòng 101 đang chờ kỹ thuật. Booking ABC123 cần kiểm tra.',
      incomingName: 'Nguyễn Văn B',
    });

    // 14:00 — B comes on, under their own account.
    setClock({ now: () => hcm('2026-09-17', '14:00') });
    await checkIn(letanB, 'B', 'Nguyễn Văn B');

    const res = await letanB.get('/api/reception/handover-notes');
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({
      outgoingName: 'Nguyễn Văn A',
      outgoingShiftName: 'Ca A',
      content: 'Phòng 101 đang chờ kỹ thuật. Booking ABC123 cần kiểm tra.',
    });
  });

  it('lists newest first', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/handover-notes').send({ content: 'Đầu tiên' });
    setClock({ now: () => hcm('2026-09-17', '13:30') });
    await letan.post('/api/reception/handover-notes').send({ content: 'Thứ hai' });

    const res = await letan.get('/api/reception/handover-notes');
    expect((res.body.notes as { content: string }[]).map((n) => n.content)).toEqual([
      'Thứ hai',
      'Đầu tiên',
    ]);
  });

  it('shows a receptionist only their OWN branch, ignoring any branchId they send', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/handover-notes').send({ content: 'CN1' });
    await checkIn(letanCn2, 'A', 'Lễ tân CN2');
    await letanCn2.post('/api/reception/handover-notes').send({ content: 'CN2' });

    // The scope is not theirs to choose, so a client-supplied branch is IGNORED
    // rather than refused — the same rule the incident list follows.
    const res = await letan.get(`/api/reception/handover-notes?branchId=${cn2}`);
    expect((res.body.notes as { content: string }[]).map((n) => n.content)).toEqual(['CN1']);
  });

  /**
   * THE ROLE GATE, FROM THE OUTSIDE.
   *
   * This endpoint shipped for a few hours with only `requireAuth`, and the
   * service narrowed by branch only for a RECEPTIONIST — so TECHNICAL and
   * BOOKING_DEPARTMENT fell past both arms of that check with an empty filter
   * and read every branch's notes, including any branch they named in the query
   * string. Handover notes carry guest callbacks, room details and staff names.
   *
   * Asserted for BOTH roles, with and without a branchId, because the query
   * parameter was the part that turned a leak into a targeted one.
   */
  it('refuses Bộ phận kỹ thuật and Bộ phận đặt phòng, with or without a branchId', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/handover-notes').send({ content: 'Nội bộ CN1' });

    for (const agent of [tech, dept]) {
      const plain = await agent.get('/api/reception/handover-notes');
      expect(plain.status).toBe(403);
      expect(plain.body.notes).toBeUndefined();

      const targeted = await agent.get(`/api/reception/handover-notes?branchId=${cn1}`);
      expect(targeted.status).toBe(403);
      expect(targeted.body.notes).toBeUndefined();
    }
  });

  it('refuses an anonymous caller', async () => {
    const request = (await import('supertest')).default;
    expect((await request(app).get('/api/reception/handover-notes')).status).toBe(401);
  });

  it('lets an Admin monitor every branch, and narrow to one', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/handover-notes').send({ content: 'CN1' });
    await checkIn(letanCn2, 'A', 'Lễ tân CN2');
    await letanCn2.post('/api/reception/handover-notes').send({ content: 'CN2' });

    const all = await admin.get('/api/reception/handover-notes');
    expect(all.body.notes).toHaveLength(2);

    const one = await admin.get(`/api/reception/handover-notes?branchId=${cn2}`);
    expect((one.body.notes as { content: string }[]).map((n) => n.content)).toEqual(['CN2']);
  });
});

/* ================================================================== */
/* Immutability                                                        */
/* ================================================================== */

describe('a handover note is a record, not a draft', () => {
  it('has no edit or delete route', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const created = await letan
      .post('/api/reception/handover-notes')
      .send({ content: 'Nội dung gốc' });
    const id = created.body.note.id as string;

    for (const agent of [letan, admin]) {
      expect((await agent.put(`/api/reception/handover-notes/${id}`).send({ content: 'x' })).status).toBe(404);
      expect((await agent.patch(`/api/reception/handover-notes/${id}`).send({ content: 'x' })).status).toBe(404);
      expect((await agent.delete(`/api/reception/handover-notes/${id}`)).status).toBe(404);
    }

    const stored = await testPrisma.shiftHandoverNote.findUniqueOrThrow({ where: { id } });
    expect(stored.content).toBe('Nội dung gốc');
  });

  /**
   * THE NOTE OUTLIVES THE SHIFT THAT WROTE IT.
   *
   * `shiftSessionId` is SET NULL rather than RESTRICT because the note is
   * addressed to the next shift and stands on its own snapshots — so it keeps
   * saying who wrote it and on which shift, even once the session row is gone.
   */
  it('keeps its author snapshot if the session is later removed', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const created = await letan.post('/api/reception/handover-notes').send({ content: 'Còn lại' });
    const id = created.body.note.id as string;

    await testPrisma.shiftHandoverNote.update({ where: { id }, data: { shiftSessionId: null } });
    await testPrisma.receptionShiftSession.deleteMany();

    const res = await admin.get('/api/reception/handover-notes');
    expect(res.body.notes[0]).toMatchObject({
      outgoingName: 'Nguyễn Văn A',
      outgoingShiftName: 'Ca A',
      content: 'Còn lại',
    });
  });
});

/* ================================================================== */
/* The live context                                                    */
/* ================================================================== */

describe('"việc đang tồn" is live context, not note content', () => {
  it('reports the branch’s open incidents and unfinished orders', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');

    const reported = await letan
      .post('/api/issues')
      .field('areaCategory', 'ROOM')
      .field('roomNumber', '101')
      .field('category', 'TOILET')
      .field('description', 'Tắc');
    expect(reported.status).toBe(201);

    const res = await letan.get('/api/reception/handover-notes/context');
    expect(res.status).toBe(200);
    expect(res.body.pending.openIssues).toHaveLength(1);
    expect(res.body.pending.openIssues[0]).toMatchObject({
      location: 'Phòng · Phòng 101',
      status: 'NEW',
      needsRework: false,
    });
    expect(res.body.pending.bookings).toMatchObject({
      awaitingCreation: 0,
      awaitingReview: 0,
      needsRecreation: 0,
    });
  });

  it('marks an incident that has already come back once', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const reported = await letan
      .post('/api/issues')
      .field('areaCategory', 'ROOM')
      .field('roomNumber', '101')
      .field('category', 'TOILET')
      .field('description', 'Tắc');
    const id = reported.body.issue.id as string;

    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    const res = await letan.get('/api/reception/handover-notes/context');
    expect(res.body.pending.openIssues[0].needsRework).toBe(true);
  });

  /**
   * THE CONTEXT IS NEVER FROZEN INTO THE NOTE.
   *
   * If it were, an incident resolved an hour after the handover was written
   * would sit in it for ever, sending the next shift to chase something already
   * done. The note carries only what a PERSON typed.
   */
  it('does not copy the context into the stored note', async () => {
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan
      .post('/api/issues')
      .field('areaCategory', 'ROOM')
      .field('roomNumber', '101')
      .field('category', 'TOILET')
      .field('description', 'Tắc');

    await letan.post('/api/reception/handover-notes').send({ content: 'Chỉ có dòng này.' });

    const stored = await testPrisma.shiftHandoverNote.findFirstOrThrow();
    expect(stored.content).toBe('Chỉ có dòng này.');
    expect(stored.content).not.toContain('101');
  });

  it('is scoped to the caller’s own branch', async () => {
    await checkIn(letanCn2, 'A', 'Lễ tân CN2');
    await letanCn2
      .post('/api/issues')
      .field('areaCategory', 'ROOM')
      .field('roomNumber', '201')
      .field('category', 'TOILET')
      .field('description', 'CN2')
      .expect(201);

    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const res = await letan.get('/api/reception/handover-notes/context');
    expect(res.body.pending.openIssues).toHaveLength(0);
  });
});
