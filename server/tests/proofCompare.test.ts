import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';
import { pngBuffer } from './helpers/images';
import { mockSuccessProvider } from './helpers/ocr';
import { resetOcrProvider, setOcrProvider } from '../src/booking/ocr/provider';

// OCR text that contains every critical field (incl. room quantity) so a matching
// booking yields overall MATCH.
const MATCH_OCR = [
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

afterEach(() => resetOcrProvider());
afterAll(async () => testPrisma.$disconnect());

async function matchingBooking(over: Record<string, unknown> = {}) {
  return createDraftBooking({
    status: 'NEW',
    branchId: ownBranchId,
    bookingCode: '6039118394',
    customerName: 'Nguyễn Văn A',
    checkIn: '2026-07-24',
    checkOut: '2026-07-28',
    roomType: 'Superior Double',
    totalAmount: 4_720_680,
    paymentStatus: 'PAY_AFTER',
    verificationStatus: 'NOT_SUBMITTED',
    // Already claimed: CUT is a hard prerequisite for submitting proof.
    claimedByUserId: ownReceptionistId,
    ...over,
  });
}

/** Submits a proof (OCR runs + auto-compares in test mode). Returns ids. */
async function submit(bookingId: string): Promise<{ proofId: string }> {
  const res = await ownAgent.post(`/api/bookings/${bookingId}/proofs`).attach('image', pngBuffer(), { filename: 'p.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  const proof = await testPrisma.bookingCreationProof.findFirstOrThrow({ where: { bookingId } });
  return { proofId: proof.id };
}

describe('Proof compare — runs automatically after OCR', () => {
  it('a fully matching booking compares to overall MATCH', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);

    const res = await adminAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons/latest`);
    expect(res.status).toBe(200);
    expect(res.body.comparison.overallStatus).toBe('MATCH');
    const codeField = res.body.comparison.result.fields.find((f: { field: string }) => f.field === 'BOOKING_CODE');
    expect(codeField.result).toBe('MATCH');
    expect(codeField.expected).toBe('6039118394');
    expect(codeField.detected).toBe('6039118394');
    // Advisory: no verdict wording anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/auto.?approve|auto.?reject/i);
  });

  it('a wrong total compares to overall MISMATCH', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking({ totalAmount: 9_999_999 });
    const { proofId } = await submit(b.id);

    const res = await adminAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons/latest`);
    expect(res.body.comparison.overallStatus).toBe('MISMATCH');
    const total = res.body.comparison.result.fields.find((f: { field: string }) => f.field === 'TOTAL_AMOUNT');
    expect(total.result).toBe('MISMATCH');
  });

  it('a missing critical field compares to overall WARNING', async () => {
    // OCR without a booking code → BOOKING_CODE NOT_FOUND → overall WARNING.
    setOcrProvider(mockSuccessProvider(['Check-in: 24/07/2026', 'Check-out: 28/07/2026', '1 phòng', 'Total: VND 4.720.680', 'PAY AFTER CHECK-IN', 'Room type: Superior Double'].join('\n')));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const res = await adminAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons/latest`);
    expect(res.body.comparison.overallStatus).toBe('WARNING');
  });
});

describe('Proof compare — immutability & re-analysis', () => {
  it('re-analysis creates a new comparison and preserves the old one', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);

    // A new OCR analysis → a new auto comparison.
    const re = await adminAgent.post(`/api/admin/bookings/${b.id}/proofs/${proofId}/analyze`).send({});
    expect(re.status).toBe(201);

    const list = await adminAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons`);
    expect(list.status).toBe(200);
    expect(list.body.comparisons.length).toBe(2); // original + new, both preserved
  });

  it('POST /compare is refused (409) once a comparison exists for that analysis', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    // The auto comparison already exists for the latest analysis.
    const res = await adminAgent.post(`/api/admin/bookings/${b.id}/proofs/${proofId}/compare`).send({});
    expect(res.status).toBe(409);
  });

  it('POST /compare returns 409 when there is no completed OCR analysis', async () => {
    // Default provider is disabled → analysis is DISABLED, never COMPLETED.
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const res = await adminAgent.post(`/api/admin/bookings/${b.id}/proofs/${proofId}/compare`).send({});
    expect(res.status).toBe(409);
  });
});

describe('Proof compare — authorization', () => {
  it('admin can read comparisons', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const res = await adminAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.comparisons)).toBe(true);
  });

  it('the branch receptionist cannot read comparisons (admin-only)', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const res = await ownAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons`);
    expect(res.status).toBe(403);
  });

  it('another branch receptionist cannot read comparisons', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const res = await otherAgent.get(`/api/admin/bookings/${b.id}/proofs/${proofId}/comparisons/latest`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the proof does not belong to the booking', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);
    const other = await matchingBooking({ bookingCode: '1111111111' });
    const res = await adminAgent.get(`/api/admin/bookings/${other.id}/proofs/${proofId}/comparisons`);
    expect(res.status).toBe(404);
  });
});

describe('Proof compare — never mutates proof or booking', () => {
  it('booking and proof statuses are unchanged by comparison', async () => {
    setOcrProvider(mockSuccessProvider(MATCH_OCR));
    const b = await matchingBooking();
    const { proofId } = await submit(b.id);

    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(booking.status).toBe('NEW');
    expect(booking.verificationStatus).toBe('PENDING_REVIEW');
    const proof = await testPrisma.bookingCreationProof.findUniqueOrThrow({ where: { id: proofId } });
    expect(proof.status).toBe('PENDING_REVIEW');
    // A comparison run exists but changed no status.
    expect(await testPrisma.bookingProofComparison.count({ where: { proofId } })).toBe(1);
  });
});
