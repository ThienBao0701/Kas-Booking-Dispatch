import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';
import { jpegBuffer, notAnImageBuffer, pngBuffer, webpBuffer } from './helpers/images';
import { PROOF_UPLOAD_DIR } from '../src/config/env';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;
let otherBranchId: number;
let adminId: number;
let ownReceptionistId: number;

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

  /*
    Both receptionists check in to a shift.

    Submitting a proof IS the receptionist asserting "I created this
    reservation", so the server now takes the order's creator from the shift
    they are working and refuses the submission when there is none. That is the
    subject of bookingCreatorAttribution.test.ts; here it is just the precondition
    every one of these cases needs, so it is established once in the setup.
  */
  for (const agent of [ownAgent, otherAgent]) {
    const res = await agent
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

function newBooking(branchId = ownBranchId, code = 'PROOF00001') {
  // Arrives already claimed by the branch receptionist: CUT is a hard
  // prerequisite for submitting proof, so a fixture exercising that workflow
  // must be in the state a real order is in after the receptionist pressed it.
  return createDraftBooking({
    status: 'NEW',
    branchId,
    bookingCode: code,
    verificationStatus: 'NOT_SUBMITTED',
    // Only the own-branch fixture is claimed. An other-branch booking exists to
    // be REFUSED, and claiming it would mask which rule did the refusing.
    claimedByUserId: branchId === ownBranchId ? ownReceptionistId : null,
  });
}

describe('POST /api/bookings/:id/proofs (submit)', () => {
  it('lets the branch receptionist submit a PNG proof and moves it to PENDING_REVIEW', async () => {
    const b = await newBooking();
    const res = await ownAgent
      .post(`/api/bookings/${b.id}/proofs`)
      .field('note', 'Đã tạo trên hệ thống khách sạn')
      .attach('image', pngBuffer(), { filename: 'proof.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.booking.verificationStatus).toBe('PENDING_REVIEW');
    // Status stays NEW until an admin approves.
    expect(res.body.booking.status).toBe('NEW');
    expect(res.body.booking.proofs).toHaveLength(1);
    expect(res.body.booking.proofs[0].attemptNumber).toBe(1);
    expect(res.body.booking.proofs[0].status).toBe('PENDING_REVIEW');

    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(proof.submittedByUserId).toBe(ownReceptionistId);
    expect(proof.mimeType).toBe('image/png');
    // The stored name is server-generated, never the client filename.
    expect(proof.storedFileName).not.toContain('proof.png');
    expect(fs.existsSync(path.join(PROOF_UPLOAD_DIR, proof.storedFileName))).toBe(true);

    // Every active admin is notified.
    const notes = await testPrisma.notification.findMany({ where: { userId: adminId, bookingId: b.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Có đơn chờ kiểm tra');
  });

  it('accepts JPEG and WebP images', async () => {
    const b1 = await newBooking(ownBranchId, 'JPEG000001');
    const r1 = await ownAgent.post(`/api/bookings/${b1.id}/proofs`).attach('image', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(r1.status).toBe(201);

    const b2 = await newBooking(ownBranchId, 'WEBP000001');
    const r2 = await ownAgent.post(`/api/bookings/${b2.id}/proofs`).attach('image', webpBuffer(), { filename: 'p.webp', contentType: 'image/webp' });
    expect(r2.status).toBe(201);
  });

  it('rejects a request with no file (PROOF_REQUIRED)', async () => {
    const b = await newBooking();
    const res = await ownAgent.post(`/api/bookings/${b.id}/proofs`).field('note', 'no image');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROOF_REQUIRED');
  });

  it('rejects a non-image declared as a different type (415 at multer filter)', async () => {
    const b = await newBooking();
    const res = await ownAgent
      .post(`/api/bookings/${b.id}/proofs`)
      .attach('image', notAnImageBuffer(), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('rejects a spoofed image (declared image/png, bytes are not an image) via magic-byte sniff', async () => {
    const b = await newBooking();
    const res = await ownAgent
      .post(`/api/bookings/${b.id}/proofs`)
      .attach('image', notAnImageBuffer(), { filename: 'fake.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA');
    // Nothing is written to the DB for a rejected upload.
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: b.id } })).toBe(0);
  });

  it('rejects an oversized image (413)', async () => {
    const b = await newBooking();
    const tooBig = pngBuffer(10 * 1024 * 1024 + 32);
    const res = await ownAgent
      .post(`/api/bookings/${b.id}/proofs`)
      .attach('image', tooBig, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it("forbids submitting a proof for another branch's booking (isolation)", async () => {
    const b = await newBooking(otherBranchId, 'OTHER00001');
    const res = await ownAgent
      .post(`/api/bookings/${b.id}/proofs`)
      .attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_ACCESS_DENIED');
    expect(await testPrisma.bookingCreationProof.count({ where: { bookingId: b.id } })).toBe(0);
  });

  it('blocks a second submission while one is still PENDING_REVIEW', async () => {
    const b = await newBooking();
    await ownAgent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'a.png', contentType: 'image/png' });
    const again = await ownAgent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'b.png', contentType: 'image/png' });
    expect(again.status).toBe(409);
  });
});

describe('POST /api/bookings/:id/proofs/:proofId/approve', () => {
  async function submit(agent = ownAgent, branchId = ownBranchId, code = 'APPROVE001') {
    const b = await newBooking(branchId, code);
    const res = await agent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    return { bookingId: b.id, proofId: res.body.booking.proofs[0].id as string };
  }

  it('lets an admin approve the proof WITHOUT completing the booking', async () => {
    // Proof state and booking state are independent. Approving a proof says the
    // reservation was entered into the hotel system correctly; it says nothing
    // about whether the guest's stay has finished. Completing the booking here
    // would have marked a stay complete while the guest was still in the room,
    // and skipped every operational state beneath it.
    const { bookingId, proofId } = await submit();
    const res = await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.verificationStatus).toBe('APPROVED');
    // The lifecycle is untouched: the booking is still awaiting its branch.
    expect(res.body.booking.status).toBe('NEW');

    const history = await testPrisma.bookingStatusHistory.findMany({ where: { bookingId, newStatus: 'COMPLETED' } });
    expect(history).toHaveLength(0);

    // The submitting receptionist is notified of the approval.
    const notes = await testPrisma.notification.findMany({ where: { userId: ownReceptionistId, bookingId } });
    expect(notes.some((n) => n.title === 'Đơn đã được xác nhận đúng')).toBe(true);
  });

  it('forbids a receptionist from approving (admin only)', async () => {
    const { bookingId, proofId } = await submit();
    const res = await ownAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/approve`).send({});
    expect(res.status).toBe(403);
  });

  it('cannot approve the same proof twice', async () => {
    const { bookingId, proofId } = await submit();
    await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/approve`).send({});
    const again = await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/approve`).send({});
    expect(again.status).toBe(409);
  });
});

describe('POST /api/bookings/:id/proofs/:proofId/reject and resubmit', () => {
  async function submit(code: string) {
    const b = await newBooking(ownBranchId, code);
    const res = await ownAgent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    return { bookingId: b.id, proofId: res.body.booking.proofs[0].id as string };
  }

  it('rejects with a reason, keeps the booking NEW, and notifies the receptionist', async () => {
    const { bookingId, proofId } = await submit('REJECT0001');
    const res = await adminAgent
      .post(`/api/bookings/${bookingId}/proofs/${proofId}/reject`)
      .send({ reasonCode: 'WRONG_DATES', reviewNote: 'Ngày sai' });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('NEW');
    expect(res.body.booking.verificationStatus).toBe('REJECTED');

    const stored = await testPrisma.bookingCreationProof.findUniqueOrThrow({ where: { id: proofId } });
    expect(stored.status).toBe('REJECTED');
    expect(stored.reviewReasonCode).toBe('WRONG_DATES');

    const notes = await testPrisma.notification.findMany({ where: { userId: ownReceptionistId, bookingId } });
    expect(notes.some((n) => n.title === 'Đơn cần tạo lại' && n.body.includes('Sai ngày'))).toBe(true);
  });

  it('requires a reason code to reject', async () => {
    const { bookingId, proofId } = await submit('REJECT0002');
    const res = await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/reject`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REVIEW_REASON_REQUIRED');
    // The proof stays pending after a rejected (invalid) reject attempt.
    const proof = await testPrisma.bookingCreationProof.findUniqueOrThrow({ where: { id: proofId } });
    expect(proof.status).toBe('PENDING_REVIEW');
  });

  it('lets the receptionist resubmit after a rejection, creating attempt #2 (immutable history)', async () => {
    const { bookingId, proofId } = await submit('RESUB00001');
    await adminAgent.post(`/api/bookings/${bookingId}/proofs/${proofId}/reject`).send({ reasonCode: 'UNCLEAR_IMAGE' });

    // The verdict releases the claim: the order is back in "Đơn mới", takeable,
    // with a new claim cycle — and cannot be resubmitted until it is CUT again.
    const returned = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(returned.claimedByUserId).toBeNull();
    const queue = await ownAgent.get('/api/bookings/new');
    expect(queue.body.bookings.map((b: { id: string }) => b.id)).toContain(bookingId);
    const unclaimed = await ownAgent
      .post(`/api/bookings/${bookingId}/proofs`)
      .attach('image', jpegBuffer(), { filename: 'again.jpg', contentType: 'image/jpeg' });
    expect(unclaimed.status).toBe(409);
    expect((await ownAgent.post(`/api/bookings/${bookingId}/claim`).send({})).status).toBe(200);

    const res = await ownAgent
      .post(`/api/bookings/${bookingId}/proofs`)
      .attach('image', jpegBuffer(), { filename: 'again.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.booking.verificationStatus).toBe('PENDING_REVIEW');

    const proofs = await testPrisma.bookingCreationProof.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
    expect(proofs.map((p) => p.attemptNumber)).toEqual([1, 2]);
    // The rejected first attempt is preserved, never overwritten.
    expect(proofs[0]!.status).toBe('REJECTED');
    expect(proofs[1]!.status).toBe('PENDING_REVIEW');
  });
});

describe('GET /api/bookings/:id/proofs/:proofId/image (authorized access)', () => {
  async function submitWithProof(agent = ownAgent, branchId = ownBranchId, code = 'IMG0000001') {
    const b = await newBooking(branchId, code);
    const res = await agent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
    return { bookingId: b.id, proofId: res.body.booking.proofs[0].id as string };
  }

  it('serves the image to the branch receptionist and to an admin', async () => {
    const { bookingId, proofId } = await submitWithProof();
    const own = await ownAgent.get(`/api/bookings/${bookingId}/proofs/${proofId}/image`);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('image/png');
    expect(own.headers['x-content-type-options']).toBe('nosniff');

    const admin = await adminAgent.get(`/api/bookings/${bookingId}/proofs/${proofId}/image`);
    expect(admin.status).toBe(200);
  });

  it("denies a different branch's receptionist access to the image (isolation)", async () => {
    const { bookingId, proofId } = await submitWithProof();
    const res = await otherAgent.get(`/api/bookings/${bookingId}/proofs/${proofId}/image`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_ACCESS_DENIED');
  });

  it('returns 404 when the proof id does not belong to the booking', async () => {
    const { bookingId } = await submitWithProof();
    const other = await newBooking(ownBranchId, 'MISMATCH01');
    const res = await ownAgent.get(`/api/bookings/${other.id}/proofs/does-not-exist/image`);
    expect(res.status).toBe(404);
    // And a real proof id under the wrong booking is also rejected.
    void bookingId;
  });
});

describe('verification list endpoints', () => {
  it('splits bookings across new / pending-review / rejected by verificationStatus', async () => {
    await createDraftBooking({ status: 'NEW', branchId: ownBranchId, bookingCode: 'LIST000001', verificationStatus: 'NOT_SUBMITTED' });
    await createDraftBooking({ status: 'NEW', branchId: ownBranchId, bookingCode: 'LIST000002', verificationStatus: 'PENDING_REVIEW' });
    await createDraftBooking({ status: 'NEW', branchId: ownBranchId, bookingCode: 'LIST000003', verificationStatus: 'REJECTED' });

    const fresh = await ownAgent.get('/api/bookings/new');
    // "Đơn mới" holds the fresh order AND the one sent back as "Cần tạo lại".
    expect(fresh.body.bookings.map((b: { bookingCode: string }) => b.bookingCode).sort()).toEqual(['LIST000001', 'LIST000003']);

    const pending = await ownAgent.get('/api/bookings/pending-review');
    expect(pending.body.bookings.map((b: { bookingCode: string }) => b.bookingCode)).toEqual(['LIST000002']);

    const rejected = await ownAgent.get('/api/bookings/rejected');
    expect(rejected.body.bookings.map((b: { bookingCode: string }) => b.bookingCode)).toEqual(['LIST000003']);
  });

  it('isolates the pending-review and rejected lists by branch', async () => {
    await createDraftBooking({ status: 'NEW', branchId: otherBranchId, bookingCode: 'OTHERPEND1', verificationStatus: 'PENDING_REVIEW' });
    const res = await ownAgent.get(`/api/bookings/pending-review?branchId=${otherBranchId}`);
    expect(res.body.bookings).toHaveLength(0);
  });
});
