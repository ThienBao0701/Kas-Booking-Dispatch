/**
 * "SỬA VẤN ĐỀ" — reception corrects an open incident, and nothing that matters is lost.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A correction can change the description, the place and the fault type,
 *      under the same area rules as the report form.
 *   2. It never touches when the incident was reported, its status, its
 *      technician or its repair attempts.
 *   3. Every changed field leaves an audit row with the old and the new value;
 *      re-saving an untouched form leaves none.
 *   4. A completed incident, another branch's incident and a non-reporting role
 *      are all refused.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
let letan: Agent;
let other: Agent;
let admin: Agent;
let tech: Agent;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  const app = createApp();
  const own = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  const far = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  await createReceptionist(own, { username: 'letan_own', mustChangePassword: false });
  await createReceptionist(far, { username: 'letan_far', mustChangePassword: false });
  await createUser({ username: 'kythuat', password: 'Technical1', fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  letan = (await loginAgent(app, 'letan_own', RECEPTIONIST_PASSWORD)).agent;
  other = (await loginAgent(app, 'letan_far', RECEPTIONIST_PASSWORD)).agent;
  tech = (await loginAgent(app, 'kythuat', 'Technical1')).agent;
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function report(fields: Record<string, string> = {}) {
  const res = await letan
    .post('/api/issues')
    .field('areaCategory', fields.areaCategory ?? 'ROOM')
    .field('category', fields.category ?? 'AIR_CONDITIONER')
    .field('description', fields.description ?? 'Máy lạnh không lạnh')
    .field('roomNumber', fields.roomNumber ?? '301');
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

const accept = async (id: string) => {
  await assignTo(admin, id, tech);
  return tech.post(`/api/issues/${id}/accept`).send({ technicianName: 'Bảo', technicianPhone: '0900000000' });
};

describe('what a correction may change', () => {
  it('changes the description, room and fault type, and says so in the audit', async () => {
    const id = await report();
    const res = await letan.put(`/api/issues/${id}`).send({
      description: 'Máy lạnh rò nước',
      roomNumber: '302',
      category: 'WATER',
    });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ description: 'Máy lạnh rò nước', roomNumber: '302', category: 'WATER' });
    const edits = res.body.issue.edits as { field: string; fieldLabel: string; oldValue: string; newValue: string; actorName: string }[];
    expect(edits.map((e) => e.field).sort()).toEqual(['category', 'description', 'roomNumber']);
    expect(edits.find((e) => e.field === 'roomNumber')).toMatchObject({
      fieldLabel: 'Số phòng',
      oldValue: '301',
      newValue: '302',
      actorName: 'Lễ tân Một',
    });
    // Enum values are read as words, not as column codes.
    expect(edits.find((e) => e.field === 'category')).toMatchObject({ oldValue: 'Máy lạnh', newValue: 'Nước' });
  });

  it('moves the incident to another area under the same rules as the form', async () => {
    const id = await report();
    const res = await letan.put(`/api/issues/${id}`).send({ areaCategory: 'HALLWAY', floorNumber: '3' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ areaCategory: 'HALLWAY', floorNumber: '3', roomNumber: null, category: null });
    // A hallway with no floor is not a place.
    const bad = await letan.put(`/api/issues/${id}`).send({ areaCategory: 'STAIRCASE', floorNumber: '' });
    expect(bad.status).toBe(422);
  });

  it('refuses an empty description and an empty body', async () => {
    const id = await report();
    expect((await letan.put(`/api/issues/${id}`).send({ description: '   ' })).status).toBe(422);
    expect((await letan.put(`/api/issues/${id}`).send({})).status).toBe(422);
  });

  it('writes no audit row for a save that changes nothing', async () => {
    const id = await report();
    const res = await letan.put(`/api/issues/${id}`).send({ description: 'Máy lạnh không lạnh', roomNumber: '301' });
    expect(res.status).toBe(200);
    expect(await testPrisma.hotelIssueEdit.count()).toBe(0);
  });
});

describe('what a correction never touches', () => {
  it('keeps the report time, the status, the technician and the repair history', async () => {
    const id = await report();
    await accept(id);
    const before = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id }, include: { attempts: true } });

    const res = await letan.put(`/api/issues/${id}`).send({ description: 'Sửa giữa chừng' });
    expect(res.status).toBe(200);

    const after = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id }, include: { attempts: true } });
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.technicianName).toBe('Bảo');
    expect(after.acceptedAt?.toISOString()).toBe(before.acceptedAt?.toISOString());
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]!.id).toBe(before.attempts[0]!.id);
    expect(res.body.issue.attempts).toHaveLength(1);
  });

  it('cannot smuggle in a status, a timestamp or a technician', async () => {
    const id = await report();
    const res = await letan.put(`/api/issues/${id}`).send({
      description: 'x',
      status: 'COMPLETED',
      createdAt: '2020-01-01T00:00:00Z',
      technicianName: 'Ai đó',
    });
    expect(res.status).toBe(200);
    const stored = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('NEW');
    expect(stored.technicianName).toBeNull();
    expect(stored.createdAt.getFullYear()).not.toBe(2020);
  });
});

describe('who may correct what', () => {
  it('refuses a completed incident', async () => {
    const id = await report();
    await accept(id);
    await tech.post(`/api/issues/${id}/complete`).send({});
    expect((await letan.put(`/api/issues/${id}`).send({ description: 'Muộn rồi' })).status).toBe(409);
  });

  it('refuses another branch’s incident', async () => {
    const id = await report();
    expect((await other.put(`/api/issues/${id}`).send({ description: 'x' })).status).toBe(403);
  });

  it('refuses Bộ phận kỹ thuật — it works incidents, it does not rewrite them', async () => {
    const id = await report();
    expect((await tech.put(`/api/issues/${id}`).send({ description: 'x' })).status).toBe(403);
  });

  it('lets the Admin correct any branch’s incident, as themselves', async () => {
    const id = await report();
    const res = await admin.put(`/api/issues/${id}`).send({ description: 'Admin chỉnh lại' });
    expect(res.status).toBe(200);
    expect(res.body.issue.edits[0].actorName).toBe('Quản trị viên');
  });
});
