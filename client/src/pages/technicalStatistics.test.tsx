/**
 * Technical's "Thống kê" — read from the incidents that exist, never invented.
 *
 * WHAT MUST HOLD: the page renders exactly the figures the server returned,
 * says so plainly when there is nothing to chart (rather than drawing empty
 * charts that look like data), lists every branch it is given — including the
 * one with no incidents — and asks the server again when the period changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TECHNICAL_USER, installApiMock, renderApp } from '../test/utils';
import type { IncidentStatistics } from '../api/issues';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE: IncidentStatistics = {
  period: { days: 30, from: '2026-09-01', to: '2026-09-30' },
  totals: { total: 0, newCount: 0, inProgressCount: 0, completedCount: 0, needsReworkCount: 0 },
  outstanding: { total: 0, newCount: 0, inProgressCount: 0 },
  byStatus: [
    { status: 'NEW', label: 'Chờ tiếp nhận', count: 0 },
    { status: 'IN_PROGRESS', label: 'Đang sửa', count: 0 },
    { status: 'COMPLETED', label: 'Hoàn thành', count: 0 },
  ],
  byArea: [],
  byCategory: [],
  byBranch: [
    { branchId: 1, branchNumber: 1, address: '05 Trương Định', hotelName: 'KAS', total: 0, open: 0, completed: 0 },
    { branchId: 2, branchNumber: 2, address: '260 Lý Tự Trọng', hotelName: 'KAS 2', total: 0, open: 0, completed: 0 },
  ],
  workload: {
    attempts: 0,
    completedAttempts: 0,
    cannotRepairAttempts: 0,
    openAttempts: 0,
    averageSeconds: null,
    averageLabel: null,
    byTechnician: [],
  },
  trend: [
    { date: '2026-09-29', reported: 0, completed: 0 },
    { date: '2026-09-30', reported: 0, completed: 0 },
  ],
};

const BUSY: IncidentStatistics = {
  ...BASE,
  totals: { total: 5, newCount: 1, inProgressCount: 1, completedCount: 3, needsReworkCount: 1 },
  outstanding: { total: 4, newCount: 2, inProgressCount: 2 },
  byStatus: [
    { status: 'NEW', label: 'Chờ tiếp nhận', count: 1 },
    { status: 'IN_PROGRESS', label: 'Đang sửa', count: 1 },
    { status: 'COMPLETED', label: 'Hoàn thành', count: 3 },
  ],
  byArea: [
    { key: 'GUEST_ROOM', label: 'Phòng khách', count: 4 },
    { key: 'LOBBY', label: 'Sảnh', count: 1 },
  ],
  byCategory: [{ key: 'ELECTRICITY', label: 'Điện', count: 3 }],
  byBranch: [
    { branchId: 1, branchNumber: 1, address: '05 Trương Định', hotelName: 'KAS', total: 5, open: 2, completed: 3 },
    { branchId: 2, branchNumber: 2, address: '260 Lý Tự Trọng', hotelName: 'KAS 2', total: 0, open: 0, completed: 0 },
  ],
  workload: {
    attempts: 6,
    completedAttempts: 3,
    cannotRepairAttempts: 1,
    openAttempts: 2,
    averageSeconds: 2700,
    averageLabel: '45 phút',
    byTechnician: [{ name: 'Kỹ thuật A', attempts: 6, completed: 3, cannotRepair: 1 }],
  },
  trend: [
    { date: '2026-09-29', reported: 2, completed: 1 },
    { date: '2026-09-30', reported: 3, completed: 2 },
  ],
};

function routes(byDays: Record<number, IncidentStatistics>) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: TECHNICAL_USER } }),
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
    ...Object.fromEntries(
      Object.entries(byDays).map(([days, s]) => [
        `GET /api/issues/statistics?days=${days}`,
        () => ({ status: 200, body: { statistics: s } }),
      ]),
    ),
  };
}

describe('Technical — Thống kê', () => {
  it('is in the Technical menu', async () => {
    installApiMock(routes({ 30: BASE }));
    renderApp('/app/technical/statistics');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: 'Thống kê' })).toBeInTheDocument();
  });

  it('says there is no data instead of drawing empty charts', async () => {
    installApiMock(routes({ 30: BASE }));
    renderApp('/app/technical/statistics');
    expect(await screen.findByTestId('stats-empty')).toHaveTextContent('Chưa có sự cố nào được báo trong kỳ');
    expect(screen.getByTestId('stats-by-status-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-by-category-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-by-area-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-workload-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-trend-empty')).toBeInTheDocument();
  });

  it('still lists every branch, including one with no incidents', async () => {
    installApiMock(routes({ 30: BASE }));
    renderApp('/app/technical/statistics');
    const table = await screen.findByTestId('stats-by-branch');
    expect(within(table).getByText('05 Trương Định - Chi nhánh 01')).toBeInTheDocument();
    expect(within(table).getByText('260 Lý Tự Trọng - Chi nhánh 02')).toBeInTheDocument();
  });

  it('renders the server’s figures, and separates “in the period” from “still outstanding”', async () => {
    installApiMock(routes({ 30: BUSY }));
    renderApp('/app/technical/statistics');
    const tiles = await screen.findByTestId('stats-tiles');
    const tile = (label: RegExp) => within(tiles).getByText(label).parentElement!;
    expect(tile(/Sự cố trong kỳ/)).toHaveTextContent('5');
    expect(tile(/Đang tồn đọng/)).toHaveTextContent('4');
    expect(tile(/Đã hoàn thành trong kỳ/)).toHaveTextContent('3');
    expect(tile(/Cần xử lý lại/)).toHaveTextContent('1');
    expect(screen.queryByTestId('stats-empty')).not.toBeInTheDocument();

    const byStatus = screen.getByTestId('stats-by-status');
    expect(within(byStatus).getByText('Đang sửa').closest('li')).toHaveTextContent('1');
    expect(within(byStatus).getByText('Hoàn thành').closest('li')).toHaveTextContent('3');
    expect(within(screen.getByTestId('stats-by-area')).getByText('Phòng khách').closest('li')).toHaveTextContent('4');
    expect(within(screen.getByTestId('stats-by-category')).getByText('Điện').closest('li')).toHaveTextContent('3');

    const workload = screen.getByTestId('stats-workload');
    expect(workload).toHaveTextContent('45 phút');
    expect(within(workload).getByText('Kỹ thuật A').closest('tr')).toHaveTextContent('6');
    expect(screen.getByTestId('stats-trend')).toHaveTextContent('Cao nhất: 3/ngày');

    const branch = within(screen.getByTestId('stats-by-branch'));
    const row = branch.getByText('05 Trương Định - Chi nhánh 01').closest('tr')!;
    expect(row).toHaveTextContent('5');
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('3');
  });

  it('heads a technician’s page with their own work, from the server’s figures', async () => {
    const mine: IncidentStatistics = {
      ...BUSY,
      technician: { id: 4, name: 'Kỹ thuật viên trực', assignedNow: 2, inProgressNow: 1, completed: 7, cannotRepair: 1, reassignedAway: 3, reopened: 4 },
    };
    installApiMock(routes({ 30: mine }));
    renderApp('/app/technical/statistics');
    const block = await screen.findByTestId('stats-mine');
    expect(block).toHaveTextContent('Thống kê của tôi — Kỹ thuật viên trực');
    const figure = (label: string) => within(block).getByText(label).parentElement!;
    expect(figure('Đang được giao')).toHaveTextContent('2');
    expect(figure('Hoàn thành trong kỳ')).toHaveTextContent('7');
    expect(figure('Đã chuyển người khác')).toHaveTextContent('3');
    expect(figure('Báo lại sau hoàn thành')).toHaveTextContent('4');
  });

  it('has no personal block when the figures are not one technician’s', async () => {
    installApiMock(routes({ 30: BUSY }));
    renderApp('/app/technical/statistics');
    await screen.findByTestId('stats-tiles');
    expect(screen.queryByTestId('stats-mine')).not.toBeInTheDocument();
  });

  it('asks the server again when the period changes', async () => {
    const fetchMock = installApiMock(routes({ 30: BASE, 7: BUSY }));
    renderApp('/app/technical/statistics');
    expect(await screen.findByTestId('stats-empty')).toBeInTheDocument();
    expect(screen.getByTestId('stats-period-30')).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByTestId('stats-period-7'));
    await waitFor(() => expect(screen.queryByTestId('stats-empty')).not.toBeInTheDocument());
    expect(screen.getByTestId('stats-period-7')).toHaveAttribute('aria-pressed', 'true');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/issues/statistics?days=7')).toBe(true);
  });

  it('shows the server’s error rather than an empty page', async () => {
    installApiMock({
      ...routes({}),
      'GET /api/issues/statistics?days=30': () => ({
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Không tải được thống kê.' } },
      }),
    });
    renderApp('/app/technical/statistics');
    expect(await screen.findByText(/Không tải được thống kê/)).toBeInTheDocument();
    expect(screen.queryByTestId('stats-body')).not.toBeInTheDocument();
  });
});
