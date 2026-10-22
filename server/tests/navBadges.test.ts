/**
 * Sidebar badge counts.
 *
 * THE REASON THESE EXIST: a badge is a promise that a screen has work on it.
 * A count that drifts from its list is worse than no count at all — a
 * receptionist who clicks "Đơn mới [1]" and finds it empty stops trusting every
 * other number in the menu. So each test here changes real state through the
 * real API and then asserts the badge followed, rather than asserting the
 * endpoint returns some number.
 *
 * Nothing is incremented anywhere in the implementation; each count is a
 * `count(*)` over the same `where` as its screen. These tests are what pins
 * that equivalence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { resetClock, setClock } from '../src/lib/clock';
import { CLAIM_WINDOW_MS } from '../src/booking/claim';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letan: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanId: number;
let adminId: number;
let cn1: number;

const BASE = new Date('2026-08-10T04:00:00.000Z');

function at(offsetMs: number): Date {
  const t = new Date(BASE.getTime() + offsetMs);
  setClock({ now: () => t });
  return t;
}

async function dispatchOrder(
  verificationStatus: 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'REJECTED' = 'NOT_SUBMITTED',
): Promise<string> {
  const booking = await testPrisma.booking.create({
    data: {
      bookingCode: `BK-${Math.random().toString(36).slice(2, 10)}`,
      customerName: 'NGUYEN VAN A',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER',
      branchId: cn1,
      status: 'NEW',
      verificationStatus,
      sentAt: BASE,
    },
  });
  return booking.id;
}

/** The counts as one of the two roles sees them. */
async function counts(agent: typeof letan) {
  const res = await agent.get('/api/nav-badges');
  expect(res.status).toBe(200);
  return res.body.counts as Record<string, number>;
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  const branches = await testPrisma.branch.findMany({ orderBy: { id: 'asc' } });
  cn1 = branches[0]!.id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  adminId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letan = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;
  letanId = (await testPrisma.user.findUniqueOrThrow({ where: { username: 'letana' } })).id;
}, 120_000);

beforeEach(async () => {
  await testPrisma.bookingAuditEvent.deleteMany({});
  await testPrisma.bookingCreationProof.deleteMany({});
  await testPrisma.booking.deleteMany({});
  await testPrisma.reminder.deleteMany({});
  await testPrisma.chatAttachment.deleteMany({});
  await testPrisma.chatMessage.deleteMany({});
  await testPrisma.chatConversation.deleteMany({});
  at(0);
});

afterEach(() => resetClock());

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

describe('nav badge counts', () => {
  it('requires a logged-in user', async () => {
    const anon = (await import('supertest')).default(app);
    expect((await anon.get('/api/nav-badges')).status).toBe(401);
  });

  it('counts the three dispatch queues separately', async () => {
    await dispatchOrder('NOT_SUBMITTED');
    await dispatchOrder('NOT_SUBMITTED');
    await dispatchOrder('PENDING_REVIEW');
    await dispatchOrder('REJECTED');

    // "Đơn mới" counts the order sent back for recreation too — it is listed there.
    expect(await counts(letan)).toMatchObject({ new: 3, pendingReview: 1, rejected: 1 });
  });

  it('gives Bộ phận đặt phòng all zeros — it has no operational queue', async () => {
    await dispatchOrder('NOT_SUBMITTED');
    await createUser({
      username: 'ctu',
      password: RECEPTIONIST_PASSWORD,
      fullName: 'Bo phan dat phong',
      role: 'BOOKING_DEPARTMENT',
      mustChangePassword: false,
    });
    const ctu = (await loginAgent(app, 'ctu', RECEPTIONIST_PASSWORD)).agent;

    expect(await counts(ctu)).toMatchObject({
      new: 0,
      pendingReview: 0,
      rejected: 0,
      resendOrders: 0,
      chat: 0,
      reminders: 0,
    });
  });

  /* ---------------- the counts track the claim lifecycle ---------------- */

  it('an active claim keeps the order in the receptionist count', async () => {
    const id = await dispatchOrder();
    at(0);
    await letan.post(`/api/bookings/${id}/cut`).send({ field: 'CUSTOMER_NAME' });

    expect((await counts(letan)).new).toBe(1);
  });

  it('EXPIRY moves the order from the receptionist count to the Admin resend count', async () => {
    const id = await dispatchOrder();
    at(0);
    await letan.post(`/api/bookings/${id}/cut`).send({ field: 'CUSTOMER_NAME' });
    expect((await counts(letan)).new).toBe(1);
    expect((await counts(adminAgent)).resendOrders).toBe(0);

    at(CLAIM_WINDOW_MS + 1);
    expect((await counts(letan)).new).toBe(0);
    expect((await counts(adminAgent)).resendOrders).toBe(1);
  });

  it('RESEND puts it back into the receptionist count', async () => {
    const id = await dispatchOrder();
    at(0);
    await letan.post(`/api/bookings/${id}/cut`).send({ field: 'CUSTOMER_NAME' });
    at(CLAIM_WINDOW_MS + 1);
    await adminAgent.post(`/api/bookings/${id}/resend`);

    expect((await counts(letan)).new).toBe(1);
    expect((await counts(adminAgent)).resendOrders).toBe(0);
  });

  it('a receptionist never sees a resend count — they have no such screen', async () => {
    const id = await dispatchOrder();
    at(0);
    await letan.post(`/api/bookings/${id}/cut`).send({ field: 'CUSTOMER_NAME' });
    at(CLAIM_WINDOW_MS + 1);

    expect((await counts(letan)).resendOrders).toBe(0);
  });

  /* ---------------- verdicts move orders between queues ---------------- */

  it('a rejected order leaves pendingReview and appears in rejected', async () => {
    const id = await dispatchOrder('PENDING_REVIEW');
    expect(await counts(letan)).toMatchObject({ pendingReview: 1, rejected: 0 });

    await testPrisma.booking.update({ where: { id }, data: { verificationStatus: 'REJECTED' } });
    expect(await counts(letan)).toMatchObject({ pendingReview: 0, rejected: 1 });
  });

  it('an approved order leaves every open queue', async () => {
    const id = await dispatchOrder('PENDING_REVIEW');
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED', status: 'COMPLETED' },
    });

    expect(await counts(letan)).toMatchObject({ new: 0, pendingReview: 0, rejected: 0 });
  });

  /* ---------------- reminders and chat ---------------- */

  it('counts unread reminders for the recipient only', async () => {
    await adminAgent.post('/api/reminders').send({ recipientUserId: letanId, body: 'Nhớ kiểm tra' });

    expect((await counts(letan)).reminders).toBe(1);
    // An Admin has no inbox of their own.
    expect((await counts(adminAgent)).reminders).toBe(0);
  });

  it('a read reminder stops being counted', async () => {
    await adminAgent.post('/api/reminders').send({ recipientUserId: letanId, body: 'Nhớ kiểm tra' });
    const list = await letan.get('/api/reminders');
    const reminderId = (list.body.reminders as { id: string }[])[0]!.id;

    await letan.post(`/api/reminders/${reminderId}/read`);
    expect((await counts(letan)).reminders).toBe(0);
  });

  it('counts chat threads awaiting each side', async () => {
    // A receptionist asking puts the thread on Admin's side of the count.
    await letan
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', 'Cho em hỏi');

    expect((await counts(adminAgent)).chat).toBe(1);
    expect((await counts(letan)).chat).toBe(0);
  });

  it('an Admin reply moves the chat count to the receptionist', async () => {
    await letan
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', 'Cho em hỏi');
    const list = await adminAgent.get('/api/chat/conversations');
    const conversationId = (list.body.conversations as { id: string }[])[0]!.id;

    await adminAgent
      .post(`/api/chat/conversations/${conversationId}/messages`)
      .field('body', 'Rồi nhé');

    expect((await counts(adminAgent)).chat).toBe(0);
    expect((await counts(letan)).chat).toBe(1);
  });

  it('does not leak another receptionist\'s reminders or threads', async () => {
    await createReceptionist(cn1, { username: 'letanb', mustChangePassword: false });
    const letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;

    await adminAgent.post('/api/reminders').send({ recipientUserId: letanId, body: 'Chỉ cho A' });
    await letan
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', 'Riêng A');
    const threads = await adminAgent.get('/api/chat/conversations');
    const conversationId = (threads.body.conversations as { id: string }[])[0]!.id;
    await adminAgent
      .post(`/api/chat/conversations/${conversationId}/messages`)
      .field('body', 'Trả lời A');

    expect((await counts(letanB)).reminders).toBe(0);
    expect((await counts(letanB)).chat).toBe(0);
    expect((await counts(letan)).reminders).toBe(1);
    expect((await counts(letan)).chat).toBe(1);
  });

  it('is stable across repeated reads — nothing is consumed by counting it', async () => {
    await dispatchOrder('NOT_SUBMITTED');
    await adminAgent.post('/api/reminders').send({ recipientUserId: letanId, body: 'x' });

    const first = await counts(letan);
    const second = await counts(letan);
    const third = await counts(letan);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(adminId).toBeGreaterThan(0);
  });
});
