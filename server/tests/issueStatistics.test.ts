/**
 * TECHNICAL'S "THỐNG KÊ" — counts over the incidents that exist, and nothing else.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Every figure is derived from HotelIssue / TechnicalRepairAttempt: with no
 *      incidents everything is zero and the lists are empty — nothing is padded.
 *   2. The period counts by when the incident was REPORTED; "outstanding" ignores
 *      the period entirely.
 *   3. The trend has one entry per HCM day, quiet days as zeros.
 *   4. Only Technical and Admin may read it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, testPrisma } from './helpers/db';
import { assignTo, serveAllBranches } from './helpers/issues';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let letan: Agent;
let admin: Agent;
let tech: Agent;
let cn1 = 0;
let cn2 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const app = createApp();
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  await createUser({ username: 'kythuat', password: 'Technical1', fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  tech = (await loginAgent(app, 'kythuat', 'Technical1')).agent;
});

beforeEach(async () => {
  await resetIssueData();
  setClock({ now: () => hcm('2026-09-20', '12:00') });
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

/** The Admin's view is the global one; a technician's is their own work (below). */
const stats = async (agent: Agent = admin, query = '') => {
  const res = await agent.get(`/api/issues/statistics${query}`);
  expect(res.status).toBe(200);
  return res.body.statistics;
};

async function report(at: string, fields: Record<string, string> = {}) {
  setClock({ now: () => hcm(at.slice(0, 10), at.slice(11)) });
  const area = fields.areaCategory ?? 'ROOM';
  let req = letan.post('/api/issues').field('areaCategory', area).field('description', 'Sự cố');
  // A hallway is a floor and a description; a room is a room number and a fault type.
  if (area === 'ROOM') req = req.field('category', fields.category ?? 'DOOR').field('roomNumber', '101');
  else req = req.field('floorNumber', '3');
  const res = await req;
  expect(res.status).toBe(201);
  const id = res.body.issue.id as string;
  /*
    `HotelIssue.createdAt` is stamped by the database (`@default(now())`), not by
    the injected clock, so the report time a scenario needs is set directly — the
    way incidentRangeReport.test.ts does.
  */
  await testPrisma.hotelIssue.update({ where: { id }, data: { createdAt: hcm(at.slice(0, 10), at.slice(11)) } });
  return id;
}

describe('with no incidents at all', () => {
  it('answers zeros and empty lists, not invented numbers', async () => {
    const s = await stats();
    expect(s.totals).toEqual({ total: 0, newCount: 0, inProgressCount: 0, completedCount: 0, needsReworkCount: 0 });
    expect(s.outstanding.total).toBe(0);
    expect(s.byArea).toEqual([]);
    expect(s.byCategory).toEqual([]);
    expect(s.workload).toMatchObject({ attempts: 0, averageSeconds: null, averageLabel: null, byTechnician: [] });
    expect(s.byBranch).toHaveLength(8);
    expect(s.byBranch.every((b: { total: number }) => b.total === 0)).toBe(true);
    expect(s.trend).toHaveLength(30);
    expect(s.trend.every((d: { reported: number; completed: number }) => d.reported === 0 && d.completed === 0)).toBe(true);
    expect(s.trend.at(-1).date).toBe('2026-09-20');
  });
});

describe('with incidents', () => {
  it('counts the period by report date and splits it every way the screen shows', async () => {
    const a = await report('2026-09-18T08:00', { category: 'DOOR' });
    await report('2026-09-19T09:00', { category: 'DOOR' });
    await report('2026-09-19T10:00', { areaCategory: 'HALLWAY' });
    setClock({ now: () => hcm('2026-09-20', '09:00') });
    await assignTo(admin, a, tech);
    await tech.post(`/api/issues/${a}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900000000' });
    setClock({ now: () => hcm('2026-09-20', '09:30') });
    await tech.post(`/api/issues/${a}/complete`).send({ verdict: 'CORRECT' });

    const s = await stats();
    expect(s.totals).toMatchObject({ total: 3, newCount: 2, inProgressCount: 0, completedCount: 1 });
    expect(s.outstanding).toMatchObject({ total: 2, newCount: 2 });
    expect(s.byStatus.map((x: { count: number }) => x.count)).toEqual([2, 0, 1]);
    expect(s.byCategory[0]).toMatchObject({ key: 'DOOR', count: 2 });
    expect(s.byArea.find((x: { key: string }) => x.key === 'HALLWAY').count).toBe(1);
    expect(s.byBranch.find((b: { branchId: number }) => b.branchId === cn1)).toMatchObject({ total: 3, open: 2, completed: 1 });
    expect(s.workload).toMatchObject({ attempts: 1, completedAttempts: 1, cannotRepairAttempts: 0, averageSeconds: 1800 });
    expect(s.workload.byTechnician).toEqual([{ name: 'Bảo', attempts: 1, completed: 1, cannotRepair: 0 }]);

    const day = (d: string) => s.trend.find((x: { date: string }) => x.date === d);
    expect(day('2026-09-18')).toMatchObject({ reported: 1, completed: 0 });
    expect(day('2026-09-19')).toMatchObject({ reported: 2, completed: 0 });
    expect(day('2026-09-20')).toMatchObject({ reported: 0, completed: 1 });
    expect(day('2026-09-17')).toMatchObject({ reported: 0, completed: 0 });
  });

  it('counts a "Không sửa được" as workload and as needing rework', async () => {
    const id = await report('2026-09-19T09:00');
    await assignTo(admin, id, tech);
    const accepted = await tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900000000' });
    expect(accepted.status).toBe(200);
    const failed = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Thiếu linh kiện' });
    expect(failed.status).toBe(200);
    const s = await stats();
    expect(s.totals.needsReworkCount).toBe(1);
    expect(s.workload).toMatchObject({ attempts: 1, cannotRepairAttempts: 1 });
  });

  it('leaves an old open incident out of the period but keeps it in "outstanding"', async () => {
    await report('2026-05-01T09:00');
    setClock({ now: () => hcm('2026-09-20', '12:00') });
    const s = await stats();
    expect(s.totals.total).toBe(0);
    expect(s.outstanding.total).toBe(1);
  });

  it('narrows to one branch and to a chosen period', async () => {
    await report('2026-09-19T09:00');
    expect((await stats(tech, `?branchId=${cn2}`)).totals.total).toBe(0);
    expect((await stats(tech, `?branchId=${cn1}`)).byBranch).toHaveLength(1);
    expect((await stats(tech, '?days=7')).trend).toHaveLength(7);
    expect((await stats(tech, '?days=90')).trend).toHaveLength(90);
    expect((await tech.get('/api/issues/statistics?days=13')).status).toBe(422);
  });
});

describe('a technician reads their own work', () => {
  it('counts only what was given to them, with their personal figures', async () => {
    const mine = await report('2026-09-18T08:00', { category: 'DOOR' });
    await report('2026-09-19T09:00', { category: 'DOOR' }); // nobody's yet
    setClock({ now: () => hcm('2026-09-20', '09:00') });
    await assignTo(admin, mine, tech);
    await tech.post(`/api/issues/${mine}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900000000' });
    await tech.post(`/api/issues/${mine}/complete`).send({ verdict: 'CORRECT' });

    const s = await stats(tech);
    expect(s.totals).toMatchObject({ total: 1, completedCount: 1 });
    expect(s.outstanding.total).toBe(0);
    // Every branch is still listed — with this technician's zeros where they did nothing.
    expect(s.byBranch).toHaveLength(8);
    expect(s.technician).toMatchObject({ name: 'Kỹ thuật', assignedNow: 0, inProgressNow: 0, completed: 1, cannotRepair: 0 });
    // The Admin still sees both.
    expect((await stats(admin)).totals.total).toBe(2);
    expect((await stats(admin)).technician).toBeNull();
  });

  it('counts a job moved to someone else as "đã chuyển", and a repeat as "báo lại"', async () => {
    const done = await report('2026-09-15T08:00', { category: 'DOOR' });
    setClock({ now: () => hcm('2026-09-15', '09:00') });
    await assignTo(admin, done, tech);
    await tech.post(`/api/issues/${done}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900000000' });
    await tech.post(`/api/issues/${done}/complete`).send({ verdict: 'CORRECT' });

    // The same room, the same fault, days later: a repeat, stored at creation.
    const again = await report('2026-09-19T09:00', { category: 'DOOR' });
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: again } });
    expect(stored.repeatOfIssueId).toBe(done);
    setClock({ now: () => hcm('2026-09-19', '10:00') });
    await assignTo(admin, again, tech);

    // …then moved to another technician before it was taken.
    const other = await testPrisma.user.create({
      data: { username: 'kythuat2', passwordHash: 'x', fullName: 'Kỹ thuật 2', role: 'TECHNICAL', mustChangePassword: false },
    });
    await serveAllBranches(other.id);
    expect((await admin.post(`/api/issues/${again}/assign`).send({ technicianUserId: other.id })).status).toBe(200);

    const s = await stats(tech);
    expect(s.technician).toMatchObject({ assignedNow: 0, reassignedAway: 1, reopened: 1 });
  });
});

describe('who may read it', () => {
  it('is for Technical and the Admin', async () => {
    expect((await admin.get('/api/issues/statistics')).status).toBe(200);
    expect((await letan.get('/api/issues/statistics')).status).toBe(403);
  });
});
