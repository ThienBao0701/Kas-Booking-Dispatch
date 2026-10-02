/**
 * A dispatched booking must be visible to reception at EVERY point in its life.
 *
 * Separating the proof lifecycle from the booking lifecycle introduced a hole
 * that no existing test could see: proof approval stopped completing the
 * booking, so an approved booking sat at NEW with verificationStatus APPROVED —
 * which matched none of the three reception lists, and was not in "completed"
 * either. It disappeared from every reception screen while still needing to be
 * received and checked in. Reception cannot serve a guest they cannot see.
 *
 * This walks the whole workflow and asserts visibility after every single step,
 * rather than checking the endpoints in isolation. A booking that vanishes at
 * any point fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';

const AGODA_RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'agoda', '10-list-page-above-reservation.txt'),
  'utf8',
);

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let reception: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn5 = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  cn5 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LE_THANH_TON_278' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn5, { username: 'letan_vis', mustChangePassword: false });
  reception = (await loginAgent(app, 'letan_vis', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.booking.deleteMany();
});

afterAll(async () => testPrisma.$disconnect());

/** Every reception list a booking could legitimately appear on. */
const RECEPTION_LISTS = ['/api/bookings/new', '/api/bookings/pending-review', '/api/bookings/rejected'];

/** Which reception lists currently contain this booking. */
async function listsContaining(bookingId: string): Promise<string[]> {
  const found: string[] = [];
  for (const url of RECEPTION_LISTS) {
    const res = await reception.get(url);
    expect(res.status, url).toBe(200);
    if (res.body.bookings.some((b: { id: string }) => b.id === bookingId)) found.push(url);
  }
  return found;
}

/** Asserts the booking is on exactly one reception list, and says which. */
async function expectVisible(bookingId: string, step: string): Promise<void> {
  const lists = await listsContaining(bookingId);
  expect(lists.length, `after ${step}, booking was on lists: ${JSON.stringify(lists)}`).toBe(1);
}

async function dispatchOne(): Promise<string> {
  const res = await admin
    .post('/api/admin/ota/dispatch')
    .send({ source: 'AGODA', rawText: AGODA_RAW, adminPmsNote: 'Nguyen Van A\nCa sáng', overrides: { paymentMode: 'CN' } });
  expect(res.status).toBe(201);
  return res.body.bookingId as string;
}

const act = (id: string, action: string) => reception.post(`/api/bookings/${id}/${action}`).send({});

describe('a booking is never invisible to reception', () => {
  it('stays visible from dispatch through proof approval to completion', async () => {
    /* 1. Admin dispatches -------------------------------------------- */
    const id = await dispatchOne();
    await expectVisible(id, 'dispatch');
    expect((await listsContaining(id))[0]).toBe('/api/bookings/new');

    /* 2. Reception submits a proof ------------------------------------ */
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'PENDING_REVIEW' },
    });
    await expectVisible(id, 'proof submitted');
    expect((await listsContaining(id))[0]).toBe('/api/bookings/pending-review');

    /* 3. Admin approves the proof ------------------------------------- */
    // Since 5.2c an approved booking LEAVES the reception queue — the
    // lifecycle UI is gone, so there is nothing left for reception to do with
    // it. The property that still holds is the one this file is named for: it
    // is never invisible. It moves to the confirmed list.
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED', reviewedAt: new Date() },
    });
    expect(await listsContaining(id)).toEqual([]);
    const confirmed = await reception.get('/api/bookings/completed');
    expect(confirmed.body.bookings.some((b: { id: string }) => b.id === id)).toBe(true);

    /* 4. Reception runs the operational lifecycle ---------------------- */
    expect((await act(id, 'receive')).status).toBe(200);
    expect((await act(id, 'check-in')).status).toBe(200);
    expect((await act(id, 'check-out')).status).toBe(200);
    expect((await act(id, 'complete')).status).toBe(200);

    /* 5. Completed bookings live on the completed list ----------------- */
    const completed = await reception.get('/api/bookings/completed');
    expect(completed.status).toBe(200);
    expect(completed.body.bookings.some((b: { id: string }) => b.id === id)).toBe(true);

    // And a finished booking is no longer in the active queues.
    expect(await listsContaining(id)).toEqual([]);
  });

  it('remains reachable by detail at every stage', async () => {
    const id = await dispatchOne();
    const stages: [string, () => Promise<unknown>][] = [
      ['dispatched', async () => undefined],
      ['approved', () =>
        testPrisma.booking.update({
          where: { id },
          data: { verificationStatus: 'APPROVED', reviewedAt: new Date() },
        })],
      ['received', () => act(id, 'receive')],
      ['checked in', () => act(id, 'check-in')],
      ['checked out', () => act(id, 'check-out')],
      ['completed', () => act(id, 'complete')],
    ];

    for (const [step, run] of stages) {
      await run();
      const res = await reception.get(`/api/bookings/${id}`);
      expect(res.status, step).toBe(200);
      expect(res.body.booking.id, step).toBe(id);
    }
  });

  it('shows a rejected proof on the rejected list, not lost', async () => {
    const id = await dispatchOne();
    await testPrisma.booking.update({ where: { id }, data: { verificationStatus: 'REJECTED' } });
    await expectVisible(id, 'proof rejected');
    expect((await listsContaining(id))[0]).toBe('/api/bookings/rejected');
  });

  it('moves an approved booking to the confirmed list and nowhere else', async () => {
    // Visible in exactly one place — never duplicated across queues, and never
    // nowhere. Since 5.2c that one place is the confirmed list.
    const id = await dispatchOne();
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED', reviewedAt: new Date() },
    });
    expect(await listsContaining(id)).toEqual([]);

    const confirmed = await reception.get('/api/bookings/completed');
    expect(confirmed.body.bookings.filter((b: { id: string }) => b.id === id)).toHaveLength(1);
  });
});

/* ================================================================== */
/* Dashboard counters after the separation                             */
/* ================================================================== */
describe('dashboard counters mean what their labels say', () => {
  it('counts a proof approval as confirmed today, not a completed stay', async () => {
    const id = await dispatchOne();

    const before = await admin.get('/api/admin/dashboard/summary');
    expect(before.body.totals.confirmedToday).toBe(0);
    expect(before.body.totals.waiting).toBe(1);

    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED', reviewedAt: new Date() },
    });

    const after = await admin.get('/api/admin/dashboard/summary');
    // Confirmed the moment the Admin approved — not days later at check-out.
    expect(after.body.totals.confirmedToday).toBe(1);
    // And it is no longer waiting on the branch to create the reservation.
    expect(after.body.totals.waiting).toBe(0);
  });

  it('does not count a completed stay as confirmed today', async () => {
    const id = await dispatchOne();
    for (const action of ['receive', 'check-in', 'check-out', 'complete']) {
      expect((await act(id, action)).status, action).toBe(200);
    }

    const summary = await admin.get('/api/admin/dashboard/summary');
    // The stay finished, but no proof was ever approved.
    expect(summary.body.totals.confirmedToday).toBe(0);
  });

  it('reports the counters per branch as well as in total', async () => {
    const id = await dispatchOne();
    await testPrisma.booking.update({
      where: { id },
      data: { verificationStatus: 'APPROVED', reviewedAt: new Date() },
    });

    const summary = await admin.get('/api/admin/dashboard/summary');
    const branch = summary.body.branches.find((b: { branch: { id: number } }) => b.branch.id === cn5);
    expect(branch.confirmedToday).toBe(1);
    expect(branch.waiting).toBe(0);
  });
});
