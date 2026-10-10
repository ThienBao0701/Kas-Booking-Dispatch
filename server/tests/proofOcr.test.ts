import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';
import { pngBuffer } from './helpers/images';
import { deferredProvider, mockFailingProvider, mockSuccessProvider, SAMPLE_OCR_TEXT } from './helpers/ocr';
import { GENERIC_OCR_ERROR, startProofAnalysis } from '../src/booking/ocr/analysisService';
import { resetOcrProvider, setOcrProvider } from '../src/booking/ocr/provider';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let otherAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let ownBranchId: number;
let ownReceptionistId: number;
let otherBranchId: number;

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
  /*
    The receptionist checks in to a shift.

    Submitting a proof IS the receptionist asserting "I created this
    reservation", so the server takes the order's creator from the shift they
    are working and refuses the submission when there is none. That rule is the
    subject of bookingCreatorAttribution.test.ts; here it is only the
    precondition these cases need before they can reach OCR at all.
  */
  await ownAgent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Lễ tân trực' });
  await createReceptionist(otherBranchId, { username: 'letan_other', mustChangePassword: false });
  otherAgent = (await loginAgent(app, 'letan_other', RECEPTIONIST_PASSWORD)).agent;
});

afterEach(() => {
  resetOcrProvider();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function newBooking(code = 'OCR0000001') {
  // Already claimed: CUT is a hard prerequisite for submitting proof.
  return createDraftBooking({
    status: 'NEW',
    branchId: ownBranchId,
    bookingCode: code,
    verificationStatus: 'NOT_SUBMITTED',
    claimedByUserId: ownReceptionistId,
  });
}

/** Submits a proof as the branch receptionist and returns { bookingId, proofId }. */
async function submitProof(code = 'OCR0000001'): Promise<{ bookingId: string; proofId: string }> {
  const b = await newBooking(code);
  const res = await ownAgent.post(`/api/bookings/${b.id}/proofs`).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId: b.id } });
  return { bookingId: b.id, proofId: proof.id };
}

describe('Proof OCR — submission is never blocked by OCR', () => {
  it('OCR disabled: submission succeeds and the run is DISABLED', async () => {
    // No override + PROOF_OCR_ENABLED=false (test env) → the Null provider.
    const { proofId } = await submitProof();
    const analysis = await testPrisma.bookingProofAnalysis.findFirstOrThrow({ where: { proofId } });
    expect(analysis.status).toBe('DISABLED');
    expect(analysis.provider).toBe('disabled');
  });

  it('OCR failure: submission still succeeds and the run is FAILED (sanitised)', async () => {
    setOcrProvider(mockFailingProvider());
    const { bookingId, proofId } = await submitProof();

    // The proof attempt itself remains valid.
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.verificationStatus).toBe('PENDING_REVIEW');

    const analysis = await testPrisma.bookingProofAnalysis.findFirstOrThrow({ where: { proofId } });
    expect(analysis.status).toBe('FAILED');
    expect(analysis.errorMessage).toBe(GENERIC_OCR_ERROR);
    // The sanitised message never leaks the provider's internal detail / path.
    expect(analysis.errorMessage).not.toContain('secret');
    expect(analysis.extractedText).toBeNull();
  });
});

describe('Proof OCR — analysis lifecycle', () => {
  it('a run passes through PROCESSING to COMPLETED (an active run is created first)', async () => {
    // Submit first with the default (disabled) provider so the upload is fast,
    // then drive one analysis manually with a provider we hold open.
    const { proofId } = await submitProof();

    const { provider, resolve } = deferredProvider();
    setOcrProvider(provider);
    const run = startProofAnalysis(proofId); // not awaited — held at recognition

    // Poll (instead of a fixed sleep) so the assertion is not timing-sensitive
    // under load: the run is held open at recognition, so an active row must appear.
    let active = null as Awaited<ReturnType<typeof testPrisma.bookingProofAnalysis.findFirst>>;
    for (let i = 0; i < 100 && !active; i++) {
      active = await testPrisma.bookingProofAnalysis.findFirst({
        where: { proofId, status: { in: ['PENDING', 'PROCESSING'] } },
      });
      if (!active) await new Promise((r) => setTimeout(r, 20));
    }
    expect(active).not.toBeNull();
    expect(active!.startedAt).not.toBeNull();

    resolve();
    const terminal = await run;
    expect(terminal.status).toBe('COMPLETED');
  });

  it('COMPLETED stores extracted text + structured fields', async () => {
    setOcrProvider(mockSuccessProvider(SAMPLE_OCR_TEXT));
    const { bookingId, proofId } = await submitProof();

    const res = await adminAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses/latest`);
    expect(res.status).toBe(200);
    const a = res.body.analysis;
    expect(a.status).toBe('COMPLETED');
    expect(a.extractedText).toContain('6039118394');
    expect(a.fields.bookingCode.value).toBe('6039118394');
    expect(a.fields.checkInDate.value).toBe('2026-07-24');
    expect(a.fields.checkOutDate.value).toBe('2026-07-28');
    expect(a.fields.totalAmount.value).toBe(4_720_680);
    expect(a.fields.paymentStatus.value).toBe('PAY_AFTER');
    expect(a.fields.roomTypes[0].value).toContain('Superior Double');
    expect(a.fields.note.value).toContain('Late check-in');
    // Advisory only: no verdict fields anywhere.
    expect(JSON.stringify(a)).not.toMatch(/MATCH|MISMATCH/i);
  });

  it('unknown fields remain null in a COMPLETED run', async () => {
    setOcrProvider(mockSuccessProvider('Just some text, no booking fields at all.'));
    const { bookingId, proofId } = await submitProof();
    const res = await adminAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses/latest`);
    expect(res.body.analysis.status).toBe('COMPLETED');
    expect(res.body.analysis.fields.bookingCode).toBeNull();
    expect(res.body.analysis.fields.totalAmount).toBeNull();
  });

  it('preserves previous analyses when re-analysing (never overwrites)', async () => {
    setOcrProvider(mockSuccessProvider(SAMPLE_OCR_TEXT));
    const { bookingId, proofId } = await submitProof();

    const re = await adminAgent.post(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyze`).send({});
    expect(re.status).toBe(201);

    const list = await adminAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses`);
    expect(list.status).toBe(200);
    expect(list.body.analyses.length).toBe(2); // original + re-run, both kept
  });
});

describe('Proof OCR — authorization', () => {
  it('admin can read analyses', async () => {
    setOcrProvider(mockSuccessProvider(SAMPLE_OCR_TEXT));
    const { bookingId, proofId } = await submitProof();
    const res = await adminAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.analyses)).toBe(true);
  });

  it('the branch receptionist cannot read raw OCR analyses (admin-only)', async () => {
    const { bookingId, proofId } = await submitProof();
    const res = await ownAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses`);
    expect(res.status).toBe(403);
  });

  it('another branch receptionist cannot read the OCR analyses', async () => {
    const { bookingId, proofId } = await submitProof();
    const res = await otherAgent.get(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyses`);
    expect(res.status).toBe(403);
  });

  it('admin can trigger a re-analysis', async () => {
    setOcrProvider(mockSuccessProvider(SAMPLE_OCR_TEXT));
    const { bookingId, proofId } = await submitProof();
    const res = await adminAgent.post(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyze`).send({});
    expect(res.status).toBe(201);
    expect(res.body.analysis.status).toBe('COMPLETED');
  });

  it('blocks a duplicate active analysis (409)', async () => {
    setOcrProvider(mockSuccessProvider(SAMPLE_OCR_TEXT));
    const { bookingId, proofId } = await submitProof();

    // Simulate a run already in flight.
    await testPrisma.bookingProofAnalysis.create({
      data: { proofId, provider: 'mock', analysisVersion: '1', status: 'PROCESSING', startedAt: new Date() },
    });

    const res = await adminAgent.post(`/api/admin/bookings/${bookingId}/proofs/${proofId}/analyze`).send({});
    expect(res.status).toBe(409);
  });
});
