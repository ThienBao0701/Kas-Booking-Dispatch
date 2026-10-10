/**
 * THE TECHNICAL DELEGATION HIERARCHY, END TO END — through the real routes and
 * the database:
 *
 *   Tổng quản lý kỹ thuật → Quản lý kỹ thuật → kĩ thuật khách sạn
 *                                            → kĩ thuật bên ngoài (no account)
 *
 *   1. Each hand-off persists who, role, when, the note, and its parent; the
 *      incident's detail returns the whole chain as one timeline.
 *   2. The manager a job was given to OWNS its next step: another Quản lý kỹ
 *      thuật, a reception manager or the desk cannot delegate it, even by a
 *      direct request. The Tổng quản lý kỹ thuật (its branches) and Admin can.
 *   3. Branch scope decides everything: no branch = nothing; one branch = that
 *      branch; several = each of them; never another.
 *   4. An outside contractor is never a User and never gets a login.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, testPrisma } from './helpers/db';
import { serveBranches } from './helpers/issues';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const PASSWORD = 'Matkhau123';
// The login limiter allows ten sign-ins per app.
const apps = [createApp(), createApp()];
let logins = 0;
async function signIn(username: string, password = PASSWORD) {
  const { res, agent } = await loginAgent(apps[Math.floor(logins++ / 8)]!, username, password);
  expect(res.status).toBe(200);
  return agent;
}
type Agent = Awaited<ReturnType<typeof signIn>>;

const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
const ids: Record<string, number> = {};
const as: Record<string, Agent> = {};

/** A staff account with an explicit branch SET (UserBranchAssignment rows) — possibly none. */
async function staff(username: string, fullName: string, role: string, branchIds: number[]) {
  ids[username] = (await createUser({ username, password: PASSWORD, fullName, role: role as never, branchId: null, mustChangePassword: false })).id;
  await serveBranches(ids[username]!, branchIds);
  as[username] = await signIn(username);
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  ids.admin = (await createAdmin({ mustChangePassword: false })).id;
  as.admin = await signIn('admin', ADMIN_PASSWORD);
  ids.letan1 = (await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false })).id;
  as.letan1 = await signIn('letan1', RECEPTIONIST_PASSWORD);
  ids.letan2 = (await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false })).id;
  as.letan2 = await signIn('letan2', RECEPTIONIST_PASSWORD);
  await staff('qllt1', 'Quản lý lễ tân CN1', 'RECEPTION_MANAGER', [cn1]);
  await staff('tgm1', 'Tổng KT CN1', 'TECHNICAL_GENERAL_MANAGER', [cn1]);
  await staff('tgm12', 'Tổng KT CN1+2', 'TECHNICAL_GENERAL_MANAGER', [cn1, cn2]);
  await staff('tgm0', 'Tổng KT chưa phân', 'TECHNICAL_GENERAL_MANAGER', []);
  await staff('qlktA', 'QLKT A', 'TECHNICAL_MANAGER', [cn1]);
  await staff('qlktB', 'QLKT B', 'TECHNICAL_MANAGER', [cn1]);
  await staff('qlkt12', 'QLKT CN1+2', 'TECHNICAL_MANAGER', [cn1, cn2]);
  await staff('kt1', 'Kỹ thuật CN1', 'TECHNICAL', [cn1]);
  await staff('kt2', 'Kỹ thuật CN2', 'TECHNICAL', [cn2]);
  ids.kt0 = (await createUser({ username: 'kt0', password: PASSWORD, fullName: 'Kỹ thuật chưa phân', role: 'TECHNICAL', branchId: null, mustChangePassword: false })).id;
});

beforeEach(async () => {
  await resetIssueData();
  setClock({ now: () => hcm('2026-10-10', '08:00') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

async function incident(agent: Agent, room = '301') {
  const res = await agent.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: room, category: 'DOOR', description: `Cửa phòng ${room}` });
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

const give = (agent: Agent, id: string, managerUserId: number, note = 'Kiểm tra và xử lý') =>
  agent.post(`/api/issues/${id}/dispatch-manager`).send({ managerUserId, note });
const assign = (agent: Agent, id: string, technicianUserId: number, note?: string) =>
  agent.post(`/api/issues/${id}/assign`).send(note ? { technicianUserId, note } : { technicianUserId });
const hire = (agent: Agent, id: string) =>
  agent.post(`/api/issues/${id}/dispatch-external`).send({
    name: 'Trần Thợ Ngoài',
    phone: '0912 345 678',
    specialty: 'Khóa cửa',
    type: 'COMPANY',
    company: 'Công ty Khóa Sài Gòn',
    note: 'Thay ổ khóa',
  });
const chainOf = async (agent: Agent, id: string) => {
  const res = await agent.get(`/api/issues/${id}`);
  expect(res.status).toBe(200);
  return res.body.issue.delegationChain as {
    id: string;
    kind: string;
    kindLabel: string;
    by: { id: number; name: string; role: string };
    to: { name: string; contractor: { phone: string | null; company: string | null } | null };
    note: string | null;
    parentId: string | null;
    state: string;
    repairCost: number | null;
  }[];
};

describe('Tổng quản lý kỹ thuật → Quản lý kỹ thuật', () => {
  it('hands the job to a manager of the branch, with the note, persisted and visible to that manager', async () => {
    const id = await incident(as.letan1!);
    const res = await give(as.tgm1!, id, ids.qlktA!, 'Ưu tiên trong sáng nay');
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'NEW', assignmentState: 'MANAGER_ASSIGNED', assignedManager: { id: ids.qlktA } });

    const chain = await chainOf(as.qlktA!, id);
    expect(chain).toEqual([
      expect.objectContaining({
        kind: 'TO_MANAGER',
        kindLabel: 'Giao quản lý kỹ thuật',
        by: expect.objectContaining({ id: ids.tgm1, role: 'TECHNICAL_GENERAL_MANAGER' }),
        to: expect.objectContaining({ name: 'QLKT A' }),
        note: 'Ưu tiên trong sáng nay',
        parentId: null,
        state: 'ACTIVE',
      }),
    ]);
    const stored = await testPrisma.hotelIssueDispatch.findFirstOrThrow({ where: { issueId: id } });
    expect(stored).toMatchObject({ kind: 'TO_MANAGER', assignedByUserId: ids.tgm1, managerUserId: ids.qlktA, endedAt: null });
    expect(await testPrisma.notification.count({ where: { userId: ids.qlktA } })).toBeGreaterThan(0);
  });

  it('refuses a manager of another branch, a missing note, and every role that is not a Tổng quản lý kỹ thuật', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!, '  ')).status).toBe(422);
    // Only an active Quản lý kỹ thuật of the incident's branch can receive it — a technician id cannot.
    expect((await give(as.tgm1!, id, ids.kt1!)).status).toBe(422);
    for (const who of ['qlktA', 'qllt1', 'letan1', 'kt1', 'admin']) {
      expect((await give(as[who]!, id, ids.qlktA!)).status, who).toBe(403);
    }
    expect(await testPrisma.hotelIssueDispatch.count()).toBe(0);
  });
});

describe('Quản lý kỹ thuật → kĩ thuật khách sạn', () => {
  it('the holder delegates to a technician of the branch; the step names its parent and the technician sees its job', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!)).status).toBe(200);
    setClock({ now: () => hcm('2026-10-10', '09:00') });
    const res = await assign(as.qlktA!, id, ids.kt1!, 'Thay bản lề');
    expect(res.status).toBe(200);
    expect(res.body.issue.assignmentState).toBe('ASSIGNED');

    const chain = await chainOf(as.tgm1!, id);
    expect(chain.map((s) => [s.kind, s.state])).toEqual([
      ['TO_MANAGER', 'ACTIVE'],
      ['TO_TECHNICIAN', 'ACTIVE'],
    ]);
    expect(chain[1]).toMatchObject({ parentId: chain[0]!.id, by: expect.objectContaining({ id: ids.qlktA }), note: 'Thay bản lề' });
    // The technician's own list holds it.
    const mine = await as.kt1!.get('/api/issues?pageSize=50');
    expect(mine.body.issues.map((i: { id: string }) => i.id)).toEqual([id]);
    // The assignment row is the audit record.
    expect(await testPrisma.hotelIssueAssignment.findFirstOrThrow({ where: { issueId: id } })).toMatchObject({
      technicianUserId: ids.kt1,
      assignedByUserId: ids.qlktA,
      assignedByRole: 'TECHNICAL_MANAGER',
    });
  });

  it('refuses a technician outside the branch or without branches, and every non-holder — by a direct request too', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!)).status).toBe(200);
    expect((await assign(as.qlktA!, id, ids.kt2!)).status).toBe(422);
    expect((await assign(as.qlktA!, id, ids.kt0!)).status).toBe(422);
    // Another manager of the same branch, a reception manager, the desk and the technician itself.
    expect((await assign(as.qlktB!, id, ids.kt1!)).status).toBe(403);
    expect((await assign(as.qllt1!, id, ids.kt1!)).status).toBe(403);
    expect((await assign(as.letan1!, id, ids.kt1!)).status).toBe(403);
    expect((await assign(as.kt1!, id, ids.kt1!)).status).toBe(403);
    expect((await as.qllt1!.post('/api/issues/assign').send({ issueIds: [id], technicianUserId: ids.kt1 })).status).toBe(403);
    expect(await testPrisma.hotelIssueAssignment.count()).toBe(0);
    // The Tổng quản lý kỹ thuật of the branch and the Admin may still step in.
    expect((await assign(as.tgm1!, id, ids.kt1!)).status).toBe(200);
  });

  it('only the holder (or the Tổng quản lý kỹ thuật / Admin) takes a technician back off the job', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!)).status).toBe(200);
    expect((await assign(as.qlktA!, id, ids.kt1!)).status).toBe(200);
    expect((await as.qlktB!.post(`/api/issues/${id}/unassign`).send({})).status).toBe(403);
    expect((await as.qllt1!.post(`/api/issues/${id}/unassign`).send({})).status).toBe(403);
    expect((await as.qlktA!.post(`/api/issues/${id}/unassign`).send({})).status).toBe(200);
    const chain = await chainOf(as.qlktA!, id);
    expect(chain.find((s) => s.kind === 'TO_TECHNICIAN')!.state).toBe('RETURNED');
  });
});

describe('Quản lý kỹ thuật → kĩ thuật bên ngoài (no KAS account)', () => {
  it('records the contractor without a User, under the manager’s step, private to contractor readers, and completes with a cost', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!)).status).toBe(200);
    const users = await testPrisma.user.count();
    expect((await hire(as.qlktB!, id)).status).toBe(403);
    expect((await hire(as.tgm1!, id)).status).toBe(403);
    const res = await hire(as.qlktA!, id);
    expect(res.status).toBe(200);
    expect(res.body.issue.assignmentState).toBe('EXTERNAL_IN_PROGRESS');
    // Never a login: no account was created for the contractor.
    expect(await testPrisma.user.count()).toBe(users);
    expect(await testPrisma.user.count({ where: { fullName: 'Trần Thợ Ngoài' } })).toBe(0);

    const managerView = await chainOf(as.qlktA!, id);
    const external = managerView.find((s) => s.kind === 'TO_EXTERNAL')!;
    expect(external).toMatchObject({ parentId: managerView[0]!.id, state: 'ACTIVE', to: { name: 'Trần Thợ Ngoài' } });
    expect(external.to.contractor).toMatchObject({ phone: '0912 345 678', company: 'Công ty Khóa Sài Gòn' });
    // A reception manager sees the step, never the contact.
    const deskView = await chainOf(as.qllt1!, id);
    expect(deskView.find((s) => s.kind === 'TO_EXTERNAL')!.to.contractor).toMatchObject({ phone: null, company: null });

    setClock({ now: () => hcm('2026-10-10', '16:00') });
    expect((await as.qlktA!.post(`/api/issues/${id}/complete-external`).send({ verdict: 'CORRECT' })).status).toBe(422);
    const done = await as.qlktA!.post(`/api/issues/${id}/complete-external`).send({ repairCost: 450000, verdict: 'CORRECT' });
    expect(done.status).toBe(200);
    expect(done.body.issue.status).toBe('COMPLETED');
    const finalChain = await chainOf(as.tgm1!, id);
    expect(finalChain.map((s) => [s.kind, s.state])).toEqual([
      ['TO_MANAGER', 'COMPLETED'],
      ['TO_EXTERNAL', 'COMPLETED'],
    ]);
    expect(finalChain[1]!.repairCost).toBe(450000);
  });
});

describe('ownership moves with the hand-off, and the history keeps every step', () => {
  it('a re-delegation ends the first manager’s step; the first manager loses the job, the second owns it', async () => {
    const id = await incident(as.letan1!);
    expect((await give(as.tgm1!, id, ids.qlktA!)).status).toBe(200);
    setClock({ now: () => hcm('2026-10-10', '08:30') });
    expect((await give(as.tgm1!, id, ids.qlktB!, 'Chuyển QLKT B')).status).toBe(200);
    expect((await assign(as.qlktA!, id, ids.kt1!)).status).toBe(403);
    setClock({ now: () => hcm('2026-10-10', '09:00') });
    expect((await assign(as.qlktB!, id, ids.kt1!)).status).toBe(200);

    const chain = await chainOf(as.tgm1!, id);
    expect(chain.map((s) => [s.kind, s.to.name, s.state])).toEqual([
      ['TO_MANAGER', 'QLKT A', 'ENDED'],
      ['TO_MANAGER', 'QLKT B', 'ACTIVE'],
      ['TO_TECHNICIAN', 'Kỹ thuật CN1', 'ACTIVE'],
    ]);
    expect(chain[2]!.parentId).toBe(chain[1]!.id);
    const second = await testPrisma.hotelIssueDispatch.findFirstOrThrow({ where: { issueId: id, managerUserId: ids.qlktB } });
    expect(second).toMatchObject({ previousManagerUserId: ids.qlktA });
  });
});

describe('branch scope: none, one, several — never another', () => {
  it('a Tổng quản lý kỹ thuật with no branch sees nothing and can hand nothing on', async () => {
    const id = await incident(as.letan1!);
    expect((await as.tgm0!.get('/api/issues?pageSize=50')).body.issues).toEqual([]);
    expect((await give(as.tgm0!, id, ids.qlktA!)).status).toBe(403);
    expect((await as.tgm0!.get(`/api/issues/${id}`)).status).toBe(403);
  });

  it('one branch reaches that branch only; several reach each of them', async () => {
    const one = await incident(as.letan1!, '301');
    const two = await incident(as.letan2!, '302');
    // CN1-only Tổng QLKT: CN2 is refused by id and by list.
    expect((await give(as.tgm1!, two, ids.qlkt12!)).status).toBe(403);
    expect((await as.tgm1!.get(`/api/issues?branchId=${cn2}`)).status).toBe(403);
    // CN1+2 Tổng QLKT reaches both, to a manager who covers both.
    expect((await give(as.tgm12!, one, ids.qlkt12!)).status).toBe(200);
    expect((await give(as.tgm12!, two, ids.qlkt12!)).status).toBe(200);
    // …but a CN1-only manager cannot receive CN2 work.
    const three = await incident(as.letan2!, '302');
    expect((await give(as.tgm12!, three, ids.qlktA!)).status).toBe(422);
    // The multi-branch manager delegates in each branch, to that branch's technician only.
    expect((await assign(as.qlkt12!, two, ids.kt1!)).status).toBe(422);
    expect((await assign(as.qlkt12!, two, ids.kt2!)).status).toBe(200);
    expect((await assign(as.qlkt12!, one, ids.kt1!)).status).toBe(200);
    // A CN1-only manager never reads CN2's incident.
    expect((await as.qlktA!.get(`/api/issues/${two}`)).status).toBe(403);
  });
});
