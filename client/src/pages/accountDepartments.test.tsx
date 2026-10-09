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
 *   6. "Mật khẩu ghi đè Admin" is set (typed twice), changed or turned off here,
 *      and never shown — only whether one is set.
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
    'GET /api/admin/override-password': () => ({ status: 200, body: { configured: false, updatedAt: null, setByName: null } }),
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

  it('shows the branch a receptionist belongs to, a global account as every branch, and flags a technician without branches', async () => {
    mount();
    renderApp('/app/settings');

    const reception = await screen.findByTestId('department-RECEPTIONIST');
    expect(within(within(reception).getByTestId('row-2')).getByText('05 Trương Định')).toBeInTheDocument();
    const booking = screen.getByTestId('department-BOOKING_DEPARTMENT');
    expect(within(within(booking).getByTestId('row-6')).getByText('Tất cả chi nhánh')).toBeInTheDocument();
    // A Kỹ thuật viên is given work only at its ticked branches — none yet is flagged, never "every branch".
    const technical = screen.getByTestId('department-TECHNICAL');
    expect(within(within(technical).getByTestId('row-3')).getByTestId('needs-branch-3')).toHaveTextContent('Cần gán chi nhánh');
    expect(within(technical).queryByText('Tất cả chi nhánh')).not.toBeInTheDocument();
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

  it('lists a Buồng phòng account with its one branch — and flags one still without', async () => {
    mount({}, [...USERS, user(7, 'HOUSEKEEPING', { branch: BRANCH }), user(8, 'HOUSEKEEPING')]);
    renderApp('/app/settings');

    const housekeeping = await screen.findByTestId('department-HOUSEKEEPING');
    expect(within(housekeeping).getByTestId('row-7')).toHaveTextContent('05 Trương Định');
    expect(within(within(housekeeping).getByTestId('row-8')).getByTestId('needs-branch-8')).toHaveTextContent('Cần gán chi nhánh');
    // Between Lễ tân and Kỹ thuật, and shown only because it has an account.
    const order = screen.getAllByTestId(/^department-/).map((el) => el.getAttribute('data-testid'));
    expect(order.indexOf('department-HOUSEKEEPING')).toBe(order.indexOf('department-RECEPTIONIST') + 1);
  });

  it('creates a Buồng phòng account only with exactly one ticked branch, sent as its branch', async () => {
    const BRANCH_2 = { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'KAS B', address: '260 Lý Tự Trọng', branchNumber: 2 };
    const posted: Record<string, unknown>[] = [];
    mount({
      'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH_2] } }),
      'POST /api/admin/users': (init) => {
        posted.push(JSON.parse(String(init.body)));
        return { status: 201, body: { user: user(8, 'HOUSEKEEPING', { branch: BRANCH }) } };
      },
    });
    renderApp('/app/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm tài khoản' });
    await userEvent.type(within(dialog).getByLabelText('Tên đăng nhập'), 'buongphong1');
    await userEvent.type(within(dialog).getByLabelText('Họ tên'), 'Buồng phòng Một');
    await userEvent.type(within(dialog).getByLabelText(/Mật khẩu tạm/), 'Matkhau123');
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), 'HOUSEKEEPING');

    // "Chi nhánh": exactly one, required.
    const create = within(dialog).getByRole('button', { name: 'Tạo' });
    expect(within(dialog).getByRole('group', { name: /^Chi nhánh/ })).toBeInTheDocument();
    expect(create).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('manager-branch-2'));
    await userEvent.click(within(dialog).getByTestId('manager-branch-1'));
    expect(within(dialog).getByTestId('manager-branch-2')).not.toBeChecked();
    expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ role: 'HOUSEKEEPING', username: 'buongphong1', branchId: 1 });
    expect(posted[0]!.branchIds).toBeUndefined();
  });

  it('assigns the branch of a Buồng phòng account that has none — on the same account', async () => {
    const put: Record<string, unknown>[] = [];
    mount(
      {
        'PUT /api/admin/users/8': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { user: user(8, 'HOUSEKEEPING', { branch: BRANCH }) } };
        },
      },
      [...USERS, user(8, 'HOUSEKEEPING')],
    );
    renderApp('/app/settings');

    await userEvent.click(await screen.findByTestId('edit-user-8'));
    const dialog = await screen.findByRole('dialog', { name: /Sửa tài khoản/ });
    const save = within(dialog).getByTestId('edit-user-save');
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('manager-branch-1'));
    await userEvent.click(save);

    await waitFor(() => expect(put).toEqual([{ branchId: 1 }]));
  });

  it('creates a Quản lý lễ tân only with at least one ticked branch, and sends the set', async () => {
    const posted: Record<string, unknown>[] = [];
    mount({
      'POST /api/admin/users': (init) => {
        posted.push(JSON.parse(String(init.body)));
        return { status: 201, body: { user: user(9, 'RECEPTION_MANAGER', { managedBranches: [BRANCH] }) } };
      },
    });
    renderApp('/app/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm tài khoản' });
    await userEvent.type(within(dialog).getByLabelText('Tên đăng nhập'), 'quanly1');
    await userEvent.type(within(dialog).getByLabelText('Họ tên'), 'Quản lý Một');
    await userEvent.type(within(dialog).getByLabelText(/Mật khẩu tạm/), 'Matkhau123');
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), 'RECEPTION_MANAGER');

    const create = within(dialog).getByRole('button', { name: 'Tạo' });
    expect(create).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('manager-branch-1'));
    expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ role: 'RECEPTION_MANAGER', branchIds: [1], username: 'quanly1' });
  });

  it('creates a Quản lý buồng phòng with exactly one ticked branch, sent as its branch', async () => {
    const BRANCH_2 = { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'KAS B', address: '260 Lý Tự Trọng', branchNumber: 2 };
    const posted: Record<string, unknown>[] = [];
    mount({
      'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH_2] } }),
      'POST /api/admin/users': (init) => {
        posted.push(JSON.parse(String(init.body)));
        return { status: 201, body: { user: user(9, 'HOUSEKEEPING_MANAGER', { branch: BRANCH_2 }) } };
      },
    });
    renderApp('/app/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm tài khoản' });
    await userEvent.type(within(dialog).getByLabelText('Tên đăng nhập'), 'qlbp1');
    await userEvent.type(within(dialog).getByLabelText('Họ tên'), 'Quản lý Buồng');
    await userEvent.type(within(dialog).getByLabelText(/Mật khẩu tạm/), 'Matkhau123');
    await userEvent.selectOptions(within(dialog).getByLabelText('Vai trò'), 'HOUSEKEEPING_MANAGER');

    const create = within(dialog).getByRole('button', { name: 'Tạo' });
    expect(create).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('manager-branch-1'));
    // Ticking another moves the one choice — never two.
    await userEvent.click(within(dialog).getByTestId('manager-branch-2'));
    expect(within(dialog).getByTestId('manager-branch-1')).not.toBeChecked();
    expect(within(dialog).getByTestId('manager-branch-2')).toBeChecked();
    await userEvent.click(create);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ role: 'HOUSEKEEPING_MANAGER', branchId: 2, username: 'qlbp1' });
    expect(posted[0]!.branchIds).toBeUndefined();
  });

  it('changes a Quản lý lễ tân’s branches on the same account — no new account', async () => {
    const BRANCH_2 = { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'KAS B', address: '260 Lý Tự Trọng', branchNumber: 2 };
    const put: Record<string, unknown>[] = [];
    mount(
      {
        'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH_2] } }),
        'PUT /api/admin/users/7': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { user: user(7, 'RECEPTION_MANAGER', { managedBranches: [BRANCH, BRANCH_2] }) } };
        },
      },
      [...USERS, user(7, 'RECEPTION_MANAGER', { managedBranches: [BRANCH] })],
    );
    renderApp('/app/settings');

    await userEvent.click(await screen.findByTestId('edit-user-7'));
    const dialog = await screen.findByRole('dialog', { name: /Sửa tài khoản/ });
    expect(within(dialog).getByTestId('manager-branch-1')).toBeChecked();
    await userEvent.click(within(dialog).getByTestId('manager-branch-2'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ branchIds: [1, 2] });
  });

  it('edits a Quản lý kỹ thuật’s name and ticked branches with "Sửa"', async () => {
    const put: Record<string, unknown>[] = [];
    mount(
      {
        'PUT /api/admin/users/7': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { user: user(7, 'TECHNICAL_MANAGER', { managedBranches: [BRANCH] }) } };
        },
      },
      [...USERS, user(7, 'TECHNICAL_MANAGER')],
    );
    renderApp('/app/settings');

    await userEvent.click(await screen.findByTestId('edit-user-7'));
    const dialog = await screen.findByRole('dialog', { name: /Sửa tài khoản/ });
    const save = within(dialog).getByTestId('edit-user-save');
    expect(save).toBeDisabled(); // no branch ticked yet
    await userEvent.click(within(dialog).getByTestId('manager-branch-1'));
    await userEvent.clear(within(dialog).getByTestId('edit-user-name'));
    await userEvent.type(within(dialog).getByTestId('edit-user-name'), 'Kỹ thuật trưởng');
    await userEvent.click(save);

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ fullName: 'Kỹ thuật trưởng', branchIds: [1] });
  });

  it('deletes an account only after the username is typed', async () => {
    const deleted: string[] = [];
    mount(
      {
        'DELETE /api/admin/users/7': () => {
          deleted.push('7');
          return { status: 200, body: { deleted: true, id: 7 } };
        },
      },
      [...USERS, user(7, 'TECHNICAL')],
    );
    renderApp('/app/settings');

    await userEvent.click(await screen.findByTestId('delete-user-7'));
    const dialog = await screen.findByRole('dialog', { name: 'Xóa tài khoản' });
    const confirm = within(dialog).getByTestId('delete-user-confirm');
    expect(confirm).toBeDisabled();
    expect(dialog).toHaveTextContent('Lịch sử và các bản ghi đã tạo vẫn được giữ nguyên');
    await userEvent.type(within(dialog).getByTestId('delete-user-typed'), 'u7');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    await waitFor(() => expect(deleted).toEqual(['7']));
  });

  it('still creates accounts from the same dialog', async () => {
    mount();
    renderApp('/app/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));
    expect(await screen.findByRole('dialog', { name: 'Thêm tài khoản' })).toBeInTheDocument();
  });
});

describe('"Đặt lại mật khẩu"', () => {
  it('sets a new temporary password — shown once, with a copy button — and never shows an existing one', async () => {
    const posted: { temporaryPassword: string }[] = [];
    mount(
      {
        'POST /api/admin/users/2/reset-password': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { success: true } };
        },
      },
      [...USERS.slice(0, 4), user(7, 'RECEPTIONIST', { mustChangePassword: true })],
    );
    renderApp('/app/settings');

    // The credential's STATE only — never a password.
    const section = await screen.findByTestId('department-RECEPTIONIST');
    expect(section).toHaveTextContent('Đã đặt mật khẩu');
    expect(section).toHaveTextContent('Mật khẩu tạm — chờ đổi');

    await userEvent.click(within(section).getByTestId('reset-password-2'));
    const input = await screen.findByTestId('reset-password-input');
    // A strong one is generated in the browser to start with: 12 characters, letters and digits.
    const generated = (input as HTMLInputElement).value;
    expect(generated).toMatch(/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{12}$/);
    await userEvent.click(screen.getByTestId('reset-password-generate'));
    expect((input as HTMLInputElement).value).not.toBe(generated);
    // Or typed — refused below the server's rule.
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    expect(screen.getByTestId('reset-password-confirm')).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'Tam2026xyz');
    await userEvent.click(screen.getByTestId('reset-password-confirm'));

    await waitFor(() => expect(posted).toEqual([{ temporaryPassword: 'Tam2026xyz' }]));
    const result = await screen.findByTestId('reset-password-result');
    expect(within(result).getByTestId('reset-password-value')).toHaveTextContent('Tam2026xyz');
    expect(within(result).getByRole('button', { name: 'Sao chép mật khẩu' })).toBeInTheDocument();
    expect(result).toHaveTextContent('Mật khẩu chỉ hiển thị một lần');

    // Closed, it is gone — the screen has no way to show it again.
    await userEvent.click(screen.getByTestId('reset-password-close'));
    await waitFor(() => expect(screen.queryByTestId('reset-password-result')).not.toBeInTheDocument());
    expect(screen.queryByText('Tam2026xyz')).not.toBeInTheDocument();
  });
});

describe('"Mật khẩu ghi đè Admin"', () => {
  const OVERRIDE = 'Ghide2026x';

  it('sets it — typed twice, sent once — and shows only that it is set, never the password', async () => {
    const sent: unknown[] = [];
    let configured = false;
    const status = () => ({
      configured,
      updatedAt: configured ? '2026-10-08T03:00:00.000Z' : null,
      setByName: configured ? 'Quản trị viên' : null,
    });
    mount({
      'GET /api/admin/override-password': () => ({ status: 200, body: status() }),
      'PUT /api/admin/override-password': (init) => {
        sent.push(JSON.parse(String(init.body)));
        configured = true;
        return { status: 200, body: status() };
      },
    });
    renderApp('/app/settings');

    const panel = await screen.findByTestId('admin-override-panel');
    expect(await within(panel).findByTestId('admin-override-status')).toHaveTextContent('Chưa đặt');
    expect(within(panel).queryByTestId('admin-override-clear')).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByTestId('admin-override-set'));
    const password = screen.getByTestId('admin-override-password');
    const confirm = screen.getByTestId('admin-override-confirm');
    expect(password).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('type', 'password');
    await userEvent.type(password, OVERRIDE);
    await userEvent.type(confirm, 'Khac2026x');
    expect(screen.getByText('Mật khẩu xác nhận không khớp.')).toBeInTheDocument();
    expect(screen.getByTestId('admin-override-save')).toBeDisabled();
    await userEvent.clear(confirm);
    await userEvent.type(confirm, OVERRIDE);
    await userEvent.click(screen.getByTestId('admin-override-save'));

    await waitFor(() => expect(sent).toEqual([{ password: OVERRIDE, confirmPassword: OVERRIDE }]));
    await waitFor(() => expect(screen.getByTestId('admin-override-status')).toHaveTextContent('Đang bật'));
    expect(screen.getByTestId('admin-override-status')).toHaveTextContent('Quản trị viên');
    expect(screen.getByTestId('admin-override-set')).toHaveTextContent('Đổi mật khẩu');
    expect(document.body).not.toHaveTextContent(OVERRIDE);
  });

  it('a failed status read is not shown as "Chưa đặt" — and a failed save shows the server’s reason', async () => {
    const MIGRATE = 'Cơ sở dữ liệu chưa được cập nhật. Chạy: npm run db:migrate rồi khởi động lại máy chủ.';
    const failure = () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: MIGRATE } } });
    mount({ 'GET /api/admin/override-password': failure, 'PUT /api/admin/override-password': failure });
    renderApp('/app/settings');

    const panel = await screen.findByTestId('admin-override-panel');
    await waitFor(() => expect(within(panel).getByTestId('admin-override-status')).toHaveTextContent('Không tải được trạng thái'));
    expect(within(panel).getByTestId('admin-override-status')).not.toHaveTextContent('Chưa đặt');
    expect(within(panel).getByText(MIGRATE)).toBeInTheDocument();

    await userEvent.click(within(panel).getByTestId('admin-override-set'));
    await userEvent.type(screen.getByTestId('admin-override-password'), OVERRIDE);
    await userEvent.type(screen.getByTestId('admin-override-confirm'), OVERRIDE);
    await userEvent.click(screen.getByTestId('admin-override-save'));
    expect(await within(screen.getByRole('dialog')).findByText(MIGRATE)).toBeInTheDocument();
  });

  it('turns it off after a confirmation', async () => {
    let deleted = 0;
    mount({
      'GET /api/admin/override-password': () => ({
        status: 200,
        body: { configured: true, updatedAt: '2026-10-08T03:00:00.000Z', setByName: 'Quản trị viên' },
      }),
      'DELETE /api/admin/override-password': () => {
        deleted += 1;
        return { status: 200, body: { configured: false, updatedAt: null, setByName: null } };
      },
    });
    renderApp('/app/settings');

    await userEvent.click(await screen.findByTestId('admin-override-clear'));
    expect(deleted).toBe(0);
    await userEvent.click(screen.getByTestId('admin-override-clear-confirm'));
    await waitFor(() => expect(deleted).toBe(1));
    await waitFor(() => expect(screen.getByTestId('admin-override-status')).toHaveTextContent('Chưa đặt'));
  });
});
