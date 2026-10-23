/**
 * BỘ PHẬN BUỒNG PHÒNG'S OWN "BÁO CÁO VẤN ĐỀ" — on screen.
 *
 *   1. its three journal categories only (no "Dịch vụ phòng, KPI", no payments,
 *      no service quality), its own list, the same forms as Reception
 *   2. the Admin reads it, without writing
 *   3. "Hoàn thành vấn đề" of its own records, without Reception's category
 *   4. the Quản lý buồng phòng's own cleaning: no "Không cần dọn", no handoff
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, HOUSEKEEPING_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';
import { GUEST_REQUEST_TITLE } from '../lib/reportCategories';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body: unknown };

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const MANAGER: AuthUser = { id: 9, username: 'qlbp', fullName: 'Quản lý Buồng', role: 'HOUSEKEEPING_MANAGER', branch: BRANCH, active: true, mustChangePassword: false };

const OPTIONS = {
  categories: [],
  paymentMethods: [],
  roomServiceTypes: [],
  paymentSources: [],
  deliveryDepartments: [
    { code: 'RECEPTION', label: 'Lễ tân' },
    { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
    { code: 'TECHNICAL', label: 'Kỹ thuật' },
  ],
  deliveryTitle: 'Giao nhận hàng hóa của khách sạn',
  deliveryArchiveHours: 12,
  severities: [],
};

function request(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    category: 'GUEST_REQUEST',
    categoryLabel: 'Vấn đề khách yêu cầu',
    branchId: 1,
    branch: BRANCH,
    shiftSessionId: null,
    shiftType: null,
    shiftName: null,
    shiftWindow: null,
    shiftDate: '2026-10-05',
    createdBy: { id: 6, fullName: 'Buồng phòng Một' },
    createdByName: 'Buồng phòng Một',
    createdByRole: 'HOUSEKEEPING',
    sourceLabel: 'Buồng phòng',
    originDepartment: 'HOUSEKEEPING',
    departmentLabel: 'Buồng phòng',
    createdAt: '2026-10-05T02:00:00.000Z',
    updatedAt: '2026-10-05T02:00:00.000Z',
    summary: 'Thêm gối',
    voided: false,
    audits: [],
    payment: null,
    guestRequest: {
      // Housekeeping's record: the room, never the guest (the server sends Housekeeping none).
      guestName: null,
      ezCode: null,
      roomNumber: 'Phòng - 301',
      content: 'Thêm gối',
      note: 'Thêm gối',
      severity: 'MEDIUM',
      severityLabel: 'Trung bình',
      completed: false,
      completedAt: null,
      completedByName: null,
      resolution: null,
    },
    facility: null,
    complaint: null,
    roomService: null,
    delivery: null,
    ...over,
  };
}

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
    'GET /api/nav-badges': () => ({ status: 200, body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } } }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/reception/reports/options': () => ({ status: 200, body: OPTIONS }),
    'GET /api/reception/reports/housekeeping': () => ({ status: 200, body: { reports: [request()], archiveAfterHours: 12 } }),
    ...extra,
  };
}

describe('"Báo cáo vấn đề" of Bộ phận buồng phòng', () => {
  it('offers its three categories only — the guest requests open first, from its own list', async () => {
    installApiMock(shell(HOUSEKEEPING_USER));
    renderApp('/app/hk/reports');
    expect(await screen.findByTestId('hk-report-title')).toHaveTextContent('Vấn đề khách yêu cầu');
    // One way to choose a category: the side menu — no second row of buttons on the page.
    expect(screen.queryByTestId('hk-report-tabs')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    const reports = within(nav).getByTestId('nav-group-Báo cáo vấn đề').parentElement!;
    expect(within(reports).getAllByRole('link').map((l) => l.getAttribute('href')).slice(0, 4)).toEqual([
      '/app/hk/reports?category=GUEST_REQUEST',
      '/app/hk/reports?category=FACILITY_ISSUE',
      '/app/hk/reports?category=HOTEL_DELIVERY',
      '/app/reports/confidential',
    ]);
    expect(within(reports).getByRole('link', { name: GUEST_REQUEST_TITLE }).getAttribute('aria-current')).toBe('page');
    expect(document.body).not.toHaveTextContent('Dịch vụ phòng');
    expect(document.body).not.toHaveTextContent('Thu tiền thanh toán');
    expect(document.body).not.toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
    expect(screen.getByTestId('hk-report-title')).toHaveTextContent('Vấn đề khách yêu cầu');
    const table = await screen.findByTestId('guest-request-table');
    expect(await within(table).findByText('Thêm gối')).toBeInTheDocument();
    expect(table).not.toHaveTextContent('Chưa xác định khách');
    expect(within(table).queryByRole('columnheader', { name: 'Tên khách' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Mã EZ' })).not.toBeInTheDocument();
    // Who reported it, by department.
    expect(within(table).getByTestId('request-meta-r1')).toHaveTextContent('Buồng phòng · Ghi nhận:');
    expect(screen.getByTestId('hk-report-confidential')).toHaveAttribute('href', '/app/reports/confidential');
  });

  it('records a guest request from its content and "Mức độ" alone — no room, guest, Mã EZ, branch, shift or department in the request', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: request({ id: 'r2' }) } };
        },
      }),
    );
    renderApp('/app/hk/reports?category=GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('hk-report-add'));
    const dialog = await screen.findByRole('dialog');
    // Only "Mức độ" and "Nội dung".
    for (const id of ['guest-request-guest', 'guest-request-ez', 'guest-request-place', 'hk-place', 'hk-place-room']) expect(within(dialog).queryByTestId(id)).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).getByTestId('guest-request-severity')).toBeInTheDocument();
    expect(within(dialog).getByTestId('guest-request-form-add')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('guest-request-content'), 'Thêm khăn');
    // "Bộ phận nhận việc" is required here too.
    expect(within(dialog).getByTestId('guest-request-form-add')).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('guest-request-department-HOUSEKEEPING'));
    await userEvent.click(within(dialog).getByTestId('guest-request-form-add'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ category: 'GUEST_REQUEST', guestRequest: { note: 'Thêm khăn', severity: 'MEDIUM', receivingDepartment: 'HOUSEKEEPING' } });
  });

  it('warns of a possible duplicate the server found — without its details — and sends it only when confirmed', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        'POST /api/reception/reports': (init) => {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          return body.confirmDuplicate
            ? { status: 201, body: { report: request({ id: 'r9' }) } }
            : {
                status: 409,
                body: {
                  error: {
                    code: 'POSSIBLE_DUPLICATE',
                    message: 'Bộ phận lễ tân có thể đã ghi nhận một báo cáo tương tự trong 24 giờ qua. Kiểm tra lại; nếu đây là việc khác, bấm “Vẫn gửi”.',
                    details: { department: 'RECEPTION' },
                  },
                },
              };
        },
      }),
    );
    renderApp('/app/hk/reports?category=GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('hk-report-add'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('guest-request-content'), 'Khách xin thêm khăn');
    await userEvent.click(within(dialog).getByTestId('guest-request-department-HOUSEKEEPING'));
    await userEvent.click(within(dialog).getByTestId('guest-request-form-add'));
    const warning = await within(dialog).findByTestId('guest-request-form-duplicate');
    expect(warning).toHaveTextContent('Bộ phận lễ tân có thể đã ghi nhận');
    expect(posted).toHaveLength(1);
    await userEvent.click(within(warning).getByTestId('guest-request-form-confirm-duplicate'));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ category: 'GUEST_REQUEST', guestRequest: { note: 'Khách xin thêm khăn', severity: 'MEDIUM', receivingDepartment: 'HOUSEKEEPING' }, confirmDuplicate: true });
  });

  it('follows the branch’s incidents and reports a new one, without correcting, returning or deleting any', async () => {
    const issue = {
      id: 'i1',
      branchId: 1,
      branch: BRANCH,
      status: 'NEW',
      statusLabel: 'Chờ giao kỹ thuật',
      description: 'Vòi sen rò nước',
      severity: 'HIGH',
      severityLabel: 'Cao',
      areaCategory: 'ROOM',
      roomNumber: '301',
      locationLabel: 'Phòng 301',
      createdAt: '2026-10-05T02:00:00.000Z',
      reporterName: 'Buồng phòng Một',
      attempts: [],
      dispatches: [],
    };
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({ status: 200, body: { issues: [issue], pagination: { total: 1 } } }),
      }),
    );
    renderApp('/app/hk/reports?category=FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Vòi sen rò nước')).toBeInTheDocument();
    expect(within(board).queryByTestId('edit-issue-i1')).not.toBeInTheDocument();
    expect(within(board).queryByTestId('delete-issue-i1')).not.toBeInTheDocument();
    expect(screen.getByTestId('hk-report-add')).toHaveTextContent('Báo cáo sự cố');
  });

  it('lets the Admin read any branch’s, without writing', async () => {
    installApiMock(shell(ADMIN_USER));
    renderApp('/app/hk/reports');
    expect(await screen.findByTestId('hk-reports-branch')).toBeInTheDocument();
    const table = await screen.findByTestId('guest-request-table');
    // The Admin is not Housekeeping: the request says it has no guest yet, who sent it and when it was recorded.
    expect(await within(table).findByText('Chưa xác định khách')).toBeInTheDocument();
    expect(within(table).getByTestId('request-meta-r1')).toHaveTextContent('Ghi nhận: 05/10/2026 09:00:00');
    expect(table).not.toHaveTextContent('Phòng - 301');
    expect(screen.queryByTestId('hk-report-add')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('complete-r1')).not.toBeInTheDocument();
  });
});

describe('"Hoàn thành vấn đề" of Bộ phận buồng phòng', () => {
  it('reads its own archive — without Reception’s service-quality category or its exports', async () => {
    const asked: string[] = [];
    const record = (url: string) => () => {
      asked.push(url);
      return { status: 200, body: { reports: [request({ guestRequest: { ...request().guestRequest, completed: true, completedAt: '2026-10-05T03:00:00.000Z', completedByName: 'Quản lý Buồng' } })], totals: { GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 0 }, range: null, archiveAfterHours: 12 } };
    };
    const fetchMock = installApiMock(shell(MANAGER));
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit = {}) => {
      const key = `${(init.method ?? 'GET').toUpperCase()} ${String(url)}`;
      const routes = shell(MANAGER);
      const handler = key.startsWith('GET /api/reception/reports/archive')
        ? record(key)
        : key.startsWith('GET /api/issues?')
          ? () => ({ status: 200, body: { issues: [], pagination: { total: 0 } } })
          : key.startsWith('GET /api/hotel-deliveries')
            ? () => ({ status: 200, body: { scope: 'archived', deliveries: [], total: 0 } })
            : routes[key];
      const res = handler ? handler(init) : { status: 404, body: { error: { code: 'NOT_FOUND', message: key } } };
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    });
    renderApp('/app/hk/completed?verdict=CORRECT');
    const completed = await screen.findByTestId('completed-issues');
    expect(await within(completed).findByText('Thêm gối')).toBeInTheDocument();
    expect(completed).not.toHaveTextContent('Chưa xác định khách');
    expect(completed).not.toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
    expect(screen.queryByTestId('completed-export-pdf')).not.toBeInTheDocument();
    // The manager's own department is the server's to decide — never asked for.
    expect(asked.every((u) => !u.includes('department='))).toBe(true);
  });
});

describe('"Hoàn thành vấn đề" — "Loại vấn đề" instead of "Mức độ"', () => {
  function recording(user: unknown) {
    const asked: string[] = [];
    const fetchMock = installApiMock(shell(user));
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit = {}) => {
      const key = `${(init.method ?? 'GET').toUpperCase()} ${String(url)}`;
      asked.push(key);
      const routes = shell(user);
      const res = key.startsWith('GET /api/reception/reports/archive')
        ? { status: 200, body: { reports: [], totals: { GUEST_REQUEST: 0, CUSTOMER_COMPLAINT: 0 }, range: null, archiveAfterHours: 12 } }
        : key.startsWith('GET /api/issues?')
          ? { status: 200, body: { issues: [], pagination: { total: 0 } } }
          : key.startsWith('GET /api/hotel-deliveries')
            ? { status: 200, body: { scope: 'archived', deliveries: [], total: 0 } }
            : routes[key]
              ? routes[key]!(init)
              : { status: 404, body: { error: { code: 'NOT_FOUND', message: key } } };
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    });
    return asked;
  }

  it('offers every type of the view, keeps the dates and the shift, and asks the server for the chosen type alone', async () => {
    const asked = recording(ADMIN_USER);
    renderApp('/app/completed-issues?verdict=CORRECT');
    const kind = await screen.findByTestId('completed-kind');
    expect(within(kind).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Tất cả',
      GUEST_REQUEST_TITLE,
      'Sự cố cơ sở vật chất',
      'Vấn đề về chất lượng và dịch vụ',
      'Giao nhận hàng hóa của khách sạn',
    ]);
    // "Mức độ" is gone; the dates and the shift stay.
    expect(screen.queryByTestId('completed-severity')).not.toBeInTheDocument();
    for (const mode of ['Hôm nay', 'Ngày cụ thể', 'Khoảng ngày']) expect(screen.getAllByRole('button', { name: mode }).length).toBeGreaterThan(0);
    await waitFor(() => expect(asked.some((u) => u.startsWith('GET /api/issues?'))).toBe(true));
    await userEvent.selectOptions(kind, 'GUEST_REQUEST');
    asked.length = 0;
    await userEvent.selectOptions(kind, 'CUSTOMER_COMPLAINT');
    await waitFor(() => expect(asked.some((u) => u.startsWith('GET /api/reception/reports/archive') && u.includes('category=CUSTOMER_COMPLAINT'))).toBe(true));
    // Only that type's section, and no other type's request.
    expect(asked.some((u) => u.startsWith('GET /api/issues?') || u.startsWith('GET /api/hotel-deliveries'))).toBe(false);
    expect(screen.getByTestId('completed-issues')).not.toHaveTextContent('Sự cố cơ sở vật chất');
    expect(screen.queryByTestId('completed-facility')).not.toBeInTheDocument();
    // An incident type asks for incidents only.
    asked.length = 0;
    await userEvent.selectOptions(kind, 'FACILITY_ISSUE');
    expect(await screen.findByTestId('completed-facility')).toBeInTheDocument();
    expect(asked.some((u) => u.startsWith('GET /api/reception/reports/archive'))).toBe(false);
  });

  it('offers Bộ phận buồng phòng its own types only', async () => {
    recording(HOUSEKEEPING_USER);
    renderApp('/app/hk/completed?verdict=CORRECT');
    const kind = await screen.findByTestId('completed-kind');
    expect(within(kind).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tất cả', GUEST_REQUEST_TITLE, 'Sự cố cơ sở vật chất', 'Giao nhận hàng hóa của khách sạn']);
  });
});

describe('the Admin’s "Hoàn thành vấn đề" of Bộ phận buồng phòng', () => {
  it('asks for the housekeeping department — its requests and the hand-overs Reception made to it', async () => {
    const asked: string[] = [];
    const delivery = request({
      id: 'd1',
      category: 'HOTEL_DELIVERY',
      categoryLabel: 'Giao nhận hàng hóa của khách sạn',
      originDepartment: 'RECEPTION',
      departmentLabel: 'Lễ tân',
      sourceLabel: null,
      createdByRole: 'RECEPTIONIST',
      createdByName: 'Lễ tân Một',
      guestRequest: null,
      delivery: {
        department: 'HOUSEKEEPING',
        departmentLabel: 'Buồng phòng',
        itemName: 'Ga giường',
        quantity: 20,
        note: null,
        status: 'COMPLETED',
        statusLabel: 'Đã hoàn thành',
        completedAt: '2026-10-05T02:00:00.000Z',
        archived: true,
      },
    });
    const fetchMock = installApiMock(shell(ADMIN_USER));
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit = {}) => {
      const key = `${(init.method ?? 'GET').toUpperCase()} ${String(url)}`;
      asked.push(key);
      const routes = shell(ADMIN_USER);
      const res = key.startsWith('GET /api/reception/reports/archive')
        ? { status: 200, body: { reports: [], totals: { GUEST_REQUEST: 0, CUSTOMER_COMPLAINT: 0 }, range: null, archiveAfterHours: 12 } }
        : key.startsWith('GET /api/issues?')
          ? { status: 200, body: { issues: [], pagination: { total: 0 } } }
          : key.startsWith('GET /api/hotel-deliveries')
            ? { status: 200, body: { scope: 'archived', deliveries: [delivery], total: 1 } }
            : routes[key]
              ? routes[key]!(init)
              : { status: 404, body: { error: { code: 'NOT_FOUND', message: key } } };
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    });
    renderApp('/app/hk/completed?verdict=CORRECT');
    const table = await screen.findByTestId('completed-delivery-table');
    await waitFor(() => expect(table).toHaveTextContent('Ga giường'));
    await waitFor(() => expect(asked.some((u) => u.startsWith('GET /api/reception/reports/archive') && u.includes('department=HOUSEKEEPING'))).toBe(true));
    expect(asked.some((u) => u.startsWith('GET /api/hotel-deliveries') && u.includes('department=HOUSEKEEPING'))).toBe(true);
    // Reception's "Vấn đề về chất lượng và dịch vụ" is not part of it.
    expect(screen.getByTestId('completed-issues')).not.toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
  });
});

describe('the Quản lý buồng phòng’s own cleaning', () => {
  it('offers neither "Không cần dọn" nor "Chưa dọn — chuyển người khác dọn" — it gives rooms out on its board', async () => {
    const task = {
      id: 'm1',
      branchId: 1,
      branch: BRANCH,
      workDate: '2026-10-05',
      roomNumber: '101',
      statusCode: 'OUT',
      priority: false,
      note: null,
      areaKind: 'ROOM',
      areaLabel: 'Phòng - 101',
      taskLabel: 'OUT',
      taskCodes: ['OUT'],
      workGroup: { id: 'g1', number: 1, name: null },
      noClean: null,
      handoff: null,
      phase: 'AWAITING_CLEANING',
      phaseLabel: 'Chờ dọn phòng',
      assignee: { id: 9, name: 'Quản lý Buồng' },
      state: 'INSPECTED',
      stateLabel: 'Đã kiểm tra',
      startedAt: null,
      completedAt: null,
      durationSeconds: null,
      elapsedSeconds: null,
      inspection: { id: 'i1', createdAt: '2026-10-05T02:00:00.000Z', inspectorId: 9, inspectorName: 'Quản lý Buồng', findings: [] },
      cleaning: null,
      cleanedBy: null,
      voided: false,
      reclean: null,
      review: null,
      events: [],
    };
    installApiMock(
      shell(MANAGER, {
        'GET /api/housekeeping/work/tasks/m1': () => ({ status: 200, body: { task } }),
        'GET /api/housekeeping/catalog': () => ({ status: 200, body: { linen: [], quantities: [], collectable: [], replaced: [], special: [], sizes: [] } }),
      }),
    );
    renderApp('/app/inspections/room/m1');
    expect(await screen.findByTestId('cleaning-start-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('room-no-clean-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cleaning-release')).not.toBeInTheDocument();
  });
});
