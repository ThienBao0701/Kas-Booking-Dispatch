/**
 * "BÁO CÁO VẤN ĐỀ", COUNTED BY CATEGORY — each record under one entry of the
 * menu, the number beside the entry it belongs to, never one total repeated.
 * The counts are the server's (scoped there); this checks where they go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, HOUSEKEEPING_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const OPEN = { counts: { guestRequest: { reception: 2, housekeeping: 3 }, complaint: 1 } };
const SUMMARY = { totalUnresolved: 5, byDepartment: { reception: 4, housekeeping: 1 }, newCount: 5, inProgressCount: 0, awaitingInspectionCount: 0, byBranch: [] };

function shell(user: unknown, extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({ status: 200, body: { summary: SUMMARY } }),
    'GET /api/nav-badges': () => ({ status: 200, body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } } }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/reception/reports/open-counts': () => ({ status: 200, body: OPEN }),
    ...extra,
  });
}
const count = (href: string) => screen.queryByTestId(`nav-count-${href}`);

describe('the Admin’s menu', () => {
  it('splits each category by the department that recorded it — Reception’s under Lễ tân, Housekeeping’s under Buồng phòng — each group the sum of its own, nothing twice', async () => {
    shell(ADMIN_USER);
    renderApp('/app/settings');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    // 2 + 4 + 1 under Lễ tân, 3 + 1 under Buồng phòng.
    expect(await within(nav).findByTestId('nav-total-Báo cáo vấn đề')).toHaveTextContent('11');
    expect(within(nav).queryByTestId('nav-badge-reports')).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByTestId('nav-group-Báo cáo vấn đề'));
    expect(within(nav).getByTestId('nav-total-Lễ tân')).toHaveTextContent('7');
    expect(within(nav).getByTestId('nav-total-Buồng phòng')).toHaveTextContent('4');
    await userEvent.click(within(nav).getByTestId('nav-group-Lễ tân'));
    expect(count('/app/reports?category=GUEST_REQUEST')).toHaveTextContent('2');
    expect(count('/app/reports?category=FACILITY_ISSUE')).toHaveTextContent('4');
    expect(count('/app/reports?category=CUSTOMER_COMPLAINT')).toHaveTextContent('1');
    // Categories with nothing open — or no such status at all — carry no number.
    for (const href of ['/app/reports?category=PAYMENT', '/app/reports?category=ROOM_SERVICE', '/app/reports?category=HOTEL_DELIVERY', '/app/reports']) {
      expect(count(href)).not.toBeInTheDocument();
    }
    await userEvent.click(within(nav).getByTestId('nav-group-Buồng phòng'));
    expect(count('/app/hk/reports?category=GUEST_REQUEST')).toHaveTextContent('3');
    expect(count('/app/hk/reports?category=FACILITY_ISSUE')).toHaveTextContent('1');
    // Every record once: 2 + 3 requests, 4 + 1 incidents.
    expect(within(nav).getAllByTestId(/^nav-count-/).map((b) => Number(b.textContent))).toEqual([2, 4, 1, 3, 1]);
  });
});

describe('the reception managers’ menu', () => {
  it('counts both departments’ requests and every unresolved incident under Lễ tân — its pages list both', async () => {
    shell({ id: 3, username: 'qllt', fullName: 'Quản lý lễ tân', role: 'RECEPTION_MANAGER', branch: null, active: true, mustChangePassword: false, managedBranchIds: [1] });
    renderApp('/app/hk-work-orders');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByTestId('nav-group-Báo cáo vấn đề'));
    await userEvent.click(within(nav).getByTestId('nav-group-Lễ tân'));
    expect(count('/app/reports?category=GUEST_REQUEST')).toHaveTextContent('5');
    expect(count('/app/reports?category=FACILITY_ISSUE')).toHaveTextContent('5');
    expect(count('/app/reports?category=CUSTOMER_COMPLAINT')).toHaveTextContent('1');
  });
});

describe('Bộ phận buồng phòng', () => {
  it('shows the Quản lý buồng phòng its own requests and its branch’s incidents', async () => {
    shell({ id: 9, username: 'qlbp', fullName: 'Quản lý Buồng', role: 'HOUSEKEEPING_MANAGER', branch: BRANCH, active: true, mustChangePassword: false });
    renderApp('/app/hk/store/linens');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByTestId('nav-group-Báo cáo vấn đề'));
    // Its own requests and the desk's routed to Buồng phòng — its page lists both.
    expect(count('/app/hk/reports?category=GUEST_REQUEST')).toHaveTextContent('5');
    expect(count('/app/hk/reports?category=FACILITY_ISSUE')).toHaveTextContent('5');
    expect(count('/app/hk/reports?category=HOTEL_DELIVERY')).not.toBeInTheDocument();
  });

  it('shows a housekeeper its own open requests — and no incident count it has no summary for', async () => {
    const fetchMock = shell(HOUSEKEEPING_USER, { 'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }) });
    renderApp('/app/hk/reports');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByTestId('nav-count-/app/hk/reports?category=GUEST_REQUEST')).toHaveTextContent('5');
    expect(count('/app/hk/reports?category=FACILITY_ISSUE')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/issues/summary')).toBe(false);
  });
});

describe('the desk', () => {
  it('counts everything still open behind its one "Báo cáo vấn đề" link — requests, service quality and incidents, each once', async () => {
    shell(RECEPTIONIST_USER);
    renderApp('/app/reminders');
    // 2 + 3 requests, 1 complaint, 5 incidents.
    const badge = await screen.findByLabelText('11 mục chưa xử lý, trong đó 5 sự cố');
    expect(badge).toHaveTextContent('11');
    expect(badge.closest('a')).toHaveAttribute('href', '/app/reports');
  });

});

describe('Bell', () => {
  it('counts the requests given to it and not yet completed — on its own work link, and nothing of the desk', async () => {
    const fetchMock = shell(
      { id: 21, username: 'bell1', fullName: 'Bell Một', role: 'BELL', branch: BRANCH, active: true, mustChangePassword: false },
      {
        'GET /api/reception/reports/open-counts': () => ({ status: 200, body: { counts: { guestRequest: { reception: 0, housekeeping: 0, mine: 2 }, complaint: 0 } } }),
        'GET /api/reception/reports/assigned': () => ({ status: 200, body: { reports: [], archiveAfterHours: 12 } }),
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
      },
    );
    renderApp('/app/bell');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([expect.stringContaining('Công việc Bell')]);
    expect(await within(nav).findByLabelText('Công việc Bell: 2 mục cần xử lý')).toBeInTheDocument();
    // No incident summary, no booking counts' screens, no chat.
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/issues/summary')).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/chat'))).toBe(false);
  });
});
