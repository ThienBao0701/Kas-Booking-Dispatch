import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import type { AdminBranch } from '../api/adminBranches';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The five platform rows a branch always returns, with one name configured. */
function identityRows(bookingComName: string | null) {
  const platforms = ['BOOKING_COM', 'AGODA', 'CTRIP', 'TRIPADVISOR', 'TRAVELOKA'] as const;
  return platforms.map((platform) => ({
    platform,
    name: platform === 'BOOKING_COM' ? bookingComName : null,
    normalizedName: null,
    needsConfirmation: false,
    updatedAt: null,
  }));
}

function branch(over: Partial<AdminBranch> = {}): AdminBranch {
  return {
    id: 1,
    branchNumber: 1,
    code: 'TRUONG_DINH_05',
    hotelName: 'Saigon Hotel & Ben Thanh',
    address: '05 Trương Định',
    breakfastIncluded: false,
    active: true,
    phone: null,
    email: null,
    contactName: null,
    note: null,
    aliases: [
      { id: 11, source: 'BOOKING_COM', alias: 'Saigon Hotel & Ben Thanh', normalizedAlias: 'saigon hotel ben thanh', matchMode: 'SIMILARITY', active: true, priority: 0 },
      { id: 12, source: 'AGODA', alias: 'KAS Passion Boutique Hotel', normalizedAlias: 'kas passion boutique hotel', matchMode: 'EXACT', active: true, priority: 0 },
    ],
    receptionistCount: 2,
    activeReceptionistCount: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

const SECOND = branch({
  id: 2,
  branchNumber: 2,
  code: 'LY_TU_TRONG_260',
  hotelName: 'Luxury Elegance Hotel Ben Than',
  address: '260 Lý Tự Trọng',
  breakfastIncluded: true,
  aliases: [
    { id: 21, source: 'BOOKING_COM', alias: 'Bamboo Water Hotel', normalizedAlias: 'bamboo water hotel', matchMode: 'SIMILARITY', active: true, priority: 0 },
  ],
  receptionistCount: 0,
  activeReceptionistCount: 0,
});

const SHELL_MOCKS = {
  'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
  'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
};

/** Renders the branch page as Admin with the given extra route handlers. */
function renderBranches(extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {}) {
  const fetchMock = installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    ...SHELL_MOCKS,
    'GET /api/admin/branches': () => ({ status: 200, body: { branches: [branch(), SECOND] } }),
    'GET /api/admin/branches/1/platform-identities': () => ({
      status: 200,
      body: { identities: identityRows('Market Ben Thanh Kas Hotel Passion') },
    }),
    'GET /api/admin/branches/2/platform-identities': () => ({
      status: 200,
      body: { identities: identityRows('Elegance Hotel - Ben Thanh Market - Central HCMC') },
    }),
    ...extra,
  });
  renderApp('/app/branches');
  return fetchMock;
}

/** The row of the branch table containing the given text. */
async function rowFor(text: string) {
  const cell = await screen.findByText(text);
  return cell.closest('tr')!;
}

describe('BranchesPage — access', () => {
  it('1. an Admin sees the branch-management page', async () => {
    renderBranches();
    expect(await screen.findByRole('heading', { name: 'Quản lý khách sạn & chi nhánh' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Khách sạn & chi nhánh' })).toBeInTheDocument();
  });

  it('2. a receptionist neither sees the nav entry nor reaches the page', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      ...SHELL_MOCKS,
      'GET /api/bookings/new': () => ({ status: 200, body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } }),
    });
    renderApp('/app/branches');
    expect((await screen.findAllByText(/không có quyền/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Quản lý khách sạn & chi nhánh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Khách sạn & chi nhánh' })).not.toBeInTheDocument();
  });

  it('3. renders the current branches with number, code, aliases and breakfast', async () => {
    renderBranches();
    const first = await rowFor('05 Trương Định');
    expect(within(first).getByText('TRUONG_DINH_05')).toBeInTheDocument();
    expect(within(first).getByText('Không ăn sáng')).toBeInTheDocument();
    // Only the CURRENT platform name appears — never a superseded alias, and
    // never a struck-through disabled one.
    expect(await within(first).findByText(/Market Ben Thanh Kas Hotel Passion/)).toBeInTheDocument();
    expect(within(first).getByText('Đang hoạt động')).toBeInTheDocument();
    expect(first.querySelector('.line-through')).toBeNull();

    const second = await rowFor('260 Lý Tự Trọng');
    expect(within(second).getByText('Có ăn sáng')).toBeInTheDocument();
    expect(
      await within(second).findByText(/Elegance Hotel - Ben Thanh Market - Central HCMC/),
    ).toBeInTheDocument();
  });
});

describe('BranchesPage — add branch', () => {
  async function openCreate() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Thêm khách sạn \/ chi nhánh/ }));
    return user;
  }

  it('4. validates the form before enabling creation, and previews the branch', async () => {
    renderBranches();
    const user = await openCreate();

    const submit = screen.getByRole('button', { name: 'Tạo chi nhánh' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/Số chi nhánh/), '9');
    await user.type(screen.getByLabelText(/Tên nội bộ/), 'Chi nhánh thử nghiệm');
    await user.type(screen.getByLabelText(/Địa chỉ/), '12 Nguyễn Huệ');

    // The stable code is suggested from the address, in the existing convention.
    expect(screen.getByLabelText(/Mã chi nhánh/)).toHaveValue('NGUYEN_HUE_12');
    expect(screen.getByText('Chi nhánh 9')).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it('5. surfaces a duplicate branch-number error from the server', async () => {
    renderBranches({
      'POST /api/admin/branches': () => ({
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'Số chi nhánh 2 đã được dùng cho 260 Lý Tự Trọng.' } },
      }),
    });
    const user = await openCreate();
    await user.type(screen.getByLabelText(/Số chi nhánh/), '2');
    await user.type(screen.getByLabelText(/Tên nội bộ/), 'Trùng số');
    await user.type(screen.getByLabelText(/Địa chỉ/), '12 Nguyễn Huệ');
    await user.click(screen.getByRole('button', { name: 'Tạo chi nhánh' }));

    expect(await screen.findByText(/Số chi nhánh 2 đã được dùng/)).toBeInTheDocument();
  });

  it('6. validates the stable-code format', async () => {
    renderBranches();
    const user = await openCreate();
    await user.type(screen.getByLabelText(/Số chi nhánh/), '9');
    await user.type(screen.getByLabelText(/Tên nội bộ/), 'Chi nhánh thử nghiệm');
    await user.type(screen.getByLabelText(/Địa chỉ/), '12 Nguyễn Huệ');

    const code = screen.getByLabelText(/Mã chi nhánh/);
    await user.clear(code);
    await user.type(code, 'khong hop le!');
    expect(await screen.findByText(/chỉ được gồm chữ IN HOA/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tạo chi nhánh' })).toBeDisabled();
  });

  it('7/8/9. does not collect platform names at creation time', async () => {
    let posted: unknown = null;
    renderBranches({
      'POST /api/admin/branches': (init) => {
        posted = JSON.parse(String(init.body));
        return { status: 201, body: { branch: branch({ id: 9, branchNumber: 9, code: 'NGUYEN_HUE_12' }) } };
      },
    });
    const user = await openCreate();
    await user.type(screen.getByLabelText(/Số chi nhánh/), '9');
    await user.type(screen.getByLabelText(/Tên nội bộ/), 'Chi nhánh thử nghiệm');
    await user.type(screen.getByLabelText(/Địa chỉ/), '12 Nguyễn Huệ');

    // Platform names are no longer collected here: a branch has exactly one
    // CURRENT name per platform, set from the dedicated manager after creation.
    expect(screen.getByText(/Sau khi tạo chi nhánh/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm tên' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Nguồn', { selector: '#new-alias-source' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tạo chi nhánh' }));
    expect(posted).toMatchObject({ branchNumber: 9, code: 'NGUYEN_HUE_12' });
    // The create payload carries no platform names at all.
    expect(posted).not.toHaveProperty('aliases');
  });
});

describe('BranchesPage — edit branch', () => {
  async function openEdit() {
    const user = userEvent.setup();
    const row = await rowFor('05 Trương Định');
    await user.click(within(row).getByRole('button', { name: 'Chỉnh sửa' }));
    return user;
  }

  it('10/11/12/13. edits name, address, number and breakfast, and never the stable code', async () => {
    let patched: unknown = null;
    renderBranches({
      'PATCH /api/admin/branches/1': (init) => {
        patched = JSON.parse(String(init.body));
        return { status: 200, body: { branch: branch({ hotelName: 'Tên nội bộ mới' }) } };
      },
    });
    const user = await openEdit();

    // 12. the stable code is shown but not editable.
    const code = screen.getByLabelText(/Mã chi nhánh/);
    expect(code).toBeDisabled();
    expect(screen.getByText(/không thể thay đổi sau khi tạo/)).toBeInTheDocument();

    const name = screen.getByLabelText(/Tên nội bộ/);
    await user.clear(name);
    await user.type(name, 'Tên nội bộ mới');

    const address = screen.getByLabelText(/Địa chỉ/);
    await user.clear(address);
    await user.type(address, '07 Trương Định');

    const number = screen.getByLabelText(/Số chi nhánh/);
    await user.clear(number);
    await user.type(number, '11');

    // 13. breakfast toggle.
    await user.click(screen.getByLabelText('Có ăn sáng'));

    await user.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    expect(patched).toEqual(
      expect.objectContaining({
        hotelName: 'Tên nội bộ mới',
        address: '07 Trương Định',
        branchNumber: 11,
        breakfastIncluded: true,
      }),
    );
    // The immutable code is never part of the update payload.
    expect(patched).not.toHaveProperty('code');
  });
});

describe('BranchesPage — platform names', () => {
  it('16. shows a name-collision error from the server, in Vietnamese', async () => {
    renderBranches({
      'PUT /api/admin/branches/1/platform-identities/AGODA': () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Tên "KAS Sonata Luxury Hotel" đã được dùng cho một chi nhánh khác trên nền tảng này.',
          },
        },
      }),
    });
    const user = userEvent.setup();
    const row = await rowFor('05 Trương Định');
    await user.click(within(row).getByRole('button', { name: /Quản lý tên trên nền tảng/ }));

    // Agoda has no current name yet, so the action is "Thêm".
    const agodaRow = (await screen.findByLabelText('Tên khách sạn theo nền tảng'))
      .querySelectorAll('li')[1] as HTMLElement;
    await user.click(within(agodaRow).getByRole('button', { name: 'Thêm' }));
    await user.type(screen.getByLabelText('Tên trên Agoda'), 'KAS Sonata Luxury Hotel');
    await user.click(within(agodaRow).getByRole('button', { name: 'Lưu' }));

    expect(await screen.findByText(/đã được dùng cho một chi nhánh khác/)).toBeInTheDocument();
  });

  it('16b. shows one current name per platform, an empty state, and no toggles', async () => {
    renderBranches();
    const user = userEvent.setup();
    const row = await rowFor('05 Trương Định');
    await user.click(within(row).getByRole('button', { name: /Quản lý tên trên nền tảng/ }));

    const list = await screen.findByLabelText('Tên khách sạn theo nền tảng');
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(5);

    // The configured platform shows its single current value…
    expect(within(items[0] as HTMLElement).getByText('Market Ben Thanh Kas Hotel Passion')).toBeInTheDocument();
    // …and the unconfigured ones say so clearly.
    expect(within(items[1] as HTMLElement).getByText('Chưa thiết lập')).toBeInTheDocument();

    // No enable/disable toggles and no struck-through history in the live list.
    expect(within(list).queryByRole('button', { name: 'Tắt' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Bật lại' })).not.toBeInTheDocument();
    expect(list.querySelector('.line-through')).toBeNull();
  });
});

describe('BranchesPage — activation', () => {
  it('14/15. asks for confirmation and warns about assigned receptionists', async () => {
    let deactivated = false;
    renderBranches({
      'GET /api/admin/branches/1/receptionists': () => ({
        status: 200,
        body: { receptionists: [{ id: 5, username: 'letan1', fullName: 'Lễ tân Một', active: true }] },
      }),
      'POST /api/admin/branches/1/deactivate': () => {
        deactivated = true;
        return { status: 200, body: { branch: branch({ active: false }), affectedReceptionists: [] } };
      },
    });
    const user = userEvent.setup();
    const row = await rowFor('05 Trương Định');
    await user.click(within(row).getByRole('button', { name: 'Vô hiệu hóa' }));

    // A confirmation step, not an immediate action.
    expect(deactivated).toBe(false);
    expect(await screen.findByText(/1 tài khoản lễ tân đang thuộc chi nhánh này/)).toBeInTheDocument();
    expect(screen.getByText(/Lễ tân Một \(letan1\)/)).toBeInTheDocument();
    expect(screen.getByText(/không tự chuyển các tài khoản này/)).toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Vô hiệu hóa' }));
    expect(deactivated).toBe(true);
  });

  it('17. an inactive branch shows its status and offers re-activation', async () => {
    renderBranches({
      'GET /api/admin/branches': () => ({ status: 200, body: { branches: [branch({ active: false }), SECOND] } }),
    });
    const row = await rowFor('05 Trương Định');
    expect(within(row).getByText('Đã vô hiệu hóa')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Kích hoạt lại' })).toBeInTheDocument();
  });
});

describe('receptionist assignment uses the live active branches', () => {
  function renderSettings(branches: { id: number; code: string; hotelName: string; address: string; branchNumber?: number }[]) {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      ...SHELL_MOCKS,
      'GET /api/admin/users?includeAdmins=true': () => ({ status: 200, body: { users: [] } }),
      'GET /api/branches': () => ({ status: 200, body: { branches } }),
      'GET /api/dev-test/status': () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } }),
    });
    renderApp('/app/settings');
  }

  it('18. a newly added branch appears in the receptionist creation form', async () => {
    renderSettings([
      { id: 1, code: 'TRUONG_DINH_05', hotelName: 'H1', address: '05 Trương Định', branchNumber: 1 },
      { id: 9, code: 'NGUYEN_HUE_12', hotelName: 'Chi nhánh thử nghiệm', address: '12 Nguyễn Huệ', branchNumber: 9 },
    ]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));

    const select = screen.getByLabelText(/Chi nhánh/);
    expect(within(select).getByRole('option', { name: 'Chi nhánh 9 — 12 Nguyễn Huệ' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Chi nhánh 1 — 05 Trương Định' })).toBeInTheDocument();
  });

  it('19. an inactive branch is not offered for a new receptionist', async () => {
    // /api/branches only ever returns ACTIVE branches, so the disabled ninth
    // branch is simply absent from the assignment list.
    renderSettings([{ id: 1, code: 'TRUONG_DINH_05', hotelName: 'H1', address: '05 Trương Định', branchNumber: 1 }]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Thêm bộ phận/ }));

    const select = screen.getByLabelText(/Chi nhánh/);
    expect(within(select).queryByRole('option', { name: /12 Nguyễn Huệ/ })).not.toBeInTheDocument();
    expect(within(select).getAllByRole('option')).toHaveLength(2); // placeholder + one branch
  });
});

describe('BranchesPage — accessibility', () => {
  it('20. the table, dialog and controls are reachable and labelled', async () => {
    renderBranches();
    const user = userEvent.setup();

    // A named table with column headers.
    const table = await screen.findByRole('table', { name: 'Danh sách khách sạn và chi nhánh' });
    expect(within(table).getByRole('columnheader', { name: 'Số CN' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Trạng thái' })).toBeInTheDocument();

    // The add dialog is a labelled modal whose fields have accessible names…
    await user.click(screen.getByRole('button', { name: /Thêm khách sạn \/ chi nhánh/ }));
    const dialog = screen.getByRole('dialog', { name: 'Thêm khách sạn / chi nhánh' });
    expect(within(dialog).getByLabelText(/Số chi nhánh/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Địa chỉ/)).toBeInTheDocument();

    // …and it is keyboard-navigable and closes on Escape.
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
