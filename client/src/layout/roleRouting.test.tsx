import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EMPTY_NEW = {
  status: 200,
  body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } },
};

function mockShell(user: unknown, extra: Record<string, () => { status: number; body?: unknown }> = {}) {
  installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    // Admin waiting list (paged) and receptionist inbox (large page) both hit /bookings/new.
    'GET /api/bookings/new?page=1&pageSize=20': () => EMPTY_NEW,
    'GET /api/bookings/new?pageSize=100': () => EMPTY_NEW,
    'GET /api/branches': () => ({ status: 200, body: { branches: [] } }),
    ...extra,
  });
}

describe('role-based shell and routing', () => {
  it('shows the full admin menu (14 items)', async () => {
    mockShell(ADMIN_USER);
    renderApp('/app/new');

    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    const labels = within(nav).getAllByRole('link').map((l) => l.textContent);
    expect(labels).toEqual([
      'Tổng quan',
      'Nhập đơn',
      'Chờ chi nhánh tạo',
      'Chờ kiểm tra',
      'Cần tạo lại',
      'Đã xác nhận đúng',
      'Lịch sử',
      'Báo cáo vấn đề',
      'Gửi lại đơn',
      'Chứng từ',
      'Chat box',
      'Nhắc nhở',
      'Khách sạn & chi nhánh',
      'Quản lý tài khoản',
    ]);
    /*
      "Sự cố khách sạn" is the "Sự cố vật chất đang xử lý" category of "Báo cáo
      vấn đề" now, and "Bàn giao ca" is gone from the menu. Both addresses
      still resolve — see "the retired addresses" below.
    */
    expect(within(nav).queryByRole('link', { name: 'Sự cố khách sạn' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Bàn giao ca' })).not.toBeInTheDocument();
  });

  it('shows only the four receptionist items', async () => {
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/new');

    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    const labels = within(nav).getAllByRole('link').map((l) => l.textContent);
    expect(labels).toEqual(['Đơn mới', 'Báo cáo vấn đề', 'Chat box', 'Nhắc nhở']);
    /*
      Removed from the MENU only. Their routes, records and APIs are untouched;
      "Báo cáo sự cố" is a category inside "Báo cáo vấn đề".
    */
    for (const gone of [
      'Chờ Admin kiểm tra',
      'Cần tạo lại',
      'Đã xác nhận đúng',
      'Lịch sử',
      'Bàn giao ca',
      'Báo cáo sự cố',
    ]) {
      expect(within(nav).queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
    expect(within(nav).queryByRole('link', { name: 'Quản lý tài khoản' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Nhập đơn' })).not.toBeInTheDocument();
  });

  it('blocks a receptionist from an admin route directly', async () => {
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/settings');

    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
  });

  it('shows the receptionist their assigned branch', async () => {
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/new');

    expect((await screen.findAllByText(/Saigon Hotel & Ben Thanh/)).length).toBeGreaterThan(0);
  });

  it('renders a professional empty state with no fabricated booking data', async () => {
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/new');

    expect(await screen.findByText('Chưa có đơn mới')).toBeInTheDocument();
    // No fake bookings: nothing tabular is rendered when the list is empty.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('row')).not.toBeInTheDocument();
  });
});

/**
 * THE RETIRED ADDRESSES STILL RESOLVE.
 *
 * Removing a menu entry must not strand a bookmark or delete a record: the old
 * incident and handover addresses redirect into "Báo cáo vấn đề", and the
 * booking lists that left reception's menu are still served by their routes.
 */
describe('the retired addresses', () => {
  it('sends the Admin from the old "Sự cố khách sạn" to the incident category, every branch', async () => {
    mockShell(ADMIN_USER, {
      'GET /api/admin/branches': () => ({
        status: 200,
        body: { branches: [{ id: 1, code: 'B1', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1, active: true }] },
      }),
    });
    renderApp('/app/issues');

    expect(await screen.findByTestId('admin-incident-view')).toBeInTheDocument();
    expect(await screen.findByTestId('branch-select')).toHaveValue('ALL');
    expect(screen.getByTestId('admin-category-FACILITY_ISSUE')).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the Admin from the old "Bàn giao ca" to "Báo cáo vấn đề"', async () => {
    mockShell(ADMIN_USER);
    renderApp('/app/handover');

    expect(await screen.findByText('Chọn một chi nhánh')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Báo cáo vấn đề' }).length).toBeGreaterThan(0);
  });

  it.each([
    ['/app/completed', 'Đã xác nhận đúng'],
    ['/app/history', 'Lịch sử'],
  ])('still serves %s to a receptionist who has the address', async (path, heading) => {
    mockShell(RECEPTIONIST_USER);
    renderApp(path);

    expect((await screen.findAllByRole('heading', { name: heading })).length).toBeGreaterThan(0);
    expect(screen.queryByText('Không có quyền truy cập')).not.toBeInTheDocument();
  });
});
