/**
 * "Cần tạo lại" and "Chờ kiểm tra" — one queue, told apart by branch.
 *
 * WHAT MUST HOLD: an Admin looking at several hotels sees each hotel's orders
 * under its own header (address · number · how many), in branch order rather
 * than arrival order, and a branch that did not exist when this was written is
 * grouped like any other. A receptionist has one branch, so headers would only
 * repeat the page and are not drawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function branch(id: number, number: number, address: string) {
  return { id, code: `B${id}`, hotelName: `KAS ${number}`, address, branchNumber: number };
}
const B1 = branch(1, 1, '05 Trương Định');
const B2 = branch(2, 2, '260 Lý Tự Trọng');
// A branch nobody has hard-coded anywhere.
const B9 = branch(9, 9, '99 Đường Mới');

function order(id: string, code: string, b: ReturnType<typeof branch>, over: Record<string, unknown> = {}) {
  return {
    id,
    bookingCode: code,
    customerName: `Khách ${code}`,
    phone: null,
    branch: b,
    sourcePlatform: 'BOOKING_COM',
    businessType: 'NORMAL',
    verificationStatus: 'REJECTED',
    checkInDate: '2026-09-20T00:00:00.000Z',
    checkOutDate: '2026-09-21T00:00:00.000Z',
    numberOfRooms: 1,
    roomSummary: '1 phòng',
    totalAmount: null,
    currency: 'VND',
    paymentStatus: 'UNPAID',
    isLastMinute: false,
    sentAt: '2026-09-10T00:00:00.000Z',
    sentBy: null,
    status: 'NEW',
    missingNightlyPriceCount: 0,
    warningCount: 0,
    latestAttemptNumber: 1,
    latestRejectionReason: 'WRONG_CUSTOMER_NAME',
    submittedAt: '2026-09-10T03:00:00.000Z',
    reviewedAt: '2026-09-10T04:00:00.000Z',
    ...over,
  };
}

// Arrival order deliberately not branch order.
const ORDERS = [order('a', 'A-1', B9), order('b', 'B-1', B2), order('c', 'C-1', B1), order('d', 'D-1', B2)];

function mount(user: unknown, orders = ORDERS, path: 'rejected' | 'pending-review' = 'rejected') {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [B1, B2, B9] } }),
    'GET /api/admin/reports/recreations': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } }),
    [`GET /api/bookings/${path}?pageSize=100`]: () => ({
      status: 200,
      body: { bookings: orders, pagination: { page: 1, pageSize: 100, total: orders.length, totalPages: 1 }, serverNow: new Date().toISOString() },
    }),
  });
}

describe('the verification queues, by branch', () => {
  it('groups an Admin’s queue under one header per branch, in branch order', async () => {
    mount(ADMIN_USER);
    renderApp('/app/rejected');

    expect(await screen.findByTestId('verification-total')).toHaveTextContent('4 đơn · 3 chi nhánh');
    const groups = screen.getAllByTestId(/^branch-group-/).map((g) => g.getAttribute('data-testid'));
    // 01, 02, then the branch nobody hard-coded — not the order they arrived in.
    expect(groups).toEqual(['branch-group-1', 'branch-group-2', 'branch-group-9']);

    const second = screen.getByTestId('branch-group-2');
    expect(within(second).getByText('260 Lý Tự Trọng')).toBeInTheDocument();
    expect(within(second).getByText('Chi nhánh 02')).toBeInTheDocument();
    expect(within(second).getByText('B-1')).toBeInTheDocument();
    expect(within(second).getByText('D-1')).toBeInTheDocument();
    expect(within(second).queryByText('A-1')).not.toBeInTheDocument();
    // The header carries how many are waiting there.
    expect(within(second).getByText('2', { selector: 'span.tabular-nums' })).toBeInTheDocument();
  });

  it('groups a branch created later exactly like the others', async () => {
    mount(ADMIN_USER);
    renderApp('/app/rejected');
    const created = await screen.findByTestId('branch-group-9');
    expect(within(created).getByText('99 Đường Mới')).toBeInTheDocument();
    expect(within(created).getByText('Chi nhánh 09')).toBeInTheDocument();
  });

  it('groups the “Chờ kiểm tra” queue the same way', async () => {
    mount(ADMIN_USER, ORDERS.map((o) => ({ ...o, verificationStatus: 'PENDING_REVIEW' })), 'pending-review');
    renderApp('/app/pending-review');
    expect(await screen.findByTestId('verification-total')).toHaveTextContent('4 đơn · 3 chi nhánh');
    expect(screen.getAllByTestId(/^branch-group-/)).toHaveLength(3);
  });

  it('draws no headers for a receptionist, whose queue is one branch', async () => {
    mount(RECEPTIONIST_USER, [order('c', 'C-1', B1), order('e', 'E-1', B1)]);
    renderApp('/app/rejected');

    expect(await screen.findByTestId('verification-total')).toHaveTextContent('2 đơn');
    expect(screen.getByTestId('verification-total')).not.toHaveTextContent('chi nhánh');
    expect(screen.queryByText('Chi nhánh 01')).not.toBeInTheDocument();
  });

  it('shows the branch on each row instead when an Admin has filtered to one', async () => {
    mount(ADMIN_USER, [order('c', 'C-1', B1)]);
    renderApp('/app/rejected');

    const group = await screen.findByTestId('branch-group-1');
    expect(screen.queryByText('Chi nhánh 01')).not.toBeInTheDocument();
    expect(within(group).getByText('05 Trương Định')).toBeInTheDocument();
  });

  it('lists every branch in the filter, built from the branch table', async () => {
    mount(ADMIN_USER);
    renderApp('/app/rejected');
    const filter = await screen.findByLabelText('Lọc theo chi nhánh');
    await waitFor(() =>
      expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Tất cả chi nhánh',
        '05 Trương Định - Chi nhánh 01',
        '260 Lý Tự Trọng - Chi nhánh 02',
        '99 Đường Mới - Chi nhánh 09',
      ]),
    );
  });
});
