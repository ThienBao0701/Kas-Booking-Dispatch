import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IssueStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { assignTo } from './helpers/issues';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { BRANCH_COUNT } from '../src/db/branches';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let techAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
const TECHNICAL_PASSWORD = 'Technical1';
let ownBranchId: number;
let otherBranchId: number;
let ownReceptionistId: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  otherBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  ownReceptionistId = (await createReceptionist(ownBranchId, { username: 'letan_own', mustChangePassword: false })).id;
  ownAgent = (await loginAgent(app, 'letan_own', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(otherBranchId, { username: 'letan_other', mustChangePassword: false });
  otherAgent = (await loginAgent(app, 'letan_other', RECEPTIONIST_PASSWORD)).agent;
  // Bộ phận kỹ thuật drives the transitions now; an Admin is refused.
  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật viên trực',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  techAgent = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function makeIssue(branchId: number, status: IssueStatus = 'NEW') {
  return testPrisma.hotelIssue.create({
    data: { branchId, category: 'DOOR', description: 'test', status, reportedByUserId: ownReceptionistId },
  });
}

function summaryOf(agent: typeof adminAgent, query = '') {
  return agent.get(`/api/issues/summary${query}`);
}

interface BranchRow {
  branchId: number;
  newCount: number;
  inProgressCount: number;
  totalUnresolved: number;
}

function branchRow(body: { summary: { byBranch: BranchRow[] } }, branchId: number): BranchRow | undefined {
  return body.summary.byBranch.find((b) => b.branchId === branchId);
}

describe('GET /api/issues/summary — admin', () => {
  it('returns all eight branches, including zero-count ones', async () => {
    await makeIssue(ownBranchId, 'NEW');
    const res = await summaryOf(adminAgent);
    expect(res.status).toBe(200);
    expect(res.body.summary.byBranch).toHaveLength(BRANCH_COUNT);
    const empty = branchRow(res.body, otherBranchId);
    expect(empty?.totalUnresolved).toBe(0);
  });

  it('counts NEW and IN_PROGRESS but excludes COMPLETED', async () => {
    await makeIssue(ownBranchId, 'NEW');
    await makeIssue(ownBranchId, 'NEW');
    await makeIssue(ownBranchId, 'IN_PROGRESS');
    await makeIssue(ownBranchId, 'COMPLETED'); // must not be counted
    const res = await summaryOf(adminAgent);
    const own = branchRow(res.body, ownBranchId)!;
    expect(own.newCount).toBe(2);
    expect(own.inProgressCount).toBe(1);
    expect(own.totalUnresolved).toBe(3);
    expect(res.body.summary.totalUnresolved).toBe(3);
    expect(res.body.summary.newCount).toBe(2);
    expect(res.body.summary.inProgressCount).toBe(1);
  });

  it('a branch with three unresolved issues shows 3', async () => {
    await makeIssue(ownBranchId, 'NEW');
    await makeIssue(ownBranchId, 'NEW');
    await makeIssue(ownBranchId, 'IN_PROGRESS');
    const res = await summaryOf(adminAgent);
    expect(branchRow(res.body, ownBranchId)!.totalUnresolved).toBe(3);
  });
});

describe('GET /api/issues/summary — receptionist isolation', () => {
  it('shows a receptionist only their own branch', async () => {
    await makeIssue(ownBranchId, 'NEW');
    await makeIssue(otherBranchId, 'NEW');
    const res = await summaryOf(ownAgent);
    expect(res.status).toBe(200);
    expect(res.body.summary.byBranch).toHaveLength(1);
    expect(res.body.summary.byBranch[0].branchId).toBe(ownBranchId);
    expect(res.body.summary.totalUnresolved).toBe(1);
  });

  it('ignores a branchId query param (cannot see another branch)', async () => {
    await makeIssue(otherBranchId, 'NEW');
    // The other-branch receptionist tries to read own branch's numbers.
    const res = await summaryOf(otherAgent, `?branchId=${ownBranchId}`);
    expect(res.body.summary.byBranch).toHaveLength(1);
    expect(res.body.summary.byBranch[0].branchId).toBe(otherBranchId);
    expect(res.body.summary.byBranch[0].totalUnresolved).toBe(1);
  });

  it('an empty branch returns zero', async () => {
    const res = await summaryOf(ownAgent);
    expect(res.body.summary.byBranch[0].totalUnresolved).toBe(0);
    expect(res.body.summary.totalUnresolved).toBe(0);
  });
});

describe('GET /api/issues/summary — reflects workflow transitions', () => {
  it('creating an issue increments the unresolved total', async () => {
    const before = (await summaryOf(adminAgent)).body.summary.totalUnresolved;
    await ownAgent
      .post('/api/issues')
      .field('areaCategory', 'ROOM')
      .field('roomNumber', '301')
      .field('category', 'DOOR')
      .field('description', 'Cửa hỏng');
    const after = (await summaryOf(adminAgent)).body.summary.totalUnresolved;
    expect(after).toBe(before + 1);
  });

  it('accepting moves NEW→IN_PROGRESS without changing the unresolved total', async () => {
    const issue = await makeIssue(ownBranchId, 'NEW');
    const before = (await summaryOf(adminAgent)).body.summary;
    expect(before.newCount).toBe(1);
    expect(before.inProgressCount).toBe(0);

    await assignTo(adminAgent, issue.id, techAgent);
    await techAgent
      .post(`/api/issues/${issue.id}/accept`)
      .send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
    const after = (await summaryOf(adminAgent)).body.summary;
    expect(after.newCount).toBe(0);
    expect(after.inProgressCount).toBe(1);
    expect(after.totalUnresolved).toBe(before.totalUnresolved); // unchanged
  });

  it('completing decreases the unresolved total', async () => {
    const issue = await makeIssue(ownBranchId, 'NEW');
    const before = (await summaryOf(adminAgent)).body.summary.totalUnresolved;
    // COMPLETED is reachable only from IN_PROGRESS, so the incident is accepted
    // first — the summary counts both of those as unresolved.
    await assignTo(adminAgent, issue.id, techAgent);
    await techAgent
      .post(`/api/issues/${issue.id}/accept`)
      .send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
    await techAgent.post(`/api/issues/${issue.id}/complete`).send({});
    const after = (await summaryOf(adminAgent)).body.summary.totalUnresolved;
    expect(after).toBe(before - 1);
  });
});
