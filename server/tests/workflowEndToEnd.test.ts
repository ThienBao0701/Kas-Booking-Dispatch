/**
 * The complete operational workflow, end to end, in ONE test.
 *
 * Every leg of this flow is already covered in isolation elsewhere. What was
 * missing — and what this file adds — is the SEAM: that the legs actually
 * compose into a working booking lifecycle, and that the audit trail and
 * notifications a supervisor reads afterwards are complete.
 *
 * Admin intake/draft
 *   -> validation refuses an incomplete dispatch
 *   -> Admin assigns a branch and dispatches
 *   -> the branch receptionist receives it
 *   -> the receptionist has the data a PMS entry needs
 *   -> proof upload (= submission for review)
 *   -> proof comparison
 *   -> Admin approves
 *   -> history, audit events and notifications are complete.
 *
 * The branch is resolved by STABLE CODE from the seed, never by database id and
 * never by list position. It is one representative branch; the parameterized
 * matrix over all eight lives in branchIsolationMatrix.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createDraftBooking } from './helpers/bookings';
import { pngBuffer } from './helpers/images';
import { mockSuccessProvider } from './helpers/ocr';
import { resetOcrProvider, setOcrProvider } from '../src/booking/ocr/provider';
import { submitProof } from '../src/booking/proof';
import { ApiError } from '../src/lib/errors';

/** The representative branch, resolved by stable code — never by id. */
const BRANCH_CODE = 'TRUONG_DINH_05';

const OCR_TEXT = [
  'Booking ID: 6039118394',
  'Guest name: Nguyen Van A',
  'Check-in: 24/07/2026',
  'Check-out: 28/07/2026',
  '4 nights',
  'Room type: Superior Double',
  '1 phòng',
  'Total: VND 4.720.680',
  'PAY AFTER CHECK-IN',
].join('\n');

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let branchId: number;
let adminId: number;
let receptionistId: number;

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();

  const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: BRANCH_CODE } });
  branchId = branch.id;

  adminId = (await createAdmin({ mustChangePassword: false })).id;
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  receptionistId = (
    await createReceptionist(branchId, { username: 'letan_e2e', mustChangePassword: false })
  ).id;
  receptionAgent = (await loginAgent(app, 'letan_e2e', RECEPTIONIST_PASSWORD)).agent;
  /*
    Every receptionist checks in to a shift.

    Submitting a proof IS the receptionist asserting "I created this
    reservation", so the server now takes the order's creator from the shift
    they are working and refuses the submission when there is none. That rule
    is the subject of bookingCreatorAttribution.test.ts; here it is only the
    precondition these cases need.
  */
  await receptionAgent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
});

afterEach(() => resetOcrProvider());
afterAll(async () => testPrisma.$disconnect());

describe('end-to-end operational workflow', () => {
  it('runs intake -> dispatch -> reception -> proof -> comparison -> approval, with a complete trail', async () => {
    setOcrProvider(mockSuccessProvider(OCR_TEXT));

    /* -------- 1. Admin intake: an unassigned draft ------------------- */
    const draft = await createDraftBooking({
      branchId: null,
      bookingCode: '6039118394',
      customerName: 'Nguyễn Văn A',
      checkIn: '2026-07-24',
      checkOut: '2026-07-28',
      roomType: 'Superior Double',
      // 4 nights x 1.180.170 = 4.720.680, so the room subtotal and the booking
      // total agree and the dispatch carries no unacknowledged warnings.
      nightlyAmount: 1_180_170,
      totalAmount: 4_720_680,
      paymentStatus: 'PAY_AFTER',
      createdByUserId: adminId,
    });
    expect(draft.status).toBe('DRAFT');

    /* -------- 2. Validation refuses a dispatch to a bad branch -------- */
    const inactive = await testPrisma.branch.create({
      data: { code: 'E2E_INACTIVE', hotelName: 'X', address: 'X', branchNumber: 99, active: false },
    });
    const refused = await adminAgent
      .post(`/api/admin/bookings/${draft.id}/send`)
      .send({ branchId: inactive.id });
    expect(refused.status).toBe(422); // VALIDATION_ERROR
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    // Nothing moved.
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');

    /* -------- 3. Admin assigns the branch and dispatches -------------- */
    const sent = await adminAgent
      .post(`/api/admin/bookings/${draft.id}/send`)
      .send({ branchId, acknowledgedWarningCodes: [] });
    expect(sent.status).toBe(200);
    expect(sent.body.booking.status).toBe('NEW');
    expect(sent.body.booking.branch.code).toBe(BRANCH_CODE);
    expect(sent.body.booking.sentAt).toBeTruthy();

    const afterSend = await testPrisma.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(afterSend.branchId).toBe(branchId);
    expect(afterSend.sentByUserId).toBe(adminId);

    // Dispatch wrote history and notified exactly this branch's receptionist.
    const dispatchHistory = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: draft.id, newStatus: 'NEW' },
    });
    expect(dispatchHistory).toHaveLength(1);
    expect(dispatchHistory[0]!.changedByUserId).toBe(adminId);

    const dispatchNotes = await testPrisma.notification.findMany({ where: { bookingId: draft.id } });
    expect(dispatchNotes).toHaveLength(1);
    expect(dispatchNotes[0]!.userId).toBe(receptionistId);

    /* -------- 4. The branch receptionist receives it ------------------ */
    const inbox = await receptionAgent.get('/api/bookings/new');
    expect(inbox.status).toBe(200);
    expect(inbox.body.bookings.map((b: { id: string }) => b.id)).toContain(draft.id);

    /* -------- 5. The data a PMS entry needs is present ---------------- */
    const detail = await receptionAgent.get(`/api/bookings/${draft.id}`);
    expect(detail.status).toBe(200);
    const view = detail.body.booking;
    expect(view.bookingCode).toBe('6039118394');
    expect(view.customerName).toBe('Nguyễn Văn A');
    expect(view.checkInDate).toBe('2026-07-24');
    expect(view.checkOutDate).toBe('2026-07-28');
    expect(view.branch.address).toBe(
      (await testPrisma.branch.findUniqueOrThrow({ where: { code: BRANCH_CODE } })).address,
    );
    // Branch configuration the PMS note depends on travels with the booking.
    expect(view.branch).toHaveProperty('breakfastIncluded');
    expect(view.rooms).toHaveLength(1);
    expect(view.rooms[0].nights).toHaveLength(4);
    // A receptionist never receives the raw OTA source text.
    expect(view.rawText).toBeUndefined();

    /* -------- 6. The receptionist takes the order (CUT) --------------- */
    // Ownership before creation work: this is what stops two receptionists
    // creating the same reservation in the hotel system, and it is a hard
    // prerequisite for the upload that follows.
    const claim = await receptionAgent.post(`/api/bookings/${draft.id}/claim`);
    expect(claim.status).toBe(200);
    expect(new Date(claim.body.claimExpiresAt).getTime()).toBeGreaterThan(
      new Date(claim.body.claimedAt).getTime(),
    );

    /* -------- 7. Proof upload = submission for review ----------------- */
    const upload = await receptionAgent
      .post(`/api/bookings/${draft.id}/proofs`)
      .attach('image', pngBuffer(), { filename: 'proof.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.booking.verificationStatus).toBe('PENDING_REVIEW');

    const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: draft.id },
    });
    expect(proof.attemptNumber).toBe(1);
    expect(proof.submittedByUserId).toBe(receptionistId);

    // The submission is now in the booking audit trail.
    const submitted = await testPrisma.bookingAuditEvent.findMany({
      where: { bookingId: draft.id, action: 'BOOKING_PROOF_SUBMITTED' },
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.actorUserId).toBe(receptionistId);
    expect(submitted[0]!.actorRole).toBe('RECEPTIONIST');
    expect(submitted[0]!.oldValue).toBe('NOT_SUBMITTED');
    expect(submitted[0]!.newValue).toBe('PENDING_REVIEW');
    expect(submitted[0]!.reason).toBe('PROOF_ATTEMPT_1');

    // Admins were notified that something awaits review.
    const adminNotes = await testPrisma.notification.findMany({
      where: { bookingId: draft.id, userId: adminId },
    });
    expect(adminNotes).toHaveLength(1);

    /* -------- 7. Comparison ran and is readable by the Admin ---------- */
    const comparison = await adminAgent.get(
      `/api/admin/bookings/${draft.id}/proofs/${proof.id}/comparisons/latest`,
    );
    expect(comparison.status).toBe(200);
    expect(comparison.body.comparison).not.toBeNull();
    expect(comparison.body.comparison.overallStatus).toBe('MATCH');

    /* -------- 8. Admin approves --------------------------------------- */
    const approved = await adminAgent.post(
      `/api/bookings/${draft.id}/proofs/${proof.id}/approve`,
    );
    expect(approved.status).toBe(200);
    expect(approved.body.booking.verificationStatus).toBe('APPROVED');
    // Approving the proof confirms the reservation was entered correctly. It
    // does NOT end the stay: the booking stays where the lifecycle left it, and
    // reaches COMPLETED only after the guest has checked out.
    expect(approved.body.booking.status).toBe('NEW');

    /* -------- 9. The trail is complete -------------------------------- */
    const statusHistory = await testPrisma.bookingStatusHistory.findMany({
      where: { bookingId: draft.id },
      orderBy: { changedAt: 'asc' },
    });
    // Dispatch is the only lifecycle transition this flow performs. Approving
    // the proof adds no status row, because it changes no status — the
    // operational transitions have their own coverage in bookingLifecycle.
    expect(statusHistory.map((h) => h.newStatus)).toEqual(['NEW']);

    const auditActions = (
      await testPrisma.bookingAuditEvent.findMany({
        where: { bookingId: draft.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.action);
    // The full trail now opens with the receptionist taking ownership — the
    // step that makes "who was creating this reservation?" answerable.
    expect(auditActions).toEqual([
      'BOOKING_CLAIMED',
      'BOOKING_PROOF_SUBMITTED',
      'BOOKING_PROOF_APPROVED',
    ]);

    const approvedEvent = await testPrisma.bookingAuditEvent.findFirstOrThrow({
      where: { bookingId: draft.id, action: 'BOOKING_PROOF_APPROVED' },
    });
    expect(approvedEvent.actorUserId).toBe(adminId);
    expect(approvedEvent.actorRole).toBe('ADMIN');

    // The receptionist was told the outcome.
    const outcome = await testPrisma.notification.findMany({
      where: { bookingId: draft.id, userId: receptionistId },
      orderBy: { createdAt: 'asc' },
    });
    expect(outcome).toHaveLength(2); // dispatched, then approved
    expect(outcome[1]!.title).toContain('xác nhận đúng');
  });

  it('rejection is the correction request: it is audited, and the resubmission is a second attempt', async () => {
    setOcrProvider(mockSuccessProvider(OCR_TEXT));

    const booking = await createDraftBooking({
      status: 'NEW',
      branchId,
      bookingCode: 'E2EREJECT1',
      verificationStatus: 'NOT_SUBMITTED',
      // CUT is a hard prerequisite for submitting proof.
      claimedByUserId: receptionistId,
    });

    await receptionAgent
      .post(`/api/bookings/${booking.id}/proofs`)
      .attach('image', pngBuffer(), { filename: 'p1.png', contentType: 'image/png' });
    const first = await testPrisma.bookingCreationProof.findFirstOrThrow({
      where: { bookingId: booking.id, attemptNumber: 1 },
    });

    const rejected = await adminAgent
      .post(`/api/bookings/${booking.id}/proofs/${first.id}/reject`)
      .send({ reasonCode: 'WRONG_DATES', reviewNote: 'Ngày nhận phòng không khớp.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.booking.verificationStatus).toBe('REJECTED');
    // The booking stays operationally open — it is a correction request, not a close.
    expect(rejected.body.booking.status).toBe('NEW');

    const rejectEvent = await testPrisma.bookingAuditEvent.findFirstOrThrow({
      where: { bookingId: booking.id, action: 'BOOKING_PROOF_REJECTED' },
    });
    expect(rejectEvent.actorUserId).toBe(adminId);
    expect(rejectEvent.newValue).toBe('REJECTED');
    // Only the stable reason CODE is stored — never the free-text note.
    expect(rejectEvent.reason).toBe('WRONG_DATES');
    expect(JSON.stringify(rejectEvent)).not.toContain('Ngày nhận phòng không khớp.');

    // The receptionist takes the returned order again (CUT), recreates and
    // resubmits: attempt #2, first attempt intact.
    expect((await receptionAgent.post(`/api/bookings/${booking.id}/claim`).send({})).status).toBe(200);
    await receptionAgent
      .post(`/api/bookings/${booking.id}/proofs`)
      .attach('image', pngBuffer(), { filename: 'p2.png', contentType: 'image/png' });

    const attempts = await testPrisma.bookingCreationProof.findMany({
      where: { bookingId: booking.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(attempts[0]!.status).toBe('REJECTED'); // immutable

    const submissions = await testPrisma.bookingAuditEvent.findMany({
      where: { bookingId: booking.id, action: 'BOOKING_PROOF_SUBMITTED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(submissions.map((s) => s.reason)).toEqual(['PROOF_ATTEMPT_1', 'PROOF_ATTEMPT_2']);
    expect(submissions[1]!.oldValue).toBe('REJECTED');
  });

  it('a duplicate dispatch produces no second history row, notification or audit event', async () => {
    const booking = await createDraftBooking({ branchId: null, bookingCode: 'E2EIDEMP01' });

    const first = await adminAgent
      .post(`/api/admin/bookings/${booking.id}/send`)
      .send({ branchId });
    expect(first.status).toBe(200);

    const second = await adminAgent
      .post(`/api/admin/bookings/${booking.id}/send`)
      .send({ branchId });
    expect(second.status).toBe(409);

    expect(
      await testPrisma.bookingStatusHistory.count({ where: { bookingId: booking.id, newStatus: 'NEW' } }),
    ).toBe(1);
    expect(await testPrisma.notification.count({ where: { bookingId: booking.id } })).toBe(1);
  });
});

describe('proof submission concurrency', () => {
  it('two simultaneous first submissions: exactly one wins, with a clear conflict for the loser', async () => {
    const booking = await createDraftBooking({
      status: 'NEW',
      branchId,
      bookingCode: 'E2ECONC001',
      verificationStatus: 'NOT_SUBMITTED',
      // CUT is a hard prerequisite for submitting proof.
      claimedByUserId: receptionistId,
    });

    // Both requests start before either commits. Previously both counted zero
    // proofs, both computed attemptNumber = 1, and the loser hit the unique
    // index — surfacing as a meaningless "Dữ liệu đã tồn tại".
    const [a, b] = await Promise.all([
      receptionAgent
        .post(`/api/bookings/${booking.id}/proofs`)
        .attach('image', pngBuffer(), { filename: 'a.png', contentType: 'image/png' }),
      receptionAgent
        .post(`/api/bookings/${booking.id}/proofs`)
        .attach('image', pngBuffer(), { filename: 'b.png', contentType: 'image/png' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('CONFLICT');
    // A real operational message in Vietnamese — never a leaked constraint,
    // column name or Prisma error code. Which of the two guards answered
    // (the pre-check or the transactional claim) depends on how the two
    // requests interleave, so the wording is not pinned; the absence of
    // internals is what matters and is asserted exactly.
    expect(loser.body.error.message).toMatch(/^Đơn /);
    const serialized = JSON.stringify(loser.body);
    expect(serialized).not.toContain('attemptNumber');
    expect(serialized).not.toContain('Unique constraint');
    expect(serialized).not.toContain('P2002');
    expect(serialized).not.toContain('bookingId_attemptNumber');

    // State is intact: exactly one attempt, one audit event, one admin notice.
    const proofs = await testPrisma.bookingCreationProof.findMany({ where: { bookingId: booking.id } });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.attemptNumber).toBe(1);

    expect(
      await testPrisma.bookingAuditEvent.count({
        where: { bookingId: booking.id, action: 'BOOKING_PROOF_SUBMITTED' },
      }),
    ).toBe(1);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.verificationStatus).toBe('PENDING_REVIEW');
  });

  it('the transactional claim itself refuses a second submitter that passed the pre-check', async () => {
    // Called at the SERVICE boundary so both callers get past the friendly
    // pre-check before either transaction opens — which is exactly the window
    // the old count-outside-the-transaction code corrupted. Only the claim can
    // decide the winner here.
    const booking = await createDraftBooking({
      status: 'NEW',
      branchId,
      bookingCode: 'E2ECLAIM01',
      verificationStatus: 'NOT_SUBMITTED',
      // CUT is a hard prerequisite for submitting proof.
      claimedByUserId: receptionistId,
    });

    const actor = {
      id: receptionistId,
      role: 'RECEPTIONIST' as const,
      branchId,
      fullName: 'Lễ tân',
      correlationId: 'test-correlation',
    };
    const file = () => ({ buffer: pngBuffer(), originalName: 'p.png', size: pngBuffer().length });

    const results = await Promise.allSettled([
      submitProof(booking.id, file(), undefined, actor),
      submitProof(booking.id, file(), undefined, actor),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).not.toContain('attemptNumber');

    // The unique constraint was never the thing that stopped it, and state is
    // intact: one attempt, one audit event, no double notification.
    const proofs = await testPrisma.bookingCreationProof.findMany({ where: { bookingId: booking.id } });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.attemptNumber).toBe(1);
    expect(
      await testPrisma.bookingAuditEvent.count({
        where: { bookingId: booking.id, action: 'BOOKING_PROOF_SUBMITTED' },
      }),
    ).toBe(1);
    expect(
      await testPrisma.notification.count({ where: { bookingId: booking.id, userId: adminId } }),
    ).toBe(1);

    // The audit event carries the correlation id it was given.
    const event = await testPrisma.bookingAuditEvent.findFirstOrThrow({
      where: { bookingId: booking.id, action: 'BOOKING_PROOF_SUBMITTED' },
    });
    expect(event.correlationId).toBe('test-correlation');
  });
});
