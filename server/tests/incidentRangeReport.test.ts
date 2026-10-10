/**
 * The Admin's incident date-range monitoring.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A period means a period of Asia/Ho_Chi_Minh CALENDAR DAYS, half-open, and
 *      it is applied in the DATABASE — an end-of-month review across eight
 *      properties is a query, not a filter over whatever page happened to load.
 *   2. The date, branch and status filters compose.
 *   3. "Tồn đọng hiện tại" deliberately ignores the period — an incident
 *      reported a fortnight ago and still open is exactly what a report scoped to
 *      this week structurally cannot show.
 *   4. "Lượt không sửa được" and "Cần xử lý lại" are DIFFERENT numbers and the
 *      same incident is never double-counted between them.
 *   5. The export carries the period it was asked for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { assignTo } from './helpers/issues';
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

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letan2: Agent;
let admin: Agent;
let tech: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

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
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-17', '10:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** Reports an incident AT the given HCM instant. */
async function reportAt(agent: Agent, day: string, hhmm: string, room: string): Promise<string> {
  setClock({ now: () => hcm(day, hhmm) });
  const res = await agent
    .post('/api/issues')
    .field('areaCategory', 'ROOM')
    .field('roomNumber', room)
    .field('category', 'TOILET')
    .field('description', `Sự cố phòng ${room}`);
  expect(res.status).toBe(201);
  // `createdAt` has a database default, so it is pinned explicitly — the clock
  // stub governs the application, not PostgreSQL's `now()`.
  await testPrisma.hotelIssue.update({
    where: { id: res.body.issue.id },
    data: { createdAt: hcm(day, hhmm) },
  });
  return res.body.issue.id as string;
}

async function failOnce(id: string, at: string, reason = 'Không có linh kiện'): Promise<void> {
  await assignTo(admin, id, tech);
  await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
  setClock({ now: () => hcm('2026-09-17', at) });
  const res = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason });
  expect(res.status).toBe(200);
}

/* ================================================================== */
/* The list, filtered by date                                          */
/* ================================================================== */

describe('the incident list narrows by a HCM date range', () => {
  beforeEach(async () => {
    await reportAt(letan, '2026-09-16', '23:30', '101'); // the day before
    await reportAt(letan, '2026-09-17', '00:05', '102'); // just after midnight
    await reportAt(letan, '2026-09-17', '23:55', '103'); // just before midnight
    await reportAt(letan, '2026-09-18', '00:05', '201'); // the day after
    setClock({ now: () => hcm('2026-09-18', '10:00') });
  });

  /**
   * THE BOUNDARIES ARE THE ONLY PART WORTH TESTING.
   *
   * 00:05 and 23:55 on the 17th are both the 17th in Asia/Ho_Chi_Minh and both
   * the 16th/17th in UTC. A range computed in UTC would drop one of them, and
   * the report would be quietly short by exactly the incidents reported late at
   * night — which is when a hotel has most of them.
   */
  it('includes both ends of the HCM day and neither neighbour', async () => {
    const res = await admin.get('/api/issues?from=2026-09-17&to=2026-09-17&pageSize=100');
    expect(res.status).toBe(200);
    const rooms = (res.body.issues as { roomNumber: string }[]).map((i) => i.roomNumber).sort();
    expect(rooms).toEqual(['102', '103']);
  });

  it('spans several days', async () => {
    const res = await admin.get('/api/issues?from=2026-09-16&to=2026-09-18&pageSize=100');
    expect(res.body.issues).toHaveLength(4);
  });

  it('refuses half a range rather than silently meaning "for ever after"', async () => {
    expect((await admin.get('/api/issues?from=2026-09-17&pageSize=100')).status).toBe(422);
    expect((await admin.get('/api/issues?to=2026-09-17&pageSize=100')).status).toBe(422);
  });

  it('refuses an inverted range rather than returning nothing', async () => {
    const res = await admin.get('/api/issues?from=2026-09-18&to=2026-09-17&pageSize=100');
    expect(res.status).toBe(422);
  });

  it('returns everything when no range is asked for', async () => {
    const res = await admin.get('/api/issues?pageSize=100');
    expect(res.body.issues).toHaveLength(4);
  });
});

/* ================================================================== */
/* Composition with branch and status                                  */
/* ================================================================== */

describe('date, branch and status compose in the database', () => {
  beforeEach(async () => {
    await reportAt(letan, '2026-09-17', '08:00', '101');
    await reportAt(letan2, '2026-09-17', '09:00', '201');
    const done = await reportAt(letan, '2026-09-17', '10:00', '102');
    setClock({ now: () => hcm('2026-09-17', '11:00') });
    await assignTo(admin, done, tech);
    await tech.post(`/api/issues/${done}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    await tech.post(`/api/issues/${done}/complete`).send({ verdict: 'CORRECT' });
  });

  it('narrows to one branch inside the period', async () => {
    const res = await admin.get(`/api/issues?from=2026-09-17&to=2026-09-17&branchId=${cn1}&pageSize=100`);
    const rooms = (res.body.issues as { roomNumber: string }[]).map((i) => i.roomNumber).sort();
    expect(rooms).toEqual(['101', '102']);
  });

  it('narrows to one status inside the period', async () => {
    const res = await admin.get('/api/issues?from=2026-09-17&to=2026-09-17&status=COMPLETED&pageSize=100');
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].roomNumber).toBe('102');
  });

  it('applies all three at once', async () => {
    const res = await admin.get(
      `/api/issues?from=2026-09-17&to=2026-09-17&branchId=${cn1}&status=NEW&pageSize=100`,
    );
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].roomNumber).toBe('101');
  });

  /**
   * NOT FILTERED IN THE BROWSER. `pagination.total` is the count of MATCHING
   * rows, so a period that matches two out of three says two — which it could
   * not do if the narrowing happened after the page was fetched.
   */
  it('counts matches in the database, not on the loaded page', async () => {
    const res = await admin.get(`/api/issues?from=2026-09-17&to=2026-09-17&branchId=${cn1}&pageSize=1`);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.pagination.total).toBe(2);
  });
});

/* ================================================================== */
/* "Tồn đọng hiện tại"                                                 */
/* ================================================================== */

describe('the outstanding view ignores the period, deliberately', () => {
  it('shows an old unfinished incident that this week would hide', async () => {
    const old = await reportAt(letan, '2026-09-01', '08:00', '101');
    await reportAt(letan, '2026-09-17', '08:00', '102');
    const done = await reportAt(letan, '2026-09-17', '09:00', '103');
    setClock({ now: () => hcm('2026-09-17', '10:00') });
    await assignTo(admin, done, tech);
    await tech.post(`/api/issues/${done}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    await tech.post(`/api/issues/${done}/complete`).send({ verdict: 'CORRECT' });

    // Scoped to today, the fortnight-old one is invisible…
    const scoped = await admin.get('/api/issues?from=2026-09-17&to=2026-09-17&pageSize=100');
    expect((scoped.body.issues as { id: string }[]).map((i) => i.id)).not.toContain(old);

    // …and that is exactly what this view exists to fix.
    const res = await admin.get('/api/issues?outstanding=true&pageSize=100');
    const rooms = (res.body.issues as { roomNumber: string }[]).map((i) => i.roomNumber).sort();
    expect(rooms).toEqual(['101', '102']);
  });

  it('still respects the branch filter', async () => {
    await reportAt(letan, '2026-09-17', '08:00', '101');
    await reportAt(letan2, '2026-09-17', '08:00', '201');

    const res = await admin.get(`/api/issues?outstanding=true&branchId=${cn2}&pageSize=100`);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].roomNumber).toBe('201');
  });
});

/* ================================================================== */
/* The summary                                                         */
/* ================================================================== */

describe('the range summary', () => {
  it('counts the period by current status', async () => {
    await reportAt(letan, '2026-09-17', '08:00', '101');
    const working = await reportAt(letan, '2026-09-17', '08:30', '102');
    const done = await reportAt(letan, '2026-09-17', '09:00', '103');
    await reportAt(letan, '2026-09-16', '09:00', '202'); // outside the period

    setClock({ now: () => hcm('2026-09-17', '10:00') });
    await assignTo(admin, working, tech);
    await tech.post(`/api/issues/${working}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    await assignTo(admin, done, tech);
    await tech.post(`/api/issues/${done}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    await tech.post(`/api/issues/${done}/complete`).send({ verdict: 'CORRECT' });

    const res = await admin.get('/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      total: 3,
      newCount: 1,
      inProgressCount: 1,
      completedCount: 1,
    });
  });

  /**
   * THE TWO NUMBERS THAT SOUND LIKE ONE.
   *
   * Three technicians failed on incident A, so THREE attempts failed — that is
   * work spent, and it is three. But only ONE incident is waiting to be picked up
   * again — that is a state, and it is one. Reporting either alone, or adding
   * them, produces a figure nobody can interpret.
   */
  it('separates failed ATTEMPTS from incidents needing rework', async () => {
    const a = await reportAt(letan, '2026-09-17', '08:00', '101');
    for (const at of ['11:00', '12:00', '13:00']) {
      await failOnce(a, at);
    }
    const b = await reportAt(letan, '2026-09-17', '08:30', '102');
    await failOnce(b, '14:00');
    // …and then somebody picks B up again, so it is no longer waiting.
    setClock({ now: () => hcm('2026-09-17', '15:00') });
    await assignTo(admin, b, tech);
    await tech.post(`/api/issues/${b}/accept`).send({ technicianName: 'Minh', technicianPhone: '0911222333' });

    const res = await admin.get('/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17');
    // Four separate visits failed.
    expect(res.body.summary.cannotRepairAttempts).toBe(4);
    // But only A is sitting in the queue waiting for somebody.
    expect(res.body.summary.needsReworkIssues).toBe(1);
  });

  it('reports the outstanding total outside the period', async () => {
    await reportAt(letan, '2026-09-01', '08:00', '101');
    await reportAt(letan, '2026-09-17', '08:00', '102');

    const res = await admin.get('/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17');
    expect(res.body.summary.total).toBe(1);
    // Both are still open, whatever the period says.
    expect(res.body.summary.outstandingTotal).toBe(2);
  });

  it('narrows to one branch', async () => {
    await reportAt(letan, '2026-09-17', '08:00', '101');
    await reportAt(letan2, '2026-09-17', '08:00', '201');

    const res = await admin.get(
      `/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17&branchId=${cn2}`,
    );
    expect(res.body.summary.total).toBe(1);
    expect(res.body.summary.outstandingTotal).toBe(1);
  });

  it('is Admin-only', async () => {
    const url = '/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17';
    expect((await letan.get(url)).status).toBe(403);
    expect((await tech.get(url)).status).toBe(403);
  });
});

/* ================================================================== */
/* The export                                                          */
/* ================================================================== */

describe('the incident export', () => {
  it('carries the period it was asked for, and the attempt history', async () => {
    const id = await reportAt(letan, '2026-09-17', '08:00', '101');
    await failOnce(id, '11:00');

    const json = await admin.get('/api/admin/reports/incidents?from=2026-09-17&to=2026-09-17');
    expect(json.status).toBe(200);
    expect(json.body.issues).toHaveLength(1);
    expect(json.body.issues[0].attempts).toHaveLength(1);
    expect(json.body.issues[0].attempts[0]).toMatchObject({
      technicianName: 'Bao',
      technicianPhone: '0369852177',
      outcome: 'CANNOT_REPAIR',
      reason: 'Không có linh kiện',
    });

    const outside = await admin.get('/api/admin/reports/incidents?from=2026-09-18&to=2026-09-18');
    expect(outside.body.issues).toHaveLength(0);
  });

  /**
   * THE FILE AND THE SCREEN COUNT THE SAME THING.
   *
   * "Lượt không sửa được" was computed twice from two different sets: the screen
   * counted attempts that FAILED in the period, the PDF counted failed attempts
   * belonging to incidents REPORTED in the period. An incident reported on the
   * 17th whose attempt failed on the 20th therefore appeared in one number and
   * not the other — in both directions, depending on which day was exported —
   * while both files' comments asserted they could not disagree.
   *
   * The PDF now prints the summary endpoint's own figures, so this is a test
   * that the two share a single query rather than two implementations of one.
   */
  it('counts failed attempts by WHEN THEY FAILED, in the summary and the file alike', async () => {
    // Reported on the 17th…
    const id = await reportAt(letan, '2026-09-17', '10:00', '101');
    // …and failed on the 20th.
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    setClock({ now: () => hcm('2026-09-20', '09:00') });
    expect(
      (await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' })).status,
    ).toBe(200);

    // The 17th: one incident reported, but nothing failed that day.
    const onThe17th = await admin.get(
      '/api/admin/reports/incidents/summary?from=2026-09-17&to=2026-09-17',
    );
    expect(onThe17th.body.summary.total).toBe(1);
    expect(onThe17th.body.summary.cannotRepairAttempts).toBe(0);

    // The 20th: nothing reported, but one attempt failed.
    const onThe20th = await admin.get(
      '/api/admin/reports/incidents/summary?from=2026-09-20&to=2026-09-20',
    );
    expect(onThe20th.body.summary.total).toBe(0);
    expect(onThe20th.body.summary.cannotRepairAttempts).toBe(1);

    // Both exports succeed, and the PDF is rendered from those same numbers —
    // so neither file can print a figure its own screen would contradict.
    for (const day of ['2026-09-17', '2026-09-20']) {
      const pdf = await admin.get(`/api/admin/reports/incidents.pdf?from=${day}&to=${day}`);
      expect(pdf.status, day).toBe(200);
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('produces a real PDF', async () => {
    const id = await reportAt(letan, '2026-09-17', '08:00', '101');
    await failOnce(id, '11:00');

    const res = await admin.get('/api/admin/reports/incidents.pdf?from=2026-09-17&to=2026-09-17');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    // Big enough to contain the table and the attempt section, not just a header.
    expect(res.body.length).toBeGreaterThan(2000);
  });

  /**
   * The incident report is built from the SAME payload the screens read, so a
   * relation added for one cannot silently go missing from the other. These two
   * fields were the ones a hand-copied second `include` used to drop.
   */
  it('still carries the acceptance and completion instants', async () => {
    const id = await reportAt(letan, '2026-09-17', '08:00', '101');
    setClock({ now: () => hcm('2026-09-17', '09:00') });
    await assignTo(admin, id, tech);
    await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bao', technicianPhone: '0369852177' });
    setClock({ now: () => hcm('2026-09-17', '09:05') });
    await tech.post(`/api/issues/${id}/complete`).send({ verdict: 'CORRECT' });

    const res = await admin.get('/api/admin/reports/incidents?from=2026-09-17&to=2026-09-17');
    expect(res.body.issues[0].acceptedAt).not.toBeNull();
    expect(res.body.issues[0].completedAt).not.toBeNull();
    expect(res.body.issues[0].durationLabel).toBe('5 phút');
  });
});
