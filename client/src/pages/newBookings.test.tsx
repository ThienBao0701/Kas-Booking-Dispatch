import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_OPERATIONAL_BLOCKS, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'x',
    bookingCode: '1000000001',
    customerName: 'Khách',
    phone: '0900000000',
    branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel & Ben Thanh', address: '05 Trương Định' },
    checkInDate: '2026-08-01',
    checkOutDate: '2026-08-02',
    numberOfRooms: 1,
    totalAmount: 850_000,
    currency: 'VND',
    paymentStatus: 'PAY_AFTER',
    isLastMinute: false,
    sentAt: '2026-07-30T02:00:00.000Z',
    sentBy: { id: 1, fullName: 'Admin' },
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    missingNightlyPriceCount: 0,
    warningCount: 0,
    latestAttemptNumber: 0,
    latestRejectionReason: null,
    submittedAt: null,
    reviewedAt: null,
    ...overrides,
  };
}

function detail(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    hotelName: 'Saigon Hotel & Ben Thanh',
    branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel & Ben Thanh', address: '05 Trương Định' },
    branchId: 1,
    customerName: 'Khách',
    phone: '0900000000',
    bookingCode: id.toUpperCase(),
    checkInDate: '2026-08-01',
    checkOutDate: '2026-08-02',
    checkInTime: null,
    checkOutTime: null,
    totalAmount: 850_000,
    currency: 'VND',
    paymentStatus: 'PAY_AFTER',
    specialRequest: null,
    parserVersion: '4a',
    isLastMinute: false,
    rooms: [
      {
        id: `${id}-r1`,
        roomIndex: 1,
        roomType: 'Deluxe Double Room',
        roomSubtotal: 850_000,
        taxAmount: null,
        feeAmount: null,
        nights: [{ id: `${id}-n1`, stayDate: '2026-08-01', amount: 850_000, currency: 'VND', manuallyCorrected: false, isEstimated: false }],
      },
    ],
    warnings: [],
    ...EMPTY_OPERATIONAL_BLOCKS,
    proofs: [],
    createdBy: null,
    sentBy: { id: 1, fullName: 'Admin' },
    completedBy: null,
    reviewedBy: null,
    createdAt: '2026-07-30T02:00:00.000Z',
    updatedAt: '2026-07-30T02:00:00.000Z',
    sentAt: '2026-07-30T02:00:00.000Z',
    completedAt: null,
    completionNote: null,
    reviewedAt: null,
    ...overrides,
  };
}

/**
 * Chooses a PNG file in the inline upload card, names the creator (required)
 * and submits it for review.
 */
/** The receptionist is checked in, so the shift picker never interrupts. */
const OPEN_SHIFT = {
  status: 200,
  body: {
    session: {
      id: 's1',
      branchId: 1,
      shiftType: 'A',
      shiftName: 'Ca A',
      shiftWindow: '06:00 – 14:00',
      receptionistName: 'Lễ tân Một',
      startedAt: '2026-09-16T23:00:00.000Z',
      nominalEndAt: '2026-09-17T07:00:00.000Z',
      graceEndAt: '2026-09-17T07:10:00.000Z',
      closedAt: null,
      promptDue: false,
    },
  },
};

async function uploadAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
  // No creator name is typed: the server takes it from the open shift.
  await user.click(screen.getByRole('button', { name: 'Gửi Admin kiểm tra' }));
}

describe('NewBookingsPage — receptionist master-detail inbox', () => {
  it('lists dispatched bookings and gives the last-minute one visual priority', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => ({
        status: 200,
        body: {
          bookings: [
            listRow({ id: 'lm', bookingCode: 'LASTMIN001', customerName: 'Khách LastMinute', isLastMinute: true, checkInDate: '2026-07-30' }),
            listRow({ id: 'later', bookingCode: 'NORMAL0001', customerName: 'Khách Thường' }),
          ],
          pagination: { page: 1, pageSize: 100, total: 2, totalPages: 1 },
        },
      }),
      'GET /api/bookings/lm': () => ({ status: 200, body: { booking: detail('lm', { isLastMinute: true, bookingCode: 'LASTMIN001' }) } }),
    });

    renderApp('/app/new');

    const list = await screen.findByRole('list', { name: 'Danh sách đơn mới' });
    expect(within(list).getByText('Khách LastMinute')).toBeInTheDocument();
    expect(within(list).getByText('Khách Thường')).toBeInTheDocument();
    // The last-minute row carries the priority badge and a red accent border.
    expect(within(list).getByText(/Last minute/i)).toBeInTheDocument();
    const lmRow = within(list).getByText('Khách LastMinute').closest('button')!;
    expect(lmRow.className).toContain('border-l-red-500');
    // Auto-updates note is present.
    expect(screen.getByText(/Dữ liệu tự động cập nhật mỗi 20 giây/)).toBeInTheDocument();
  });

  it('renders all bookings vertically in the left list', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      listRow({ id: `bk${i}`, bookingCode: `CODE${i}` }),
    );
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => ({
        status: 200,
        body: { bookings: rows, pagination: { page: 1, pageSize: 100, total: 10, totalPages: 1 } },
      }),
      'GET /api/bookings/bk0': () => ({ status: 200, body: { booking: detail('bk0', { bookingCode: 'CODE0' }) } }),
    });

    renderApp('/app/new');

    const list = await screen.findByRole('list', { name: 'Danh sách đơn mới' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });

  it('advances to the next booking after the selected one is sent for review', async () => {
    let submitted = false;
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => ({
        status: 200,
        body: {
          bookings: submitted
            ? [listRow({ id: 'b', bookingCode: 'BBB', customerName: 'Khách BBB' })]
            : [listRow({ id: 'a', bookingCode: 'AAA', customerName: 'Khách AAA' }), listRow({ id: 'b', bookingCode: 'BBB', customerName: 'Khách BBB' })],
          pagination: { page: 1, pageSize: 100, total: submitted ? 1 : 2, totalPages: 1 },
        },
      }),
      'GET /api/bookings/a': () => ({ status: 200, body: { booking: detail('a', { bookingCode: 'AAA' }) } }),
      'GET /api/bookings/b': () => ({ status: 200, body: { booking: detail('b', { bookingCode: 'BBB' }) } }),
      'POST /api/bookings/a/proofs': () => {
        submitted = true;
        return { status: 201, body: { booking: detail('a', { verificationStatus: 'PENDING_REVIEW' }) } };
      },
    });

    const user = userEvent.setup();
    renderApp('/app/new');

    // Booking 'a' is auto-selected; upload a proof and send it for review.
    await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    await uploadAndSubmit(user);

    // 'a' is gone from the list and 'b' has become the selection.
    const list = await screen.findByRole('list', { name: 'Danh sách đơn mới' });
    await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.');
    expect(within(list).queryByText('Khách AAA')).not.toBeInTheDocument();
    const selected = within(list).getByText('Khách BBB').closest('button')!;
    expect(selected.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the selected booking after a manual refresh', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => ({
        status: 200,
        body: {
          bookings: [listRow({ id: 'a', bookingCode: 'AAA', customerName: 'Khách AAA' }), listRow({ id: 'b', bookingCode: 'BBB', customerName: 'Khách BBB' })],
          pagination: { page: 1, pageSize: 100, total: 2, totalPages: 1 },
        },
      }),
      'GET /api/bookings/a': () => ({ status: 200, body: { booking: detail('a', { bookingCode: 'AAA' }) } }),
      'GET /api/bookings/b': () => ({ status: 200, body: { booking: detail('b', { bookingCode: 'BBB' }) } }),
    });

    const user = userEvent.setup();
    renderApp('/app/new');

    const list = await screen.findByRole('list', { name: 'Danh sách đơn mới' });
    // Select the second booking.
    await user.click(within(list).getByText('Khách BBB'));
    // Its detail (heading with booking code) is shown.
    expect(await screen.findByRole('heading', { name: 'Khách' })).toBeInTheDocument();
    const selectedBefore = within(list).getByText('Khách BBB').closest('button')!;
    expect(selectedBefore.getAttribute('aria-current')).toBe('true');

    // Refresh; the selection must survive.
    await user.click(screen.getByRole('button', { name: 'Làm mới danh sách' }));
    const selectedAfter = (await within(list).findByText('Khách BBB')).closest('button')!;
    expect(selectedAfter.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the existing data and warns when a refresh fails', async () => {
    let calls = 0;
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            body: {
              bookings: [listRow({ id: 'a', bookingCode: 'AAA', customerName: 'Khách AAA' })],
              pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
            },
          };
        }
        return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } };
      },
      'GET /api/bookings/a': () => ({ status: 200, body: { booking: detail('a', { bookingCode: 'AAA' }) } }),
    });

    const user = userEvent.setup();
    renderApp('/app/new');

    const list = await screen.findByRole('list', { name: 'Danh sách đơn mới' });
    expect(within(list).getByText('Khách AAA')).toBeInTheDocument();

    // Force a failing refresh.
    await user.click(screen.getByRole('button', { name: 'Làm mới danh sách' }));

    // The warning appears but the last good data is still on screen.
    expect(
      await screen.findByText('Không thể kết nối đến máy chủ. Dữ liệu đang hiển thị có thể chưa được cập nhật.'),
    ).toBeInTheDocument();
    expect(within(list).getByText('Khách AAA')).toBeInTheDocument();
  });

  it('removes a booking from Đơn mới after its proof is sent for review', async () => {
    let submitted = false;
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/new?pageSize=100': () => ({
        status: 200,
        body: {
          bookings: submitted ? [] : [listRow({ id: 'b1', bookingCode: 'B1CODE' })],
          pagination: { page: 1, pageSize: 100, total: submitted ? 0 : 1, totalPages: 1 },
        },
      }),
      'GET /api/bookings/b1': () => ({
        status: 200,
        body: { booking: detail('b1', { bookingCode: 'B1CODE', verificationStatus: submitted ? 'PENDING_REVIEW' : 'NOT_SUBMITTED' }) },
      }),
      'POST /api/bookings/b1/proofs': () => {
        submitted = true;
        return { status: 201, body: { booking: detail('b1', { verificationStatus: 'PENDING_REVIEW' }) } };
      },
    });

    const user = userEvent.setup();
    renderApp('/app/new');

    // Auto-selected booking b1 detail is shown; upload a proof and send it.
    await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    await uploadAndSubmit(user);

    // After the list refetch, the empty state replaces the removed booking.
    expect(await screen.findByText('Chưa có đơn mới')).toBeInTheDocument();
  });
});
