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
      guestName: 'Khách 301',
      ezCode: 'EZ301',
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
    const tabs = await screen.findByTestId('hk-report-tabs');
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Khách yêu cầu', 'Sự cố', 'Giao nhận']);
    expect(document.body).not.toHaveTextContent('Dịch vụ phòng');
    expect(document.body).not.toHaveTextContent('Thu tiền thanh toán');
    expect(document.body).not.toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
    expect(screen.getByTestId('hk-report-title')).toHaveTextContent('Vấn đề khách yêu cầu');
    const table = await screen.findByTestId('guest-request-table');
    expect(await within(table).findByText('Khách 301')).toBeInTheDocument();
    // Who reported it, by department.
    expect(within(table).getByText('Buồng phòng')).toBeInTheDocument();
    expect(screen.getByTestId('hk-report-confidential')).toHaveAttribute('href', '/app/reports/confidential');
  });

  it('records a guest request through the shared journal — no branch, shift or department in the request', async () => {
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
    await userEvent.type(within(dialog).getByTestId('guest-request-guest'), 'Khách 405');
    await userEvent.type(within(dialog).getByTestId('guest-request-content'), 'Thêm khăn');
    await userEvent.click(within(dialog).getByTestId('guest-request-form-add'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ category: 'GUEST_REQUEST', guestRequest: { guestName: 'Khách 405', note: 'Thêm khăn' } });
    for (const key of ['branchId', 'department', 'originDepartment', 'shiftSessionId']) expect(posted[0]).not.toHaveProperty(key);
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
    expect(await within(table).findByText('Khách 301')).toBeInTheDocument();
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
    expect(await within(completed).findByText('Khách 301')).toBeInTheDocument();
    expect(completed).not.toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
    expect(screen.queryByTestId('completed-export-pdf')).not.toBeInTheDocument();
    // The manager's own department is the server's to decide — never asked for.
    expect(asked.every((u) => !u.includes('department='))).toBe(true);
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
