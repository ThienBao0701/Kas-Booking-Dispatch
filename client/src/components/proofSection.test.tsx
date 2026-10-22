/**
 * Mismatch approval must never be silent.
 *
 * The proof-vs-booking comparison is ADVISORY by design: the server never
 * approves or rejects on its behalf, and it never blocks an Admin who has a
 * good reason to approve anyway. That design is only safe if the Admin is told,
 * in Vietnamese, that the engine found a difference — and has to say so a second
 * time before the approval request is sent.
 *
 * These tests pin exactly that: the extra confirmation exists, cancelling sends
 * NO request at all, and confirming sends the approval EXACTLY ONCE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, EMPTY_OPERATIONAL_BLOCKS, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PROOF = {
  id: 'p1',
  attemptNumber: 1,
  status: 'PENDING_REVIEW',
  originalFileName: 'proof.png',
  mimeType: 'image/png',
  fileSize: 2048,
  submissionNote: null,
  submittedBy: { id: 2, fullName: 'Lễ tân Một' },
  submittedAt: '2026-07-16T02:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  reviewReasonCode: null,
  reviewNote: null,
  imageUrl: '/api/bookings/b1/proofs/p1/image',
};

const BOOKING = {
  id: 'b1',
  status: 'NEW',
  hotelName: 'Saigon Hotel & Ben Thanh',
  branch: {
    id: 1,
    code: 'TRUONG_DINH_05',
    hotelName: 'Saigon Hotel & Ben Thanh',
    address: '05 Trương Định',
    breakfastIncluded: false,
  },
  branchId: 1,
  customerName: 'Nguyễn Văn A',
  phone: '0901234567',
  bookingCode: '489234523',
  checkInDate: '2026-07-19',
  checkOutDate: '2026-07-21',
  checkInTime: null,
  checkOutTime: null,
  totalAmount: 1_700_000,
  currency: 'VND',
  paymentStatus: 'PAY_AFTER',
  specialRequest: null,
  parserVersion: '4a.2.0',
  isLastMinute: false,
  rooms: [
    {
      id: 'r1',
      roomIndex: 1,
      roomType: 'Deluxe Double Room',
      roomSubtotal: 1_700_000,
      taxAmount: null,
      feeAmount: null,
      nights: [
        { id: 'n1', stayDate: '2026-07-19', amount: 850_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
        { id: 'n2', stayDate: '2026-07-20', amount: 850_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
      ],
    },
  ],
  warnings: [],
  ...EMPTY_OPERATIONAL_BLOCKS,
  proofs: [PROOF],
  sourcePlatform: 'BOOKING_COM',
  verificationStatus: 'PENDING_REVIEW',
  createdBy: null,
  sentBy: { id: 1, fullName: 'Quản trị viên' },
  completedBy: { id: 2, fullName: 'Lễ tân Một' },
  reviewedBy: null,
  createdAt: '2026-07-15T02:00:00.000Z',
  updatedAt: '2026-07-15T02:00:00.000Z',
  sentAt: '2026-07-15T02:00:00.000Z',
  completedAt: '2026-07-16T02:00:00.000Z',
  completionNote: null,
  reviewedAt: null,
};

function comparison(overallStatus: 'MATCH' | 'MISMATCH') {
  return {
    id: 'c1',
    bookingId: 'b1',
    proofId: 'p1',
    analysisId: 'a1',
    overallStatus,
    comparisonVersion: 'proof-compare-v1',
    result: {
      overall: overallStatus,
      version: 'proof-compare-v1',
      summary: {
        matchCount: overallStatus === 'MATCH' ? 6 : 4,
        mismatchCount: overallStatus === 'MISMATCH' ? 1 : 0,
        warningCount: 0,
        notFoundCount: 0,
      },
      fields: [
        {
          field: 'totalAmount',
          label: 'Tổng tiền',
          importance: 'CRITICAL',
          result: overallStatus === 'MISMATCH' ? 'MISMATCH' : 'MATCH',
          expected: '1.700.000 ₫',
          detected: overallStatus === 'MISMATCH' ? '1.500.000 ₫' : '1.700.000 ₫',
          message: overallStatus === 'MISMATCH' ? 'Tổng tiền không khớp.' : 'Khớp.',
        },
      ],
    },
    errorMessage: null,
    createdAt: '2026-07-16T02:05:00.000Z',
  };
}

/** Mounts the Admin review screen with a given comparison verdict. */
function mockReview(overallStatus: 'MATCH' | 'MISMATCH') {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/bookings/b1': () => ({ status: 200, body: { booking: BOOKING } }),
    'GET /api/admin/bookings/b1/proofs/p1/analyses/latest': () => ({
      status: 200,
      body: { analysis: null },
    }),
    'GET /api/admin/bookings/b1/proofs/p1/comparisons/latest': () => ({
      status: 200,
      body: { comparison: comparison(overallStatus) },
    }),
    'POST /api/bookings/b1/proofs/p1/approve': () => ({
      status: 200,
      body: { booking: { ...BOOKING, status: 'COMPLETED', verificationStatus: 'APPROVED' } },
    }),
  });
}

const approveCalls = (fetchMock: ReturnType<typeof installApiMock>): number =>
  fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith('/proofs/p1/approve') &&
      ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST',
  ).length;

describe('ProofSection — approving a MISMATCH requires explicit confirmation', () => {
  it('opens a Vietnamese confirmation instead of approving straight away', async () => {
    const fetchMock = mockReview('MISMATCH');
    renderApp('/app/booking/b1');

    const approve = await screen.findByRole('button', { name: /Đúng — xác nhận/ });
    // Wait for the advisory verdict to arrive before clicking, otherwise the
    // component has not yet learned it is a mismatch.
    expect(await screen.findByText('CÓ SAI KHÁC')).toBeInTheDocument();

    await userEvent.click(approve);

    // A dialog appeared…
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Xác nhận dù có sai khác')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Hệ thống phát hiện thông tin không khớp. Bạn vẫn muốn xác nhận đúng?'),
    ).toBeInTheDocument();

    // …and NOTHING was approved.
    expect(approveCalls(fetchMock)).toBe(0);
  });

  it('cancelling the confirmation sends no approval request at all', async () => {
    const fetchMock = mockReview('MISMATCH');
    renderApp('/app/booking/b1');

    expect(await screen.findByText('CÓ SAI KHÁC')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Đúng — xác nhận/ }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xem lại' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(approveCalls(fetchMock)).toBe(0);
  });

  it('confirming sends the approval exactly once', async () => {
    const fetchMock = mockReview('MISMATCH');
    renderApp('/app/booking/b1');

    expect(await screen.findByText('CÓ SAI KHÁC')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Đúng — xác nhận/ }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Vẫn xác nhận đúng' }));

    await waitFor(() => expect(approveCalls(fetchMock)).toBe(1));
    // No duplicate fired after the mutation settled.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(approveCalls(fetchMock)).toBe(1);
  });

  it('a MATCH approves directly, with no extra confirmation step', async () => {
    const fetchMock = mockReview('MATCH');
    renderApp('/app/booking/b1');

    expect(await screen.findByText('KHỚP')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Đúng — xác nhận/ }));

    await waitFor(() => expect(approveCalls(fetchMock)).toBe(1));
    expect(screen.queryByText('Xác nhận dù có sai khác')).not.toBeInTheDocument();
  });
});
