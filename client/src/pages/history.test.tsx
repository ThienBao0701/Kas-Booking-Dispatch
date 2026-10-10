import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EMPTY_HISTORY = {
  status: 200,
  body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } },
};

function mockHistory(user: unknown) {
  installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [{ id: 1, code: 'A', hotelName: 'H', address: '05 Trương Định' }] } }),
    'GET /api/bookings/history?page=1&pageSize=20': () => EMPTY_HISTORY,
  });
}

const HISTORY_ROW = {
  id: 'h1',
  bookingCode: 'HIST000001',
  customerName: 'Nguyễn Văn A',
  phone: '0901234567',
  branch: { id: 1, code: 'A', hotelName: 'H', address: '05 Trương Định' },
  sourcePlatform: 'BOOKING_COM',
  businessType: 'PARTNER',
  status: 'COMPLETED',
  verificationStatus: 'APPROVED',
  paymentStatus: 'PAY_AFTER',
  checkInDate: '2026-07-23',
  checkOutDate: '2026-07-25',
  roomSummary: 'Superior Giường Đôi (2)',
  totalAmount: 4_720_680,
  currency: 'VND',
  isLastMinute: false,
  sentAt: '2026-07-20T02:00:00.000Z',
  sentBy: null,
  completedAt: '2026-07-21T02:00:00.000Z',
  completedBy: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: '2026-07-20T00:00:00.000Z',
};

describe('HistoryPage — room summary and total columns', () => {
  it('shows the Hạng phòng (SL), Giá tổng columns and the partner badge', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/branches': () => ({ status: 200, body: { branches: [{ id: 1, code: 'A', hotelName: 'H', address: '05 Trương Định' }] } }),
      'GET /api/bookings/history?page=1&pageSize=20': () => ({
        status: 200,
        body: { bookings: [HISTORY_ROW], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      }),
    });
    renderApp('/app/history');

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Hạng phòng (SL)')).toBeInTheDocument();
    expect(within(table).getByText('Giá tổng')).toBeInTheDocument();
    // Aggregated room summary + booking-level total + partner badge on the row.
    expect(within(table).getByText('Superior Giường Đôi (2)')).toBeInTheDocument();
    const totalCell = within(table).getByText('4.720.680 ₫');
    expect(totalCell).toBeInTheDocument();
    expect(totalCell.closest('td')?.className).toMatch(/font-bold/); // visually prominent
    expect(within(table).getByText('ĐƠN ĐỐI TÁC')).toBeInTheDocument();
  });

  it('shows "Chưa xác định" when the booking total is null', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/branches': () => ({ status: 200, body: { branches: [{ id: 1, code: 'A', hotelName: 'H', address: '05 Trương Định' }] } }),
      'GET /api/bookings/history?page=1&pageSize=20': () => ({
        status: 200,
        body: { bookings: [{ ...HISTORY_ROW, totalAmount: null }], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } },
      }),
    });
    renderApp('/app/history');

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Chưa xác định')).toBeInTheDocument();
  });
});

describe('HistoryPage — branch filter is admin-only', () => {
  it('gives the receptionist no branch selector in the filters', async () => {
    mockHistory(RECEPTIONIST_USER);
    renderApp('/app/history');

    // Scope to the filter form: the sidebar also shows a "Chi nhánh" panel.
    const form = await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });
    expect(within(form).queryByText('Chi nhánh')).not.toBeInTheDocument();
    // The role-independent filters are still available to the receptionist.
    // (The stay-outcome "Trạng thái" filter was removed from this screen for
    // everyone — role has nothing to do with its absence.)
    expect(within(form).getByText('Thanh toán')).toBeInTheDocument();
  });

  it('gives the admin a branch selector', async () => {
    mockHistory(ADMIN_USER);
    renderApp('/app/history');

    // Wait for the page, then the branch filter label is present.
    const form = await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });
    expect(within(form).getByText('Thanh toán')).toBeInTheDocument();
    expect(within(form).getByText('Chi nhánh')).toBeInTheDocument();
  });
});
