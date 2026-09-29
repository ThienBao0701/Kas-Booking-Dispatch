import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import { hcmToday } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function branch(branchId: number, address: string, newCount = 0, inProgressCount = 0) {
  return { branchId, code: `B${branchId}`, address, hotelName: `Hotel ${branchId}`, newCount, inProgressCount, totalUnresolved: newCount + inProgressCount };
}

// One branch with three unresolved (2 new + 1 in-progress); the rest zero → 8 total.
const BY_BRANCH = [
  branch(1, '05 Trương Định', 2, 1),
  branch(2, '260 Lý Tự Trọng', 0, 0),
  branch(3, '47A Nguyễn Trãi', 0, 0),
  branch(4, '170 Nguyễn Thái Bình'),
  branch(5, '278 Lê Thánh Tôn'),
  branch(6, '40 Bùi Thị Xuân'),
  branch(7, '13 Bùi Thị Xuân'),
  branch(8, '191 Lê Thánh Tôn'),
];

const ADMIN_SUMMARY = { totalUnresolved: 3, newCount: 2, inProgressCount: 1, byBranch: BY_BRANCH };

/*
  The summary shape the server actually sends: `range` accompanies `date` (and
  equals it on a single day), and every `branches[]` row carries a numeric
  `sent`. A fixture missing those describes a response the server cannot
  produce, and the page would render undefined where a count belongs.
*/
const DASHBOARD_SUMMARY = {
  date: '2026-08-11',
  range: { from: '2026-08-11', to: '2026-08-11' },
  totals: { waiting: 0, confirmedToday: 0, lastMinute: 0, sentToday: 0 },
  branches: [],
  issues: { reported: 0, stillOpen: 0 },
};

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    branchId: 1,
    branch: { id: 1, code: 'B1', hotelName: 'Hotel 1', address: '05 Trương Định' },
    roomNumber: null,
    category: 'DOOR',
    description: 'Cửa hỏng',
    photoUrl: null,
    status: 'NEW',
    reportedBy: { id: 2, fullName: 'Lễ tân Một' },
    acceptedBy: null,
    resolvedBy: null,
    createdAt: '2026-07-24T02:00:00.000Z',
    updatedAt: '2026-07-24T02:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

function listBody(issues: unknown[]) {
  return { status: 200, body: { issues, pagination: { page: 1, pageSize: 100, total: issues.length, totalPages: 1 } } };
}

describe('Issue counters — sidebar badge', () => {
  it('shows the unresolved count on the Issues menu item (admin)', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: ADMIN_SUMMARY } }),
      'GET /api/admin/dashboard/summary': () => ({ status: 200, body: DASHBOARD_SUMMARY }),
    });
    renderApp('/app/dashboard');
    // Accessible, not colour-only: the number is exposed via an aria-label.
    expect(await screen.findByLabelText('3 sự cố chưa xử lý')).toHaveTextContent('3');
  });

  it('receptionist sees only their own branch count', async () => {
    // Receptionist summary contains just their branch.
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 2, newCount: 2, inProgressCount: 0, byBranch: [branch(1, '05 Trương Định', 2, 0)] } } }),
      'GET /api/issues?pageSize=100': () => listBody([issue()]),
    });
    renderApp('/app/new');
    const badge = await screen.findByLabelText('2 sự cố chưa xử lý');
    /*
      On "Báo cáo vấn đề" — reception has no standalone "Báo cáo sự cố" entry
      any more, and the count followed incident reporting there rather than
      disappearing with the old menu item.
    */
    expect(badge.closest('a')).toHaveAttribute('href', '/app/reports');
  });
});

describe('Issue counters — dashboard card', () => {
  it('shows the day\'s issue card, linking to Issues', async () => {
    /*
      The dashboard card is now DATE-SCOPED like every other figure on that
      page: issues reported on the selected day, and how many of those are still
      open. It reads them from the dashboard summary rather than the running
      unresolved total, which the sidebar badge below still carries.
    */
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: ADMIN_SUMMARY } }),
      // The dashboard opens on a single day, so the request is still
      // `?date=<today>` — the range form is only used once the two ends differ.
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: {
          ...DASHBOARD_SUMMARY,
          date: today,
          range: { from: today, to: today },
          issues: { reported: 8, stillOpen: 3 },
        },
      }),
    });
    renderApp('/app/dashboard');
    const card = await screen.findByLabelText('Sự cố trong ngày: 8');
    expect(within(card).getByText('8')).toBeInTheDocument();
    expect(within(card).getByText('3 chưa xử lý')).toBeInTheDocument();
    expect(card.closest('a')).toHaveAttribute('href', '/app/reports?category=FACILITY_ISSUE');
  });
});

/*
  The per-branch unresolved counts the old "Sự cố khách sạn" screen opened on.
  That screen became the "Sự cố vật chất đang xử lý" category of "Báo cáo vấn
  đề", and the counts live in the page's ONE branch selector — beside each
  branch, from the same summary the sidebar badge reads. There is no second table
  of counts.
*/
describe('Issue counters — the branch selector carries them', () => {
  const TODAY = hcmToday();
  const BRANCHES = BY_BRANCH.map((b, i) => ({
    id: b.branchId,
    code: b.code,
    hotelName: b.hotelName,
    address: b.address,
    branchNumber: i + 1,
    active: true,
  }));

  function installAdminIssues(branches = BRANCHES, summary = ADMIN_SUMMARY) {
    return installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary } }),
      'GET /api/admin/branches': () => ({ status: 200, body: { branches } }),
      [`GET /api/issues?from=${TODAY}&to=${TODAY}&pageSize=100`]: () => listBody([issue({ id: 'all' })]),
      [`GET /api/issues?branchId=1&from=${TODAY}&to=${TODAY}&pageSize=100`]: () =>
        listBody([issue({ id: 'b1', description: 'Chỉ chi nhánh 1' })]),
    });
  }

  it('lists every branch with its unresolved count — a branch with three shows 3, a quiet one 0', async () => {
    installAdminIssues();
    // The old address, which now lands here.
    renderApp('/app/issues');
    const select = await screen.findByTestId('branch-select');
    await screen.findByRole('option', { name: '05 Trương Định - Chi nhánh 01 (3)' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual([
      '— Chọn chi nhánh —',
      'Tất cả chi nhánh',
      '05 Trương Định - Chi nhánh 01 (3)',
      '260 Lý Tự Trọng - Chi nhánh 02 (0)',
      '47A Nguyễn Trãi - Chi nhánh 03 (0)',
      '170 Nguyễn Thái Bình - Chi nhánh 04 (0)',
      '278 Lê Thánh Tôn - Chi nhánh 05 (0)',
      '40 Bùi Thị Xuân - Chi nhánh 06 (0)',
      '13 Bùi Thị Xuân - Chi nhánh 07 (0)',
      '191 Lê Thánh Tôn - Chi nhánh 08 (0)',
    ]);
  });

  it('has no second table of counts any more', async () => {
    installAdminIssues();
    renderApp('/app/issues');
    await screen.findByTestId('admin-incident-view');
    expect(screen.queryByTestId('branch-incident-counts')).not.toBeInTheDocument();
    expect(screen.queryByText('Sự cố chưa xử lý theo chi nhánh')).not.toBeInTheDocument();
  });

  it('gives a branch added later its own entry, with its count', async () => {
    const ninth = { id: 9, code: 'B9', hotelName: 'Hotel 9', address: '99 Đường Mới', branchNumber: 9, active: true };
    installAdminIssues([...BRANCHES, ninth], {
      ...ADMIN_SUMMARY,
      totalUnresolved: 5,
      byBranch: [...BY_BRANCH, branch(9, '99 Đường Mới', 2, 0)],
    });
    renderApp('/app/issues');
    expect(await screen.findByRole('option', { name: '99 Đường Mới - Chi nhánh 09 (2)' })).toBeInTheDocument();
  });

  it('reads 0 for a branch the summary has no row for, rather than hiding it', async () => {
    const ninth = { id: 9, code: 'B9', hotelName: 'Hotel 9', address: '99 Đường Mới', branchNumber: 9, active: true };
    installAdminIssues([...BRANCHES, ninth]);
    renderApp('/app/issues');
    expect(await screen.findByRole('option', { name: '99 Đường Mới - Chi nhánh 09 (0)' })).toBeInTheDocument();
  });

  it('choosing a branch from the selector narrows the page to it, and "Tất cả chi nhánh" widens it again', async () => {
    installAdminIssues();
    const user = userEvent.setup();
    renderApp('/app/issues');

    await screen.findByRole('option', { name: '05 Trương Định - Chi nhánh 01 (3)' });
    await user.selectOptions(screen.getByTestId('branch-select'), '1');
    // The list follows the selector.
    await user.click(await screen.findByTestId('admin-category-FACILITY_ISSUE'));
    expect(await screen.findByText('Chỉ chi nhánh 1')).toBeInTheDocument();
    expect(screen.getByTestId('branch-select')).toHaveValue('1');

    await user.selectOptions(screen.getByTestId('branch-select'), 'ALL');
    await user.click(await screen.findByTestId('admin-category-FACILITY_ISSUE'));
    expect(await screen.findByTestId('admin-incident-view')).toBeInTheDocument();
    expect(screen.getByTestId('branch-select')).toHaveValue('ALL');
  });
});

describe('Issue counters — come from status, not list length', () => {
  it('the badge reflects unresolved summary even when resolved issues are present', async () => {
    // Summary says 2 unresolved; the list contains 3 rows (one already RESOLVED).
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 2, newCount: 2, inProgressCount: 0, byBranch: [branch(1, '05 Trương Định', 2, 0)] } } }),
      'GET /api/issues?pageSize=100': () =>
        listBody([issue({ id: 'a', status: 'NEW' }), issue({ id: 'b', status: 'NEW' }), issue({ id: 'c', status: 'RESOLVED' })]),
    });
    renderApp('/app/issues');
    // Badge = 2 (unresolved), not 3 (list length).
    expect(await screen.findByLabelText('2 sự cố chưa xử lý')).toBeInTheDocument();
  });
});
