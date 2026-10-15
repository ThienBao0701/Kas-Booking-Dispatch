/**
 * "Cần tạo lại" accountability, from the Admin's side.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The panel is on the "Cần tạo lại" screen, for the Admin only — it answers
 *      "who keeps having to redo these?" while looking at the queue itself.
 *   2. It attributes each re-creation to a branch, a shift and a receptionist,
 *      and totals them by each.
 *   3. It narrows by period, shift and source, and those narrowings reach the
 *      SERVER rather than filtering a list already in the browser.
 *   4. The PDF export carries the same filters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion Boutique Hotel', address: '05 Trương Định' };

function row(over: Record<string, unknown> = {}) {
  return {
    proofId: 'p1',
    bookingId: 'b1',
    attemptNumber: 1,
    bookingCode: 'REP-1',
    customerName: 'Nguyễn Thị Khách',
    source: 'BOOKING_COM',
    branch: BRANCH,
    bookingCreatedAt: '2026-09-10T02:00:00.000Z',
    checkInDate: '2026-09-20T00:00:00.000Z',
    submittedAt: '2026-09-10T03:00:00.000Z',
    receptionistName: 'Nguyễn Văn A',
    shiftType: 'A4',
    shiftLabel: 'Ca A4',
    shiftSessionId: 's1',
    shiftStartedAt: '2026-09-10T00:00:00.000Z',
    reviewedAt: '2026-09-10T04:00:00.000Z',
    reviewedBy: { id: 1, fullName: 'Quản trị viên' },
    reasonCode: 'WRONG_CUSTOMER_NAME',
    reviewNote: 'Sai tên khách',
    currentStatus: 'NEW',
    currentVerificationStatus: 'REJECTED',
    withdrawn: false,
    ...over,
  };
}

const REPORT = {
  range: { from: '2026-08-19', to: '2026-09-17' },
  rows: [row(), row({ proofId: 'p2', bookingCode: 'REP-2', receptionistName: 'Trần Thị B', shiftType: 'C', shiftLabel: 'Ca C' })],
  totals: {
    total: 2,
    byBranch: { 'TRUONG_DINH_05 — 05 Trương Định': 2 },
    byShift: { 'Ca A4': 1, 'Ca C': 1 },
    byReceptionist: { 'Nguyễn Văn A': 1, 'Trần Thị B': 1 },
  },
};

/**
 * The mock matches the FULL url, and the report's query string carries the
 * chosen period. A prefix match is used so the test does not have to restate
 * today's date, which the panel derives from the real clock.
 */
function installRejectedMocks(user: unknown, onReport?: (url: string) => void) {
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const u = String(url);
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (u === '/api/auth/me') return json(200, { user });
    if (u === '/api/notifications/unread-count') return json(200, { count: 0 });
    if (u === '/api/issues/summary')
      return json(200, { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } });
    if (u === '/api/nav-badges')
      return json(200, { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } });
    if (u === '/api/reception/shifts/current') return json(200, { session: null });
    if (u === '/api/reception/shifts/options') return json(200, { shifts: [] });
    if (u === '/api/branches') return json(200, { branches: [BRANCH] });
    if (u.startsWith('/api/bookings/rejected'))
      return json(200, { bookings: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, serverNow: new Date().toISOString() });
    if (u.startsWith('/api/admin/reports/recreations')) {
      onReport?.(u);
      return json(200, REPORT);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no mock for ${method} ${u}` } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the accountability panel', () => {
  it('is offered to the Admin on "Cần tạo lại"', async () => {
    installRejectedMocks(ADMIN_USER);
    renderApp('/app/rejected');

    expect(await screen.findByText('Thống kê đơn cần tạo lại')).toBeInTheDocument();
  });

  /**
   * A receptionist works this queue too, but the accountability view is about
   * THEM — it is the Admin's oversight, not a self-service screen.
   */
  it('is not offered to a receptionist', async () => {
    installRejectedMocks(RECEPTIONIST_USER);
    renderApp('/app/rejected');

    // The nav item and the topbar both carry this page's name, so the wait is on
    // the empty state the queue itself renders.
    await screen.findByText('Không có đơn nào cần tạo lại.');
    expect(screen.queryByText('Thống kê đơn cần tạo lại')).not.toBeInTheDocument();
  });

  it('is collapsed until asked for — the queue is the daily work', async () => {
    installRejectedMocks(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/rejected');

    const toggle = await screen.findByTestId('recreation-toggle');
    expect(toggle).toHaveTextContent('Xem thống kê');
    expect(screen.queryByTestId('recreation-total')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(await screen.findByTestId('recreation-total')).toHaveTextContent('2');
  });

  it('attributes each re-creation to a branch, a shift and a receptionist', async () => {
    installRejectedMocks(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/rejected');

    await user.click(await screen.findByTestId('recreation-toggle'));

    // The order list — the breakdowns beside it are small tables of their own.
    const table = await screen.findByTestId('recreation-rows');
    expect(within(table).getByText('REP-1')).toBeInTheDocument();
    expect(within(table).getByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(within(table).getByText('Ca A4')).toBeInTheDocument();
    expect(within(table).getByText('REP-2')).toBeInTheDocument();
    expect(within(table).getByText('Trần Thị B')).toBeInTheDocument();
  });

  it('totals by branch, by shift and by receptionist', async () => {
    installRejectedMocks(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/rejected');

    await user.click(await screen.findByTestId('recreation-toggle'));
    await screen.findByTestId('recreation-total');

    // Each grouping is its own card; the labels come straight from the server.
    expect(screen.getByText('Theo chi nhánh')).toBeInTheDocument();
    expect(screen.getByText('Theo ca làm việc')).toBeInTheDocument();
    expect(screen.getByText('Theo lễ tân')).toBeInTheDocument();
    expect(screen.getByText('TRUONG_DINH_05 — 05 Trương Định')).toBeInTheDocument();
  });

  /**
   * THE NARROWING REACHES THE SERVER.
   *
   * Filtering a list already in the browser would only ever narrow the page that
   * happened to be loaded; an end-of-month review across eight properties has to
   * be a query.
   */
  it('sends the chosen shift and source to the server', async () => {
    const seen: string[] = [];
    installRejectedMocks(ADMIN_USER, (u) => seen.push(u));
    const user = userEvent.setup();
    renderApp('/app/rejected');

    await user.click(await screen.findByTestId('recreation-toggle'));
    await screen.findByTestId('recreation-total');

    await user.selectOptions(screen.getByLabelText('Ca làm việc'), 'C4');
    await waitFor(() => expect(seen.some((u) => u.includes('shiftType=C4'))).toBe(true));

    await user.selectOptions(screen.getByLabelText('Nguồn'), 'AGODA');
    await waitFor(() => expect(seen.some((u) => u.includes('source=AGODA'))).toBe(true));

    // The period is always part of the query, not a client-side slice.
    expect(seen.every((u) => u.includes('from=') && u.includes('to='))).toBe(true);
  });

  it('exports a PDF carrying the same filters', async () => {
    installRejectedMocks(ADMIN_USER);
    const open = vi.fn();
    vi.stubGlobal('open', open);

    const user = userEvent.setup();
    renderApp('/app/rejected');

    await user.click(await screen.findByTestId('recreation-toggle'));
    await screen.findByTestId('recreation-total');
    await user.selectOptions(screen.getByLabelText('Ca làm việc'), 'A');
    await user.click(screen.getByTestId('recreation-export'));

    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/reports/recreations.pdf');
    expect(url).toContain('shiftType=A');
    expect(url).toContain('from=');
    expect(url).toContain('to=');
  });
});
