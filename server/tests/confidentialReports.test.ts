/**
 * "VII. BÁO CÁO CÁC VẤN ĐỀ VÀ TÌNH HÌNH QUAN TRỌNG" — private, upward, kept.
 *
 *   12  a receptionist sends only to its own superiors (the server's list)
 *   13  … never to another branch's Quản lý lễ tân
 *   14  every Admin always reads it, chosen or not — even one created later
 *   15  peers, the sender, other branches and other departments cannot
 *   16  a manager reads only what was addressed to it
 *   17  "Đã đọc" is per reader
 *   18  the sender is the authenticated account, kept with its role and branch
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, createUser, loginAgent } from './helpers/auth';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const PASSWORD = 'Matkhau123';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let letan1: Agent;
let peer: Agent;
let letan2: Agent;
let rm1: Agent;
let rm2: Agent;
let general: Agent;
let hk: Agent;
let tech: Agent;
const ids: Record<string, number> = {};

async function person(username: string, fullName: string, role: string, branchId: number | null) {
  ids[username] = (await createUser({ username, password: PASSWORD, fullName, role: role as never, branchId, mustChangePassword: false })).id;
  return (await loginAgent(app, username, PASSWORD)).agent;
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  ids.admin = (await createAdmin({ mustChangePassword: false })).id;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  ids.letan1 = (await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false })).id;
  letan1 = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  ids.peer = (await createReceptionist(cn1, { username: 'peer', fullName: 'Đồng nghiệp CN1', mustChangePassword: false })).id;
  peer = (await loginAgent(app, 'peer', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân CN2', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  // The managers, made the way the Admin makes them: with their ticked branches.
  for (const [username, fullName, branchId] of [['rm1', 'Quản lý CN1', cn1], ['rm2', 'Quản lý CN2', cn2]] as const) {
    const res = await admin.post('/api/admin/users').send({ username, fullName, temporaryPassword: PASSWORD, role: 'RECEPTION_MANAGER', branchIds: [branchId] });
    expect(res.status).toBe(201);
    ids[username] = res.body.user.id;
    await testPrisma.user.update({ where: { id: res.body.user.id }, data: { mustChangePassword: false } });
  }
  rm1 = (await loginAgent(app, 'rm1', PASSWORD)).agent;
  rm2 = (await loginAgent(app, 'rm2', PASSWORD)).agent;
  general = await person('tongql', 'Tổng quản lý', 'RECEPTION_GENERAL_MANAGER', null);
  hk = await person('buongphong', 'Buồng phòng', 'HOUSEKEEPING', cn1);
  tech = await person('kythuat', 'Kỹ thuật', 'TECHNICAL', null);
});

beforeEach(async () => {
  await testPrisma.confidentialReportRecipient.deleteMany();
  await testPrisma.confidentialReport.deleteMany();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

const send = (agent: Agent, body: Record<string, unknown>) =>
  agent.post('/api/confidential-reports').send({ category: 'COLLEAGUES', content: 'Nội dung quan trọng', ...body });

const inbox = async (agent: Agent) =>
  (await agent.get('/api/confidential-reports')).body as {
    reports: { id: string; read: boolean; sender: { name: string } }[];
    counts: { unread: number; read: number };
  };

describe('who may be addressed', () => {
  it('12. a receptionist chooses among its own superiors only — the Admin is added by the system', async () => {
    const options = (await letan1.get('/api/confidential-reports/options')).body;
    expect(options.categories.map((c: { label: string }) => c.label)).toEqual([
      'Môi trường làm việc',
      'Quy trình, quy định',
      'Đồng nghiệp, nhân viên',
      'Các vấn đề tình hình quan trọng khác',
    ]);
    expect(options.recipients.map((r: { id: number }) => r.id).sort()).toEqual([ids.rm1, ids.tongql].sort());
    expect((await rm1.get('/api/confidential-reports/options')).body.recipients.map((r: { id: number }) => r.id)).toEqual([ids.tongql]);
    expect((await general.get('/api/confidential-reports/options')).body).toMatchObject({ canSend: true, recipients: [] });
    expect((await admin.get('/api/confidential-reports/options')).body).toMatchObject({ canSend: false, canRead: true });

    expect((await send(letan1, { recipientIds: [ids.rm1, ids.tongql] })).status).toBe(201);
    // Not a peer, not the Admin by hand, not oneself; and the Admin has nobody above it.
    for (const wrong of [ids.peer!, ids.admin, ids.letan1]) {
      expect((await send(letan1, { recipientIds: [wrong] })).status).toBe(403);
    }
    expect((await send(admin, {})).status).toBe(403);
    // Departments outside the reception hierarchy have no part in it.
    expect((await send(hk, {})).status).toBe(403);
    expect((await send(tech, {})).status).toBe(403);
    expect(await testPrisma.confidentialReport.count()).toBe(1);
    // Exactly the four kinds.
    expect((await send(letan1, { category: 'SALARY' })).status).toBe(422);
  });

  it('13. a branch-1 receptionist cannot address the branch-2 Quản lý lễ tân', async () => {
    const res = await send(letan1, { recipientIds: [ids.rm1, ids.rm2] });
    expect(res.status).toBe(403);
    expect(await testPrisma.confidentialReport.count()).toBe(0);
    expect((await letan2.get('/api/confidential-reports/options')).body.recipients.map((r: { id: number }) => r.id).sort()).toEqual(
      [ids.rm2, ids.tongql].sort(),
    );
  });
});

describe('who may read', () => {
  it('14. every Admin reads every report — chosen or not, even an Admin created afterwards', async () => {
    const id = (await send(letan1, { recipientIds: [ids.rm1] })).body.report.id;
    // Only to the Admin: nobody chosen.
    const quiet = (await send(letan1, { category: 'WORK_ENVIRONMENT', content: 'Chỉ Admin' })).body.report.id;
    expect((await inbox(admin)).reports.map((r) => r.id).sort()).toEqual([id, quiet].sort());
    const row = await testPrisma.confidentialReportRecipient.findFirstOrThrow({ where: { reportId: quiet, userId: ids.admin } });
    expect(row.automatic).toBe(true);

    await createUser({ username: 'admin2', password: PASSWORD, fullName: 'Admin Hai', role: 'ADMIN', branchId: null, mustChangePassword: false });
    const admin2 = (await loginAgent(app, 'admin2', PASSWORD)).agent;
    expect((await inbox(admin2)).counts).toEqual({ unread: 2, read: 0 });
    expect((await admin2.post(`/api/confidential-reports/${quiet}/read`)).status).toBe(200);
    expect((await inbox(admin2)).counts).toEqual({ unread: 1, read: 1 });
    // RM1 never sees the one it was not sent.
    expect((await inbox(rm1)).reports.map((r) => r.id)).toEqual([id]);
  });

  it('15. peers, the sender, another branch and other departments cannot see it', async () => {
    const id = (await send(letan1, { recipientIds: [ids.rm1] })).body.report.id;
    // Reception has no inbox — the sender's own list included.
    expect((await letan1.get('/api/confidential-reports')).status).toBe(403);
    expect((await peer.get('/api/confidential-reports')).status).toBe(403);
    for (const agent of [letan1, peer, letan2, rm2, general]) {
      expect((await agent.get(`/api/confidential-reports/${id}`)).status).toBe(404);
      expect((await agent.post(`/api/confidential-reports/${id}/read`)).status).toBe(404);
    }
    expect((await inbox(rm2)).reports).toEqual([]);
    for (const agent of [hk, tech]) expect((await agent.get(`/api/confidential-reports/${id}`)).status).toBe(403);
    // It is not a reception journal entry and appears in no journal.
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
  });

  it('16. a manager reads what was addressed to it; the Tổng quản lý what was addressed to it', async () => {
    const both = (await send(letan1, { recipientIds: [ids.rm1, ids.tongql] })).body.report.id;
    const generalOnly = (await send(letan1, { recipientIds: [ids.tongql], content: 'Về quản lý CN1' })).body.report.id;
    const fromManager = (await send(rm1, { recipientIds: [ids.tongql], category: 'PROCESS_RULES' })).body.report.id;
    expect((await inbox(rm1)).reports.map((r) => r.id)).toEqual([both]);
    expect((await inbox(general)).reports.map((r) => r.id).sort()).toEqual([both, generalOnly, fromManager].sort());
    // The manager's own report upward is not in its inbox.
    expect((await inbox(rm1)).reports.map((r) => r.id)).not.toContain(fromManager);
  });

  it('17. "Đã đọc" belongs to each reader', async () => {
    const id = (await send(letan1, { recipientIds: [ids.rm1, ids.tongql] })).body.report.id;
    const opened = await rm1.post(`/api/confidential-reports/${id}/read`);
    expect(opened.body.report).toMatchObject({ read: true });
    expect((await inbox(rm1)).counts).toEqual({ unread: 0, read: 1 });
    expect((await inbox(general)).counts).toEqual({ unread: 1, read: 0 });
    expect((await inbox(admin)).counts).toEqual({ unread: 1, read: 0 });
    expect((await general.get('/api/confidential-reports').query({ state: 'UNREAD' })).body.reports.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('18. the sender is the signed-in account, kept with its role and branch', async () => {
    const id = (await send(letan1, { recipientIds: [ids.rm1], senderUserId: ids.letan2, content: 'Sự việc ở quầy' })).body.report.id;
    const detail = (await rm1.get(`/api/confidential-reports/${id}`)).body.report;
    expect(detail).toMatchObject({
      sender: { id: ids.letan1, name: 'Lễ tân CN1', role: 'RECEPTIONIST', roleLabel: 'Lễ tân' },
      branch: { id: cn1 },
      category: 'COLLEAGUES',
      categoryLabel: 'Đồng nghiệp, nhân viên',
      content: 'Sự việc ở quầy',
      recipients: [{ id: ids.rm1, name: 'Quản lý CN1' }],
    });
    const stored = await testPrisma.confidentialReport.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ senderUserId: ids.letan1, senderRole: 'RECEPTIONIST', senderBranchId: cn1 });
  });
});
