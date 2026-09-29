import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { pngBuffer, notAnImageBuffer } from './helpers/images';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let techAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;
let otherBranchId: number;
let adminId: number;
let ownReceptionistId: number;
let techId: number;

const TECHNICAL_PASSWORD = 'Technical1';

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  otherBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  adminId = (await createAdmin({ mustChangePassword: false })).id;
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  ownReceptionistId = (await createReceptionist(ownBranchId, { username: 'letan_own', mustChangePassword: false })).id;
  ownAgent = (await loginAgent(app, 'letan_own', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(otherBranchId, { username: 'letan_other', mustChangePassword: false });
  otherAgent = (await loginAgent(app, 'letan_other', RECEPTIONIST_PASSWORD)).agent;

  // Bộ phận kỹ thuật: global (no branch), and the ONLY role that may move an
  // incident through its workflow.
  techId = (
    await createUser({
      username: 'kythuat',
      password: TECHNICAL_PASSWORD,
      fullName: 'Kỹ thuật viên trực',
      role: 'TECHNICAL',
      branchId: null,
      mustChangePassword: false,
    })
  ).id;
  techAgent = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

function createBody(agent: typeof ownAgent, over: Record<string, string> = {}) {
  return agent
    .post('/api/issues')
    // WHERE the incident is, asked first — it decides which other fields apply.
    .field('areaCategory', over.areaCategory ?? 'ROOM')
    .field('category', over.category ?? 'AIR_CONDITIONER')
    .field('description', over.description ?? 'Máy lạnh không lạnh')
    .field('roomNumber', over.roomNumber ?? '301');
}

describe('POST /api/issues (create)', () => {
  it('lets a receptionist report an issue for their own branch', async () => {
    const res = await createBody(ownAgent);
    expect(res.status).toBe(201);
    expect(res.body.issue.status).toBe('NEW');
    expect(res.body.issue.category).toBe('AIR_CONDITIONER');
    expect(res.body.issue.roomNumber).toBe('301');
    expect(res.body.issue.branch.id).toBe(ownBranchId);
    expect(res.body.issue.reportedBy.id).toBe(ownReceptionistId);
    expect(res.body.issue.photoUrl).toBeNull();

    // Every active admin is notified (badge +1).
    const notes = await testPrisma.notification.findMany({ where: { userId: adminId } });
    expect(notes.some((n) => n.title === 'Có báo cáo sự cố mới')).toBe(true);
  });

  it('ignores a client-supplied branchId for a receptionist (isolation)', async () => {
    const res = await createBody(ownAgent).field('branchId', String(otherBranchId));
    expect(res.status).toBe(201);
    expect(res.body.issue.branch.id).toBe(ownBranchId);
  });

  it('accepts an optional photo and serves it branch-isolated', async () => {
    const res = await createBody(ownAgent).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    const id = res.body.issue.id as string;
    expect(res.body.issue.photoUrl).toBe(`/api/issues/${id}/photo`);
    const own = await ownAgent.get(`/api/issues/${id}/photo`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('image/png');

    const admin = await adminAgent.get(`/api/issues/${id}/photo`);
    expect(admin.status).toBe(200);

    const other = await otherAgent.get(`/api/issues/${id}/photo`);
    expect(other.status).toBe(403);
  });

  it('rejects a non-image photo', async () => {
    const res = await createBody(ownAgent).attach('image', notAnImageBuffer(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
  });

  it('requires a description', async () => {
    const res = await ownAgent.post('/api/issues').field('category', 'DOOR').field('description', '   ');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/issues (branch isolation + admin all)', () => {
  beforeEach(async () => {
    await createBody(ownAgent, { description: 'Đơn của own' });
    await createBody(otherAgent, { description: 'Đơn của other' });
  });

  it('shows a receptionist only their own branch', async () => {
    const res = await ownAgent.get('/api/issues');
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].branch.id).toBe(ownBranchId);
  });

  it('shows an admin all branches, newest first', async () => {
    const res = await adminAgent.get('/api/issues');
    expect(res.body.issues).toHaveLength(2);
    // Newest first: the last-created ("other") comes first.
    expect(res.body.issues[0].description).toBe('Đơn của other');
  });

  it('lets an admin filter by branch', async () => {
    const res = await adminAgent.get(`/api/issues?branchId=${otherBranchId}`);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].branch.id).toBe(otherBranchId);
  });

  it("denies a receptionist another branch's issue detail", async () => {
    const other = await testPrisma.hotelIssue.findFirstOrThrow({ where: { branchId: otherBranchId } });
    const res = await ownAgent.get(`/api/issues/${other.id}`);
    expect(res.status).toBe(403);
  });
});

describe('status transitions (Bộ phận kỹ thuật only)', () => {
  async function newIssue(): Promise<string> {
    const res = await createBody(ownAgent);
    return res.body.issue.id;
  }

  const ACCEPT = { technicianName: 'Trần Văn B', technicianPhone: '0901234567' };

  it('technical accepts (NEW → IN_PROGRESS) then completes (→ COMPLETED)', async () => {
    const id = await newIssue();

    const accepted = await techAgent.post(`/api/issues/${id}/accept`).send(ACCEPT);
    expect(accepted.status).toBe(200);
    expect(accepted.body.issue.status).toBe('IN_PROGRESS');
    expect(accepted.body.issue.acceptedBy.id).toBe(techId);
    // Accepting always names the person holding the spanner.
    expect(accepted.body.issue.technicianName).toBe('Trần Văn B');
    expect(accepted.body.issue.technicianPhone).toBe('0901234567');
    expect(accepted.body.issue.acceptedAt).not.toBeNull();

    const completed = await techAgent.post(`/api/issues/${id}/complete`).send({});
    expect(completed.status).toBe(200);
    expect(completed.body.issue.status).toBe('COMPLETED');
    expect(completed.body.issue.completedBy.id).toBe(techId);
    expect(completed.body.issue.completedAt).not.toBeNull();

    // The reporter is notified on each status change.
    const notes = await testPrisma.notification.findMany({ where: { userId: ownReceptionistId } });
    expect(notes.some((n) => n.title === 'Sự cố đang được xử lý')).toBe(true);
    expect(notes.some((n) => n.title === 'Sự cố đã hoàn thành')).toBe(true);
  });

  /**
   * THE ADMIN IS READ-ONLY FOR THE WORKFLOW.
   *
   * An Admin used to drive these transitions, which recorded an administrator as
   * having done maintenance work. They monitor and report now; the API refuses
   * them, so the rule holds for anyone with a terminal rather than only for
   * someone looking at a screen with the buttons hidden.
   */
  it('forbids an ADMIN from accepting or completing', async () => {
    const id = await newIssue();

    expect((await adminAgent.post(`/api/issues/${id}/accept`).send(ACCEPT)).status).toBe(403);

    await techAgent.post(`/api/issues/${id}/accept`).send(ACCEPT);
    expect((await adminAgent.post(`/api/issues/${id}/complete`).send({})).status).toBe(403);

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.completedAt).toBeNull();
  });

  it('forbids a receptionist from changing status', async () => {
    const id = await newIssue();
    expect((await ownAgent.post(`/api/issues/${id}/accept`).send(ACCEPT)).status).toBe(403);
    expect((await ownAgent.post(`/api/issues/${id}/complete`).send({})).status).toBe(403);
  });

  /**
   * COMPLETED is reachable ONLY from IN_PROGRESS, which is what guarantees a
   * completed incident always names the technician who did the work.
   */
  it('refuses to complete an incident nobody accepted', async () => {
    const id = await newIssue();
    const res = await techAgent.post(`/api/issues/${id}/complete`).send({});
    expect(res.status).toBe(409);

    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('NEW');
  });
});

describe('receptionist edit rules', () => {
  /*
    "Sửa vấn đề": an OPEN incident can be corrected by the desk that reported it,
    including while a technician is on it (the old description is kept in
    HotelIssueEdit). Only a COMPLETED incident is a closed record.
  */
  it('lets the reporter edit while the incident is open, and refuses once completed', async () => {
    const id = (await createBody(ownAgent)).body.issue.id;

    const edited = await ownAgent.put(`/api/issues/${id}`).send({ description: 'Cập nhật mô tả' });
    expect(edited.status).toBe(200);
    expect(edited.body.issue.description).toBe('Cập nhật mô tả');

    await techAgent
      .post(`/api/issues/${id}/accept`)
      .send({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });

    const whileWorked = await ownAgent.put(`/api/issues/${id}`).send({ description: 'Sửa khi đang xử lý' });
    expect(whileWorked.status).toBe(200);
    expect(whileWorked.body.issue.status).toBe('IN_PROGRESS');

    await techAgent.post(`/api/issues/${id}/complete`).send({});
    const afterComplete = await ownAgent.put(`/api/issues/${id}`).send({ description: 'Sửa sau khi xong' });
    expect(afterComplete.status).toBe(409);
  });

  it("forbids editing another branch's issue", async () => {
    const other = (await createBody(otherAgent)).body.issue.id;
    const res = await ownAgent.put(`/api/issues/${other}`).send({ description: 'x' });
    expect(res.status).toBe(403);
  });
});
