import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TEST_RECEPTIONIST: AuthUser = {
  ...RECEPTIONIST_USER,
  username: 'reception_test',
  fullName: 'Lễ tân Test 8 Chi Nhánh',
};

const BRANCHES = [
  { id: 1, code: 'TRUONG_DINH_05', hotelName: 'H1', address: '05 Trương Định' },
  { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'H2', address: '260 Lý Tự Trọng' },
];

function statusBody(over: Record<string, unknown> = {}) {
  return { status: 200, body: { enabled: true, testUsername: 'reception_test', isTestReceptionist: false, activeTestBranchId: null, ...over } };
}

describe('DevToolsBar — visibility', () => {
  it('is hidden when the server dev tools are disabled (status 404)', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
      'GET /api/admin/dashboard/summary': () => ({ status: 200, body: { totals: { waiting: 0, confirmedToday: 0, lastMinute: 0, sentToday: 0 }, branches: [] } }),
      // No /api/dev-test/status mock → 404 → treated as disabled.
    });
    renderApp('/app/dashboard');
    await screen.findAllByText('Tổng quan'); // topbar + page heading
    expect(screen.queryByText('CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT')).not.toBeInTheDocument();
  });

  it('shows the warning banner when enabled', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
      'GET /api/admin/dashboard/summary': () => ({ status: 200, body: { totals: { waiting: 0, confirmedToday: 0, lastMinute: 0, sentToday: 0 }, branches: [] } }),
      'GET /api/dev-test/status': () => statusBody(),
    });
    renderApp('/app/dashboard');
    expect(await screen.findByText('CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT')).toBeInTheDocument();
    // An admin (not the test receptionist) does not get the branch switcher.
    expect(screen.queryByLabelText('Chi nhánh đang test')).not.toBeInTheDocument();
  });

  it('shows the branch switcher only for reception_test', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: TEST_RECEPTIONIST } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
      'GET /api/bookings/new?pageSize=20&page=1': () => ({ status: 200, body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } }),
      'GET /api/dev-test/status': () => statusBody({ isTestReceptionist: true, activeTestBranchId: 1 }),
      'GET /api/branches': () => ({ status: 200, body: { branches: BRANCHES } }),
    });
    renderApp('/app/new');
    expect(await screen.findByText('CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT')).toBeInTheDocument();
    const switcher = await screen.findByLabelText('Chi nhánh đang test');
    expect(switcher).toBeInTheDocument();
    expect(screen.getByText('Đây là tài khoản test. Dữ liệu hiển thị theo chi nhánh đang chọn.')).toBeInTheDocument();
  });

  it('switching branch posts the new active branch', async () => {
    let switched = false;
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: TEST_RECEPTIONIST } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
      'GET /api/bookings/new?pageSize=20&page=1': () => ({ status: 200, body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } }),
      'GET /api/dev-test/status': () => statusBody({ isTestReceptionist: true, activeTestBranchId: 1 }),
      'GET /api/branches': () => ({ status: 200, body: { branches: BRANCHES } }),
      'POST /api/dev-test/active-branch': () => {
        switched = true;
        return { status: 200, body: { activeTestBranchId: 2, branch: BRANCHES[1] } };
      },
    });
    const user = userEvent.setup();
    renderApp('/app/new');
    await screen.findByText('CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT');
    const switcher = await screen.findByLabelText('Chi nhánh đang test');
    await user.selectOptions(switcher, '2');
    expect(switched).toBe(true);
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/dev-test/active-branch' && (i as RequestInit).method === 'POST')).toBe(true);
  });
});

describe('DevToolsPanel — admin settings', () => {
  function installSettings(status: 'on' | 'off') {
    return installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
      'GET /api/admin/users?includeAdmins=true': () => ({ status: 200, body: { users: [] } }),
      'GET /api/branches': () => ({ status: 200, body: { branches: BRANCHES } }),
      ...(status === 'on' ? { 'GET /api/dev-test/status': () => statusBody() } : {}),
    });
  }

  it('is hidden when dev tools are disabled', async () => {
    installSettings('off');
    renderApp('/app/settings');
    await screen.findAllByRole('heading', { name: 'Quản lý tài khoản' }); // topbar + page heading
    expect(screen.queryByText('Công cụ dữ liệu test')).not.toBeInTheDocument();
  });

  it('shows the panel and requires the typed phrase to enable clearing', async () => {
    installSettings('on');
    const user = userEvent.setup();
    renderApp('/app/settings');
    expect(await screen.findByText('Công cụ dữ liệu test')).toBeInTheDocument();

    // Two-step clear: danger button → warning → typed-phrase confirm.
    await user.click(screen.getByRole('button', { name: /Xóa toàn bộ dữ liệu demo/ }));
    await user.click(await screen.findByRole('button', { name: 'Tôi hiểu, tiếp tục' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Xóa vĩnh viễn' });
    expect(confirmBtn).toBeDisabled();
    await user.type(screen.getByLabelText('Cụm từ xác nhận xóa'), 'XOA DU LIEU DEMO');
    expect(confirmBtn).toBeEnabled();
  });
});
