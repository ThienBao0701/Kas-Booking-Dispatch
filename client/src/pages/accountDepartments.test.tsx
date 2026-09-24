/**
 * "QUẢN LÝ TÀI KHOẢN" — one compact table per department.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Accounts are grouped by the system's own roles, in a fixed order — Lễ
 *      tân, Kỹ thuật, Bộ phận đặt phòng, Admin / Quản trị — each section headed
 *      with its count.
 *   2. Every account appears exactly once, in its own department's section.
 *   3. Lễ tân, Kỹ thuật and Admin always have a section, saying so when
 *      empty; any other department appears only once it has accounts.
 *   4. Locking and unlocking still work, through the same endpoints as before.
 *   5. Admin accounts are listed read-only — nothing here can lock one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS A', address: '05 Trương Định', branchNumber: 1 };

function user(id: number, role: string, over: Record<string, unknown> = {}) {
  return {
    id,
    username: `u${id}`,
    fullName: `Người ${id}`,
    role,
    branch: role === 'RECEPTIONIST' ? BRANCH : null,
    active: true,
    mustChangePassword: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: null,
    ...over,
  };
}

const USERS = [
  user(1, 'ADMIN'),
  user(2, 'RECEPTIONIST'),
  user(3, 'TECHNICAL'),
  user(4, 'RECEPTIONIST', { active: false }),
  user(5, 'RECEPTIONIST', { lastLoginAt: '2026-09-20T02:00:00.000Z' }),
  user(6, 'BOOKING_DEPARTMENT'),
];

function mount(extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {}, users = USERS) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/admin/users?includeAdmins=true': () => ({ status: 200, body: { users } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/dev-test/status': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } }),
    ...extra,
  });
}

const SECTIONS = ['RECEPTIONIST', 'TECHNICAL', 'BOOKING_DEPARTMENT', 'ADMIN'] as const;

describe('accounts, by department', () => {
  it('shows one section per department, in order, each with its title and count', async () => {
    mount();
    renderApp('/app/settings');

    const sections = await Promise.all(SECTIONS.map((r) => screen.findByTestId(`department-${r}`)));
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i - 1]!.compareDocumentPosition(sections[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(sections[0]).toHaveTextContent('Lễ tân');
    expect(sections[1]).toHaveTextContent('Kỹ thuật');
    expect(sections[2]).toHaveTextContent('Bộ phận đặt phòng');
    expect(sections[3]).toHaveTextContent('Admin / Quản trị');

    // Three receptionists, one technician, one booking account, one admin.
    // (Rows, not their `row-toggle-` expanders.)
    const rows = (el: HTMLElement) => within(el).getAllByTestId(/^row-\d+$/);
    expect(rows(sections[0]!)).toHaveLength(3);
    expect(rows(sections[1]!)).toHaveLength(1);
    expect(rows(sections[2]!)).toHaveLength(1);
    expect(rows(sections[3]!)).toHaveLength(1);
    expect(within(sections[0]!).getByRole('heading')).toHaveTextContent('3');
  });

  it('puts every account in its own department and nowhere else', async () => {
    mount();
    renderApp('/app/settings');

    const reception = await screen.findByTestId('department-RECEPTIONIST');
    const technical = screen.getByTestId('department-TECHNICAL');
    const admin = screen.getByTestId('department-ADMIN');

    expect(within(technical).getByText('Người 3')).toBeInTheDocument();
    expect(within(reception).queryByText('Người 3')).not.toBeInTheDocument();
    expect(within(admin).getByText('Người 1')).toBeInTheDocument();
    expect(within(reception).queryByText('Người 1')).not.toBeInTheDocument();
    // Every account exactly once on the page.
    for (const u of USERS) expect(screen.getAllByText(u.fullName)).toHaveLength(1);
  });

  it('keeps Lễ tân, Kỹ thuật and Admin visible when empty, and says so', async () => {
    mount({}, []);
    renderApp('/app/settings');

    for (const [role, text] of [
      ['RECEPTIONIST', 'Chưa có tài khoản lễ tân'],
      ['TECHNICAL', 'Chưa có tài khoản kỹ thuật'],
      ['ADMIN', 'Chưa có tài khoản admin / quản trị'],
    ] as const) {
      const section = await screen.findByTestId(`department-${role}`);
      expect(within(section).getByTestId(`department-${role}-empty`)).toHaveTextContent(text);
    }
  });

  it('shows any other department only once it has accounts', async () => {
    mount({}, USERS.filter((u) => u.role !== 'BOOKING_DEPARTMENT'));
    renderApp('/app/settings');

    await screen.findByTestId('department-RECEPTIONIST');
    expect(screen.queryByTestId('department-BOOKING_DEPARTMENT')).not.toBeInTheDocument();
  });

  it('asks the server for the admin accounts too', async () => {
    const fetchMock = mount();
    renderApp('/app/settings');

    await screen.findByTestId('department-ADMIN');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/admin/users?includeAdmins=true')).toBe(true);
  });

  it('shows the branch a receptionist belongs to, and a global account as every branch', async () => {
    mount();
    renderApp('/app/settings');

    const reception = await screen.findByTestId('department-RECEPTIONIST');
    expect(within(within(reception).getByTestId('row-2')).getByText('05 Trương Định')).toBeInTheDocument();
    const technical = screen.getByTestId('department-TECHNICAL');
    expect(within(within(technical).getByTestId('row-3')).getByText('Tất cả chi nhánh')).toBeInTheDocument();
  });

  it('shows the compact columns, with status and last sign-in', async () => {
    mount();
    renderApp('/app/settings');

    const reception = await screen.findByTestId('department-RECEPTIONIST');
    const headers = within(reception).getAllByRole('columnheader').map((h) => h.textContent);
    for (const h of ['Tài khoản', 'Họ tên', 'Chi nhánh', 'Trạng thái', 'Đăng nhập gần nhất']) {
      expect(headers).toContain(h);
    }
    expect(within(within(reception).getByTestId('row-4')).getByText('Đã khoá')).toBeInTheDocument();
    expect(within(within(reception).getByTestId('row-2')).getByText('Hoạt động')).toBeInTheDocument();
    expect(within(within(reception).getByTestId('row-2')).getByText('Chưa đăng nhập')).toBeInTheDocument();
  });
});

describe('locking and unlocking, from every section', () => {
  it('locks an active account through the existing endpoint', async () => {
    const posted: string[] = [];
    mount({
      'POST /api/admin/users/3/disable': () => {
        posted.push('disable-3');
        return { status: 200, body: { user: user(3, 'TECHNICAL', { active: false }) } };
      },
    });
    renderApp('/app/settings');

    const technical = await screen.findByTestId('department-TECHNICAL');
    await userEvent.click(within(within(technical).getByTestId('row-3')).getByRole('button', { name: 'Khoá' }));
    await waitFor(() => expect(posted).toEqual(['disable-3']));
  });

  it('unlocks a locked account through the existing endpoint', async () => {
    const posted: string[] = [];
    mount({
      'POST /api/admin/users/4/enable': () => {
        posted.push('enable-4');
        return { status: 200, body: { user: user(4, 'RECEPTIONIST') } };
      },
    });
    renderApp('/app/settings');

    const reception = await screen.findByTestId('department-RECEPTIONIST');
    await userEvent.click(within(within(reception).getByTestId('row-4')).getByRole('button', { name: 'Mở khoá' }));
    await waitFor(() => expect(posted).toEqual(['enable-4']));
  });

  it('lists an admin read-only, with no lock control', async () => {
    mount();
    renderApp('/app/settings');

    const admin = await screen.findByTestId('department-ADMIN');
    const row = within(admin).getByTestId('row-1');
    expect(within(row).getByText('Người 1')).toBeInTheDocument();
    expect(within(row).getByText('Chỉ xem')).toBeInTheDocument();
    expect(within(admin).queryByRole('button', { name: /Khoá|Mở khoá/ })).not.toBeInTheDocument();
  });

  it('still creates accounts from the same dialog', async () => {
    mount();
    renderApp('/app/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));
    expect(await screen.findByRole('dialog', { name: 'Thêm tài khoản' })).toBeInTheDocument();
  });
});
