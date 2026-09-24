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
  đề"; the counts came with it, shown while every branch is on screen.
*/
describe('Issue counters — admin per-branch counts in the incident category', () => {
  const TODAY = hcmToday();
  const BRANCHES = BY_BRANCH.map((b, i) => ({
    id: b.branchId,
    code: b.code,
    hotelName: b.hotelName,
    address: b.address,
    branchNumber: i + 1,
    active: true,
  }));

  function installAdminIssues() {
    return installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: ADMIN_SUMMARY } }),
      'GET /api/admin/branches': () => ({ status: 200, body: { branches: BRANCHES } }),
      [`GET /api/issues?from=${TODAY}&to=${TODAY}&pageSize=100`]: () => listBody([issue({ id: 'all' })]),
      [`GET /api/issues?branchId=1&from=${TODAY}&to=${TODAY}&pageSize=100`]: () =>
        listBody([issue({ id: 'b1', description: 'Chỉ chi nhánh 1' })]),
    });
  }

  it('renders all eight branches, a branch with three shows 3 and a zero branch shows 0', async () => {
    installAdminIssues();
    // The old address, which now lands here.
    renderApp('/app/issues');
    const b1 = await screen.findByLabelText(/3 sự cố chưa xử lý tại 05 Trương Định/);
    expect(within(b1).getByText('3')).toBeInTheDocument();
    expect(within(b1).getByText('Mới: 2 · Đang sửa: 1')).toBeInTheDocument();
    // A zero-count branch is still shown.
    const zero = await screen.findByLabelText(/0 sự cố chưa xử lý tại 191 Lê Thánh Tôn/);
    expect(within(zero).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByTestId('branch-incident-counts')).getAllByRole('button')).toHaveLength(8);
  });

  it('choosing a branch narrows the page to it, and "Tất cả chi nhánh" widens it again', async () => {
    installAdminIssues();
    const user = userEvent.setup();
    renderApp('/app/issues');

    await user.click(await screen.findByLabelText(/3 sự cố chưa xử lý tại 05 Trương Định/));
    // The page's one branch filter now says so, and the list follows it.
    expect(await screen.findByText('Chỉ chi nhánh 1')).toBeInTheDocument();
    expect(screen.getByTestId('branch-select')).toHaveValue('1');
    // One branch on screen: its own count strip is not repeated.
    expect(screen.queryByTestId('branch-incident-counts')).not.toBeInTheDocument();

    // Changing branch returns the page to "Tất cả" — the existing behaviour of
    // the branch filter — so the incident category is chosen again.
    await user.selectOptions(screen.getByTestId('branch-select'), 'ALL');
    await user.click(await screen.findByTestId('admin-category-FACILITY_ISSUE'));
    expect(await screen.findByTestId('branch-incident-counts')).toBeInTheDocument();
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
