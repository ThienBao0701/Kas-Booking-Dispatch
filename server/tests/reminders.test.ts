/**
 * Nhắc nhở — Admin → ONE receptionist.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE: a reminder is private. Two receptionists
 * are created so "only the addressee can see it" is a real assertion rather
 * than a vacuous one, and the non-recipient is probed on every route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const BOOKING_DEPT_PASSWORD = 'Booking12345';
const BODY = 'Nhớ kiểm tra kỹ mã booking trước khi tạo đơn.';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let deptAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanA: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanB: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanAId: number;
let letanBId: number;
let adminId: number;
let cn1: number;

/** Sends a reminder to A and returns its id. */
async function sendToA(body = BODY): Promise<string> {
  const res = await adminAgent.post('/api/reminders').send({ recipientUserId: letanAId, body });
  expect(res.status).toBe(201);
  return res.body.reminder.id as string;
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn1 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  adminId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;

  await createUser({
    username: 'datphong',
    password: BOOKING_DEPT_PASSWORD,
    fullName: 'Bộ phận đặt phòng',
    role: 'BOOKING_DEPARTMENT',
    branchId: null,
    mustChangePassword: false,
  });
  deptAgent = (await loginAgent(app, 'datphong', BOOKING_DEPT_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letanA = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  letanAId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letana' } })).id;

  await createReceptionist(cn1, { username: 'letanb', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;
  letanBId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letanb' } })).id;
}, 120_000);

beforeEach(async () => {
  await testPrisma.reminder.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('creating a reminder', () => {
  it('lets an Admin send to a chosen receptionist', async () => {
    const id = await sendToA();
    const row = await testPrisma.reminder.findUniqueOrThrow({ where: { id } });
    expect(row.senderUserId).toBe(adminId);
    expect(row.recipientUserId).toBe(letanAId);
    expect(row.body).toBe(BODY);
    expect(row.readAt).toBeNull();
  });

  it('trims the body and refuses a blank one', async () => {
    const ok = await adminAgent
      .post('/api/reminders')
      .send({ recipientUserId: letanAId, body: `   ${BODY}   ` });
    expect(ok.status).toBe(201);
    expect(ok.body.reminder.body).toBe(BODY);

    const blank = await adminAgent
      .post('/api/reminders')
      .send({ recipientUserId: letanAId, body: '    ' });
    // 422 is this app's validation status (ApiError.validation), not 400.
    expect(blank.status).toBe(422);
  });

  it('refuses a recipient who is not a receptionist', async () => {
    const res = await adminAgent.post('/api/reminders').send({ recipientUserId: adminId, body: BODY });
    expect(res.status).toBe(422);
  });

  it('refuses a RECEPTIONIST trying to send', async () => {
    const res = await letanA.post('/api/reminders').send({ recipientUserId: letanBId, body: BODY });
    expect(res.status).toBe(403);
  });

  it('refuses Bộ phận đặt phòng entirely', async () => {
    expect((await deptAgent.get('/api/reminders')).status).toBe(403);
    expect(
      (await deptAgent.post('/api/reminders').send({ recipientUserId: letanAId, body: BODY })).status,
    ).toBe(403);
  });

  it('does not broadcast — only the addressee gets it', async () => {
    await sendToA();
    const mine = await letanA.get('/api/reminders');
    const theirs = await letanB.get('/api/reminders');
    expect(mine.body.reminders).toHaveLength(1);
    expect(theirs.body.reminders).toHaveLength(0);
  });
});

describe('reading', () => {
  it('the recipient sees it unread, then read', async () => {
    const id = await sendToA();

    const before = await letanA.get('/api/reminders');
    expect(before.body.reminders[0].read).toBe(false);
    expect((await letanA.get('/api/reminders/unread-count')).body.count).toBe(1);

    const opened = await letanA.post(`/api/reminders/${id}/read`);
    expect(opened.status).toBe(200);
    expect(opened.body.reminder.read).toBe(true);
    expect(opened.body.reminder.readAt).not.toBeNull();

    expect((await letanA.get('/api/reminders/unread-count')).body.count).toBe(0);
  });

  it('re-reading keeps the FIRST readAt', async () => {
    const id = await sendToA();
    const first = (await letanA.post(`/api/reminders/${id}/read`)).body.reminder.readAt;
    const second = (await letanA.post(`/api/reminders/${id}/read`)).body.reminder.readAt;
    expect(second).toBe(first);
  });

  it('ANOTHER receptionist cannot read it — 404, not 403', async () => {
    // A 403 would confirm the id exists, which already leaks that a colleague
    // was sent something.
    const id = await sendToA();
    expect((await letanB.post(`/api/reminders/${id}/read`)).status).toBe(404);
    expect((await testPrisma.reminder.findUniqueOrThrow({ where: { id } })).readAt).toBeNull();
  });

  it('the unread count is per-recipient', async () => {
    await sendToA();
    await sendToA('Nhắc nhở thứ hai');
    expect((await letanA.get('/api/reminders/unread-count')).body.count).toBe(2);
    expect((await letanB.get('/api/reminders/unread-count')).body.count).toBe(0);
  });

  it('an Admin sees what they sent, and whether it was read', async () => {
    const id = await sendToA();
    await letanA.post(`/api/reminders/${id}/read`);

    const res = await adminAgent.get('/api/reminders');
    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].read).toBe(true);
    expect(res.body.reminders[0].recipient.id).toBe(letanAId);
  });

  it('an Admin has no unread inbox of their own', async () => {
    await sendToA();
    expect((await adminAgent.get('/api/reminders/unread-count')).body.count).toBe(0);
  });

  it('refuses an anonymous caller', async () => {
    const request = (await import('supertest')).default;
    expect((await request(app).get('/api/reminders')).status).toBe(401);
  });
});
