/**
 * Branch isolation, proven for EVERY seeded branch rather than for a sample.
 *
 * The workflow is not a CN1 feature: all eight branches run it. A guarantee
 * demonstrated on one branch is not a guarantee, so this file dispatches a
 * booking to each branch in turn and asserts that
 *   - the branch's own receptionist can reach it, and
 *   - the receptionists of every OTHER branch cannot, by any route.
 *
 * Every branch is resolved by STABLE CODE from the seed. Nothing here assumes
 * database ids are 1..8, assumes an ordering, or indexes a branch by position.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Branch } from '@prisma/client';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { resetAll, resetBookingData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';
import { pngBuffer } from './helpers/images';

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

/** The stable codes of the seeded branches — the only identity used here. */
const BRANCH_CODES: readonly string[] = BRANCHES.map((b) => b.code);

let app: ReturnType<typeof createApp>;
let adminAgent: Agent;
let adminId: number;
/** Keyed by stable code, never by index. */
const branchByCode = new Map<string, Branch>();
const agentByCode = new Map<string, Agent>();
const receptionistIdByCode = new Map<string, number>();

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();

  adminId = (await createAdmin({ mustChangePassword: false })).id;
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  for (const code of BRANCH_CODES) {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code } });
    branchByCode.set(code, branch);

    const username = `letan_${code.toLowerCase()}`;
    const user = await createReceptionist(branch.id, { username, mustChangePassword: false });
    receptionistIdByCode.set(code, user.id);
    agentByCode.set(code, (await loginAgent(app, username, RECEPTIONIST_PASSWORD)).agent);
    /*
      Every receptionist checks in to a shift.

      Submitting a proof IS the receptionist asserting "I created this
      reservation", so the server now takes the order's creator from the shift
      they are working and refuses the submission when there is none. That rule
      is the subject of bookingCreatorAttribution.test.ts; here it is only the
      precondition these cases need.
    */
    await agentByCode.get(code)!
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
  }
});

beforeEach(async () => {
  // Only booking data is reset between cases: branches, accounts and the live
  // session cookies established in beforeAll must survive.
  await resetBookingData();
});

afterAll(async () => testPrisma.$disconnect());

/**
 * Dispatches a fresh booking to one branch, resolved by stable code, and lets
 * that branch's receptionist CUT it.
 *
 * The claim is part of the setup because CUT is a hard prerequisite for proof
 * submission — the real sequence is dispatch → CUT → create → submit, and a
 * fixture that skipped the claim would be refused for the wrong reason and
 * stop testing branch isolation at all.
 */
async function dispatchTo(code: string, bookingCode: string): Promise<string> {
  const branch = branchByCode.get(code)!;
  const draft = await createDraftBooking({ branchId: null, bookingCode });
  const res = await adminAgent
    .post(`/api/admin/bookings/${draft.id}/send`)
    .send({ branchId: branch.id });
  expect(res.status).toBe(200);

  const own = agentByCode.get(code)!;
  const claim = await own.post(`/api/bookings/${draft.id}/claim`);
  expect(claim.status).toBe(200);

  return draft.id;
}

/* ================================================================== */
/* Seed configuration — data-driven over all eight branches            */
/* ================================================================== */

describe('seeded branch configuration', () => {
  it('seeds exactly the expected branches, each with a distinct stable code', () => {
    expect(branchByCode.size).toBe(BRANCH_CODES.length);
    expect(new Set(BRANCH_CODES).size).toBe(BRANCH_CODES.length);
  });

  it.each(BRANCH_CODES)('%s has a complete, active configuration', (code) => {
    const branch = branchByCode.get(code)!;
    expect(branch.code).toBe(code);
    expect(branch.hotelName.trim().length).toBeGreaterThan(0);
    expect(branch.address.trim().length).toBeGreaterThan(0);
    expect(branch.branchNumber).toBeGreaterThan(0);
    expect(branch.active).toBe(true);
    // Breakfast is configuration every branch carries — a boolean, never
    // inferred from the code.
    expect(typeof branch.breakfastIncluded).toBe('boolean');
  });

  it('branch numbers are unique across active branches', () => {
    const numbers = [...branchByCode.values()].filter((b) => b.active).map((b) => b.branchNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('does not depend on database ids being 1..N', () => {
    // The assertion is about the SUITE, not the data: resolution is by code, so
    // the ids may legitimately be any positive integers.
    const ids = [...branchByCode.values()].map((b) => b.id);
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
  });
});

/* ================================================================== */
/* The isolation matrix                                                */
/* ================================================================== */

describe.each(BRANCH_CODES)('branch %s — dispatch and isolation', (code) => {
  it('its own receptionist receives the booking and can act on it', async () => {
    const bookingId = await dispatchTo(code, `MTX${code.slice(0, 6)}`.slice(0, 20));
    const own = agentByCode.get(code)!;
    const branch = branchByCode.get(code)!;

    // Inbox
    const inbox = await own.get('/api/bookings/new');
    expect(inbox.status).toBe(200);
    expect(inbox.body.bookings.map((b: { id: string }) => b.id)).toContain(bookingId);

    // Detail, scoped to the right branch
    const detail = await own.get(`/api/bookings/${bookingId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking.branch.code).toBe(code);
    expect(detail.body.booking.branch.address).toBe(branch.address);

    // Proof upload is authorized for the assigned branch
    const upload = await own
      .post(`/api/bookings/${bookingId}/proofs`)
      .attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);

    // The notification belongs to THIS branch's receptionist and nobody else.
    const dispatchNote = await testPrisma.notification.findMany({
      where: { bookingId, userId: { not: adminId } },
    });
    expect(dispatchNote).toHaveLength(1);
    expect(dispatchNote[0]!.userId).toBe(receptionistIdByCode.get(code));
  });

  it('every other branch receptionist is denied by id, list, image and body', async () => {
    const bookingId = await dispatchTo(code, `ISO${code.slice(0, 6)}`.slice(0, 20));
    const own = agentByCode.get(code)!;
    const branch = branchByCode.get(code)!;

    // Give the booking a real proof so the image endpoint is reachable at all.
    await own
      .post(`/api/bookings/${bookingId}/proofs`)
      .attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId } });

    for (const otherCode of BRANCH_CODES.filter((c) => c !== code)) {
      const other = agentByCode.get(otherCode)!;

      // 1. Direct booking id in the URL.
      const byId = await other.get(`/api/bookings/${bookingId}`);
      expect(byId.status).toBe(403);

      // 2. Query parameter forging another branch.
      const forged = await other.get('/api/bookings/new').query({ branchId: branch.id });
      expect(forged.status).toBe(200);
      expect(forged.body.bookings.map((b: { id: string }) => b.id)).not.toContain(bookingId);

      // 3. Proof image bytes.
      const image = await other.get(`/api/bookings/${bookingId}/proofs/${proof.id}/image`);
      expect(image.status).toBe(403);

      // 4. Request BODY claiming the other branch (proof submission).
      const write = await other
        .post(`/api/bookings/${bookingId}/proofs`)
        .field('branchId', String(branch.id))
        .attach('image', pngBuffer(), { filename: 'x.png', contentType: 'image/png' });
      expect(write.status).toBe(403);

      // 5. History cannot be widened to another branch.
      const history = await other.get('/api/bookings/history').query({ branchId: branch.id });
      expect(history.status).toBe(200);
      expect(history.body.bookings.map((b: { id: string }) => b.id)).not.toContain(bookingId);

      // 6. Review verdicts are Admin-only regardless of branch.
      const approve = await other.post(`/api/bookings/${bookingId}/proofs/${proof.id}/approve`);
      expect(approve.status).toBe(403);
    }

    // Nothing above created a stray attempt or notification.
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId } })).toBe(1);
    expect(
      await testPrisma.notification.count({ where: { bookingId, userId: { not: adminId } } }),
    ).toBe(1);
  });

  it('notifications stay private to their owner', async () => {
    const bookingId = await dispatchTo(code, `NTF${code.slice(0, 6)}`.slice(0, 20));
    const ownerId = receptionistIdByCode.get(code)!;
    const note = await testPrisma.notification.findFirstOrThrow({ where: { bookingId, userId: ownerId } });

    for (const otherCode of BRANCH_CODES.filter((c) => c !== code)) {
      const other = agentByCode.get(otherCode)!;
      const list = await other.get('/api/notifications');
      expect(list.status).toBe(200);
      expect(list.body.notifications.map((n: { id: string }) => n.id)).not.toContain(note.id);

      // Marking someone else's notification read must not succeed.
      const read = await other.post(`/api/notifications/${note.id}/read`);
      expect(read.status).toBe(404);
    }

    expect((await testPrisma.notification.findUniqueOrThrow({ where: { id: note.id } })).read).toBe(false);
  });
});

/* ================================================================== */
/* Admin reach across every branch                                     */
/* ================================================================== */

describe('Admin operates across all branches', () => {
  it('dispatches to every branch and can then read each one back by branch filter', async () => {
    const idByCode = new Map<string, string>();
    for (const code of BRANCH_CODES) {
      idByCode.set(code, await dispatchTo(code, `ADM${code.slice(0, 6)}`.slice(0, 20)));
    }

    for (const code of BRANCH_CODES) {
      const branch = branchByCode.get(code)!;
      const res = await adminAgent.get('/api/bookings/new').query({ branchId: branch.id });
      expect(res.status).toBe(200);
      const ids = res.body.bookings.map((b: { id: string }) => b.id);
      expect(ids).toContain(idByCode.get(code));
      // …and only that branch's booking.
      for (const otherCode of BRANCH_CODES.filter((c) => c !== code)) {
        expect(ids).not.toContain(idByCode.get(otherCode));
      }
    }

    // Unfiltered, the Admin sees all eight.
    const all = await adminAgent.get('/api/bookings/new').query({ pageSize: 100 });
    expect(all.status).toBe(200);
    for (const code of BRANCH_CODES) {
      expect(all.body.bookings.map((b: { id: string }) => b.id)).toContain(idByCode.get(code));
    }
  });

  it('reviews a proof from every branch', async () => {
    for (const code of BRANCH_CODES) {
      const bookingId = await dispatchTo(code, `REV${code.slice(0, 6)}`.slice(0, 20));
      await agentByCode
        .get(code)!
        .post(`/api/bookings/${bookingId}/proofs`)
        .attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
      const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId } });

      const approved = await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proof.id}/approve`);
      expect(approved.status).toBe(200);
      // Approval records the PROOF's outcome. The booking's lifecycle is
      // independent and is not advanced by it.
      expect(approved.body.booking.verificationStatus).toBe('APPROVED');
      expect(approved.body.booking.status).toBe('NEW');

      // The audit trail is identical in shape for every branch.
      const events = await testPrisma.bookingAuditEvent.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.action)).toEqual([
        // The receptionist takes ownership before creating the reservation.
        'BOOKING_CLAIMED',
        'BOOKING_PROOF_SUBMITTED',
        'BOOKING_PROOF_APPROVED',
      ]);
      // The claim is written outside the request-audit path that stamps a
      // correlation id, so only the proof events carry one.
      expect(
        events
          .filter((e) => e.action !== 'BOOKING_CLAIMED')
          .every((e) => e.correlationId !== null),
      ).toBe(true);

      await resetBookingData();
    }
  });
});
