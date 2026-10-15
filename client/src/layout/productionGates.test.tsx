import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

/**
 * Production gating, from the browser's point of view.
 *
 * In production `/api/dev-test/*` responds 404 (the router refuses to mount),
 * so `useDevTools` reports "disabled" and every developer surface must vanish.
 * These cases install NO dev-test mock at all, which reproduces exactly that
 * 404 — the frontend never gets to decide for itself whether the tools exist.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SHELL = {
  'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
  'GET /api/issues/summary': () => ({
    status: 200,
    body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
  }),
};

const EMPTY_LIST = {
  status: 200,
  body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } },
};

/** Every developer-only string that must never reach a production screen. */
const DEV_ONLY_TEXT = [
  /CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT/,
  /Công cụ dữ liệu test/,
  /Tạo dữ liệu demo/,
  /Xóa toàn bộ dữ liệu demo/,
  /reception_test/,
  /ReceptionTest1/,
  /XOA DU LIEU DEMO/,
  /PREPARE KAS FOR OFFICIAL USE/,
];

describe('production frontend gates', () => {
  it('8. an Admin sees no dev banner, no demo tools and no reset controls', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      ...SHELL,
      'GET /api/admin/users?includeAdmins=true': () => ({ status: 200, body: { users: [] } }),
      'GET /api/branches': () => ({ status: 200, body: { branches: [] } }),
      // No /api/dev-test/status mock → 404, exactly like production.
    });
    const { container } = renderApp('/app/settings');

    await screen.findAllByRole('heading', { name: 'Quản lý tài khoản' });
    for (const pattern of DEV_ONLY_TEXT) {
      expect(screen.queryByText(pattern), String(pattern)).not.toBeInTheDocument();
    }
    // Nothing anywhere in the rendered tree, not even hidden.
    expect(container.textContent).not.toMatch(/demo/i);
  });

  it('9. a receptionist has no branch switcher and cannot reach branch management', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      ...SHELL,
      'GET /api/bookings/new?pageSize=20&page=1': () => EMPTY_LIST,
      'GET /api/bookings/new?page=1&pageSize=20': () => EMPTY_LIST,
    });
    renderApp('/app/new');

    await screen.findAllByText('Đơn mới');
    // The dev-only branch switcher is absent…
    expect(screen.queryByLabelText('Chi nhánh đang test')).not.toBeInTheDocument();
    for (const pattern of DEV_ONLY_TEXT) {
      expect(screen.queryByText(pattern), String(pattern)).not.toBeInTheDocument();
    }
    // …and so is every Admin-only navigation entry.
    expect(screen.queryByRole('link', { name: 'Khách sạn & chi nhánh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Quản lý tài khoản' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Nhập đơn' })).not.toBeInTheDocument();
  });

  it('9b. a receptionist routed straight at branch management is refused', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      ...SHELL,
      'GET /api/bookings/new?pageSize=20&page=1': () => EMPTY_LIST,
    });
    // Hiding a nav link is not a control: the route itself must refuse.
    renderApp('/app/branches');

    expect((await screen.findAllByText(/không có quyền/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Quản lý khách sạn & chi nhánh' })).not.toBeInTheDocument();
  });
});
