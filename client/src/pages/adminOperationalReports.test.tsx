/**
 * THE ADMIN'S "BÁO CÁO VẤN ĐỀ" — chi nhánh → danh mục → toàn bộ bản ghi.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The branches come from the DATABASE, not from a list in the code — which
 *      is why the fixture has NINE. A test with eight passes against a hardcoded
 *      eight, and proves nothing.
 *   2. Each category is a COMPACT TABLE, titled with the SERVER's own words, and
 *      the counts sit on the tabs without ever replacing the rows.
 *   3. Nothing was lost to make it compact: every row opens into the full
 *      record, correction history included, AT DESKTOP WIDTH — and two rows open
 *      at once, because an Admin opens two in order to compare them.
 *   4. Money is right-aligned, formatted, and an absent figure reads "—" and
 *      never "0 ₫".
 *   5. A voided record stays on screen, marked, and out of the totals.
 *   6. The Admin does not get reception's writing controls — structurally, not
 *      just visually.
 *   7. The drawer names the period it covers, and says so when it was never
 *      counted.
 *   8. The export asks for a period and offers PDF and Excel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

/**
 * The page opens on TODAY, so every data request names today's date. Computed
 * from the same clock the page reads, rather than hardcoded.
 */
const TODAY = hcmToday();
const PERIOD = `from=${TODAY}&to=${TODAY}`;

/**
 * NINE properties, as `Branch` rows — ids deliberately non-sequential.
 *
 * Nine, not eight. The claim is "the branches are DATA"; a fixture with exactly
 * as many rows as the business happens to have today is a fixture a hardcoded
 * list would satisfy.
 */
const BRANCHES = [
  { id: 11, code: 'TRUONG_DINH_05', hotelName: 'KAS A', address: '05 Trương Định', branchNumber: 1, active: true },
  { id: 12, code: 'LY_TU_TRONG_260', hotelName: 'KAS B', address: '260 Lý Tự Trọng', branchNumber: 2, active: true },
  { id: 13, code: 'NGUYEN_TRAI_47A', hotelName: 'KAS C', address: '47A Nguyễn Trãi', branchNumber: 3, active: true },
  { id: 14, code: 'NGUYEN_THAI_BINH', hotelName: 'KAS D', address: '170-172-174 Nguyễn Thái Bình', branchNumber: 4, active: true },
  { id: 15, code: 'LE_THANH_TON_278', hotelName: 'KAS E', address: '278 Lê Thánh Tôn', branchNumber: 5, active: true },
  { id: 16, code: 'BUI_THI_XUAN_40', hotelName: 'KAS F', address: '40-42 Bùi Thị Xuân', branchNumber: 6, active: true },
  { id: 17, code: 'BUI_THI_XUAN_13', hotelName: 'KAS G', address: '13 Bùi Thị Xuân', branchNumber: 7, active: true },
  { id: 18, code: 'LE_THANH_TON_191', hotelName: 'KAS H', address: '191 Lê Thánh Tôn', branchNumber: 8, active: true },
  { id: 19, code: 'NGO_DUC_KE_09', hotelName: 'KAS I', address: '09 Ngô Đức Kế', branchNumber: 9, active: true },
];

/** The server's words. The client keeps a fallback, never a definition. */
const OPTIONS = {
  categories: [
    { code: 'PAYMENT', label: 'Theo dõi thanh toán' },
    { code: 'GUEST_REQUEST', label: 'Vấn đề khách yêu cầu' },
    { code: 'FACILITY_ISSUE', label: 'Sự cố vật chất đang xử lý' },
    { code: 'CUSTOMER_COMPLAINT', label: 'Vấn đề về chất lượng và dịch vụ' },
    { code: 'ROOM_SERVICE', label: 'Dịch vụ phòng, KPI' },
  ],
  paymentMethods: [{ code: 'CASH', label: 'Thu tiền mặt' }],
  roomServiceTypes: [
    { code: 'ROOM_SALE', label: 'Bán phòng' },
    { code: 'UPGRADE', label: 'Upgrade' },
    { code: 'SMOKING', label: 'Hút thuốc' },
    { code: 'LAUNDRY', label: 'Giặt ủi' },
    { code: 'OTHER', label: 'Dịch vụ khác' },
  ],
  paymentSources: ['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia'],
};

const BASE = {
  branchId: 11,
  branch: BRANCHES[0],
  shiftSessionId: 's1',
  shiftType: 'A',
  shiftName: 'Ca A',
  shiftWindow: '06:00 – 14:00',
  // The server's own day for the SHIFT, from the session.
  shiftDate: '2026-09-19',
  shiftReceptionistName: 'Nguyễn Văn A',
  // Closed: "Kết thúc ca" was pressed, so the shift is in the official report.
  shiftClosed: true,
  createdBy: { id: 2, fullName: 'Lễ tân Một' },
  createdByName: 'Nguyễn Văn A',
  createdAt: '2026-09-19T01:00:00.000Z',
  updatedAt: '2026-09-19T01:00:00.000Z',
  voided: false,
  voidedAt: null,
  voidedBy: null,
  voidedByName: null,
  voidReason: null,
  payment: null,
  guestRequest: null,
  facility: null,
  complaint: null,
  roomService: null,
  audits: [],
};

const PAYMENT = {
  ...BASE,
  id: 'p1',
  category: 'PAYMENT',
  categoryLabel: 'Theo dõi thanh toán',
  summary: 'Nguyễn Khách · Thu tiền mặt 300.000 ₫',
  payment: {
    ezCode: 'EZ123',
    source: 'Booking.com',
    guestName: 'Nguyễn Khách',
    roomNumber: '101',
    method: 'CASH',
    methodLabel: 'Thu tiền mặt',
    amount: 300000,
    receivable: 50000,
    expense: 100000,
    note: 'Thanh toán đêm đầu',
    cash: 300000,
    transfer: 0,
    card: 0,
  },
  audits: [
    {
      id: 'a1',
      action: 'EDIT',
      field: 'amount',
      oldValue: '3000000',
      newValue: '300000',
      reason: 'Thừa một số 0',
      actor: { id: 2, name: 'Nguyễn Văn A' },
      shiftType: 'A',
      createdAt: '2026-09-19T01:30:00.000Z',
    },
  ],
};

/** A withdrawn transaction: still a row, still readable, out of every total. */
const VOIDED_PAYMENT = {
  ...BASE,
  id: 'p2',
  category: 'PAYMENT',
  categoryLabel: 'Theo dõi thanh toán',
  summary: 'Khách Hủy · Thu tiền mặt 900.000 ₫',
  voided: true,
  voidedAt: '2026-09-19T03:00:00.000Z',
  voidedBy: { id: 2, fullName: 'Lễ tân Một' },
  voidedByName: 'Nguyễn Văn A',
  voidReason: 'Nhập nhầm khách',
  payment: {
    ezCode: 'EZ999',
    source: 'Agoda',
    guestName: 'Khách Hủy',
    roomNumber: '303',
    method: 'CASH',
    methodLabel: 'Thu tiền mặt',
    amount: 900000,
    receivable: 0,
    expense: 0,
    note: null,
    cash: 900000,
    transfer: 0,
    card: 0,
  },
};

const REQUEST = {
  ...BASE,
  id: 'g1',
  category: 'GUEST_REQUEST',
  categoryLabel: 'Vấn đề khách yêu cầu',
  summary: 'Balo · Khách ký gửi · đã hoàn thành',
  guestRequest: {
    guestName: 'Khách ký gửi',
    ezCode: 'EZ305',
    content: 'Balo — Balo đen',
    note: 'Balo đen',
    itemType: 'Balo',
    roomNumber: '305',
    completed: true,
    completedBy: { id: 3, fullName: 'Lễ tân Hai' },
    completedByName: 'Nguyễn Văn B',
    completedAt: '2026-09-19T07:02:00.000Z',
    completedShiftType: 'B',
    completedShiftName: 'Ca B',
    resolution: 'Đã trả balo cho khách',
  },
};

/**
 * The incident, with its repair attempts — which the server has always sent and
 * the client type used to describe as `unknown[]`.
 */
const FACILITY = {
  ...BASE,
  id: 'f1',
  category: 'FACILITY_ISSUE',
  categoryLabel: 'Sự cố vật chất đang xử lý',
  summary: 'Khu Vực Sảnh · Sofa rách',
  facility: {
    issueId: 'cm0000000000000000000issue',
    issue: {
      id: 'cm0000000000000000000issue',
      locationLabel: 'Khu Vực Sảnh · Sofa',
      category: 'FURNITURE',
      description: 'Sofa rách',
      status: 'IN_PROGRESS',
      needsRework: false,
      technicianName: 'Bảo',
      technicianPhone: '0909000111',
      acceptedAt: '2026-09-19T02:00:00.000Z',
      completedAt: null,
      durationLabel: '45 phút',
      cannotRepairCount: 1,
      updatedAt: '2026-09-19T04:30:00.000Z',
      attempts: [
        {
          id: 'at1',
          attemptNumber: 1,
          technicianName: 'Minh',
          technicianPhone: '0909000222',
          acceptedByName: 'Minh',
          acceptedAt: '2026-09-19T01:10:00.000Z',
          outcome: 'CANNOT_REPAIR',
          outcomeAt: '2026-09-19T01:40:00.000Z',
          reason: 'Thiếu phụ tùng',
          durationSeconds: 1800,
          durationLabel: '30 phút',
        },
      ],
    },
  },
};

const COMPLAINT = {
  ...BASE,
  id: 'c1',
  category: 'CUSTOMER_COMPLAINT',
  categoryLabel: 'Vấn đề về chất lượng và dịch vụ',
  summary: 'Trần Complain · Phòng ồn suốt đêm',
  complaint: {
    guestName: 'Trần Complain',
    ezCode: 'EZ202',
    description: 'Phòng ồn suốt đêm',
    location: null,
    completed: false,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    completedShiftType: null,
    completedShiftName: null,
    resolution: null,
  },
};

const SERVICE = {
  ...BASE,
  id: 'v1',
  category: 'ROOM_SERVICE',
  categoryLabel: 'Dịch vụ phòng, KPI',
  summary: 'Upgrade · Lê Upgrade · 300.000 ₫',
  roomService: {
    serviceType: 'UPGRADE',
    serviceTypeLabel: 'Upgrade',
    guestName: 'Lê Upgrade',
    ezCode: 'EZ900',
    phone: null,
    roomNumber: null,
    roomClass: null,
    fromRoomClass: 'Standard',
    toRoomClass: 'Deluxe',
    nights: 2,
    serviceName: null,
    price: 300000,
    note: 'Khách đồng ý',
  },
};

const LAUNDRY = {
  ...BASE,
  id: 'v2',
  category: 'ROOM_SERVICE',
  categoryLabel: 'Dịch vụ phòng, KPI',
  summary: 'Giặt ủi · Phạm Giặt · 120.000 ₫',
  roomService: {
    serviceType: 'LAUNDRY',
    serviceTypeLabel: 'Giặt ủi',
    guestName: 'Phạm Giặt',
    ezCode: null,
    phone: null,
    roomNumber: '305',
    roomClass: null,
    fromRoomClass: null,
    toRoomClass: null,
    nights: null,
    serviceName: null,
    price: 120000,
    note: null,
  },
};

const ALL = [PAYMENT, REQUEST, FACILITY, COMPLAINT, SERVICE];

const CASH = {
  openingCash: 7570000,
  cashCollected: 300000,
  transferCollected: 0,
  cardCollected: 0,
  receivable: 50000,
  cashExpense: 100000,
  endingCash: 7770000,
  paymentCount: 1,
  voidedCount: 0,
};

/** With no period chosen the drawer is TODAY's, and the response says so. */
const CASH_PERIOD = { from: '2026-09-19', to: '2026-09-19' };

const OPEN_SHIFT_WARNING = 'Ca chưa kết thúc chưa được đưa vào báo cáo chính thức.';

const COUNTS = {
  PAYMENT: 1,
  GUEST_REQUEST: 1,
  FACILITY_ISSUE: 1,
  CUSTOMER_COMPLAINT: 1,
  ROOM_SERVICE: 2,
};

function body(reports: unknown[], over: Record<string, unknown> = {}) {
  return {
    reports,
    counts: COUNTS,
    cash: CASH,
    cashPeriod: CASH_PERIOD,
    total: reports.length,
    truncated: false,
    openShifts: [],
    openShiftWarning: OPEN_SHIFT_WARNING,
    ...over,
  };
}

function shellRoutes(
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return {
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
    'GET /api/admin/branches': () => ({ status: 200, body: { branches: BRANCHES } }),
    'GET /api/reception/reports/options': () => ({ status: 200, body: OPTIONS }),
    [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({ status: 200, body: body(ALL) }),
    [`GET /api/admin/reports/operational?branchId=13&${PERIOD}`]: () => ({ status: 200, body: body([]) }),
    [`GET /api/admin/reports/operational?branchId=11&category=PAYMENT&${PERIOD}`]: () => ({
      status: 200,
      body: body([PAYMENT]),
    }),
    [`GET /api/admin/reports/operational?branchId=11&category=GUEST_REQUEST&${PERIOD}`]: () => ({
      status: 200,
      body: body([REQUEST]),
    }),
    [`GET /api/admin/reports/operational?branchId=11&category=FACILITY_ISSUE&${PERIOD}`]: () => ({
      status: 200,
      body: body([FACILITY]),
    }),
    [`GET /api/admin/reports/operational?branchId=11&category=CUSTOMER_COMPLAINT&${PERIOD}`]: () => ({
      status: 200,
      body: body([COMPLAINT]),
    }),
    [`GET /api/admin/reports/operational?branchId=11&category=ROOM_SERVICE&${PERIOD}`]: () => ({
      status: 200,
      body: body([SERVICE, LAUNDRY]),
    }),
    ...extra,
  };
}

/**
 * THE INCIDENT ITSELF, as `/api/issues` returns it — what the Admin's "Sự cố vật
 * chất đang xử lý" tab now lists. The same HotelIssue the journal entry above
 * references, with who reported it and where.
 */
const ISSUE = {
  ...FACILITY.facility.issue,
  branchId: 11,
  branch: BRANCHES[0],
  areaCategory: 'LOBBY',
  reportedByName: 'Nguyễn Văn A',
  createdAt: '2026-09-19T01:00:00.000Z',
};

const ISSUES_TODAY = `GET /api/issues?branchId=11&from=${TODAY}&to=${TODAY}&pageSize=100`;

const INCIDENT_SUMMARY = {
  total: 1,
  newCount: 0,
  inProgressCount: 1,
  completedCount: 0,
  cannotRepairAttempts: 1,
  needsReworkIssues: 0,
  outstandingTotal: 4,
};

/** The incident tab's two reads, for branch 11 and today. */
function incidentRoutes(issues: unknown[] = [ISSUE]) {
  return {
    [ISSUES_TODAY]: () => ({
      status: 200,
      body: { issues, pagination: { page: 1, pageSize: 100, total: issues.length, totalPages: 1 } },
    }),
    [`GET /api/admin/reports/incidents/summary?${PERIOD}&branchId=11`]: () => ({
      status: 200,
      body: { range: { from: TODAY, to: TODAY }, summary: INCIDENT_SUMMARY },
    }),
  };
}

/** Choose a branch the way an Admin does now: one control, one choice. */
async function chooseBranch(id = '11') {
  await userEvent.selectOptions(await screen.findByTestId('branch-select'), id);
}

async function openCategory(code: string) {
  await userEvent.click(await screen.findByTestId(`admin-category-${code}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('choosing a branch', () => {
  it('offers every branch the database returns, from ONE control', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');

    const select = await screen.findByTestId('branch-select');
    // One combobox, named — not eight tiles taking a third of the screen.
    expect(select).toHaveAccessibleName('Chi nhánh');
    const options = within(select).getAllByRole('option');
    // Nine branches, plus "choose one" and "every branch". A hardcoded list of
    // the eight properties the business has today would fail this.
    expect(options).toHaveLength(11);
    expect(options[1]).toHaveTextContent('Tất cả chi nhánh');
    expect(options[2]).toHaveTextContent('05 Trương Định');
    expect(options[10]).toHaveTextContent('09 Ngô Đức Kế');
    // Addressed by the branch's own id, whatever that happens to be.
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      '',
      'ALL',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
    ]);
  });

  it('asks for a branch before showing anything', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    expect(await screen.findByText('Chọn một chi nhánh')).toBeInTheDocument();
  });

  it('loads the branch that was chosen, by its id', async () => {
    const fetchMock = installApiMock(shellRoutes());
    renderApp('/app/reports');

    await chooseBranch('13');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/admin/reports/operational?branchId=13'),
        ),
      ).toBe(true),
    );
  });

  it('shows the five categories with their counts, in the server’s words', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');

    await chooseBranch();
    const menu = await screen.findByTestId('admin-category-menu');
    // "Tất cả" plus the five.
    expect(within(menu).getAllByRole('button')).toHaveLength(6);
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Tất cả',
      'Theo dõi thanh toán1',
      'Vấn đề khách yêu cầu1',
      // No count: this tab lists the incidents themselves, not journal entries,
      // so a journal count on it would describe something else.
      'Sự cố vật chất đang xử lý',
      'Vấn đề về chất lượng và dịch vụ1',
      'Dịch vụ phòng, KPI2',
    ]);
  });

  it('never offers KPI as a category of its own', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');

    await chooseBranch();
    const menu = await screen.findByTestId('admin-category-menu');
    const labels = within(menu).getAllByRole('button').map((b) => b.textContent);
    expect(labels.filter((l) => l === 'KPI')).toHaveLength(0);
    expect(labels.some((l) => l?.startsWith('Dịch vụ phòng, KPI'))).toBe(true);
  });
});

describe('each category is a table', () => {
  it('lays the payments out as a ledger, with the shift that took them', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    const table = await screen.findByTestId('admin-table-PAYMENT');
    // Titled with the SERVER's word for the category.
    // The category is the chosen tab, in the server's word; the table's own
    // heading is the SHIFT and the PERSON — DATE → SHIFT → EMPLOYEE.
    expect(screen.getByTestId('admin-category-PAYMENT')).toHaveTextContent('Theo dõi thanh toán');
    expect(within(table).getByRole('heading')).toHaveTextContent('Ca A · 06:00 – 14:00 · Nguyễn Văn A');

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    // The first is the expander's own column, which carries no label.
    expect(headers[0]).toBe('');
    // No "Nhân viên" or "Ca" column: the heading above states both, once,
    // rather than every row repeating them.
    expect(headers.slice(1)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Nguồn',
      'Phương thức',
      // The headline figure, kept primary so a phone still shows an amount.
      'Số tiền',
      'Tiền mặt',
      'Thu CK',
      'Cà thẻ',
      'Công nợ',
      'Chi',
      // Reception no longer asks for a room; the Admin still shows an older one.
      'Phòng',
      'Thời gian',
      'Trạng thái',
    ]);

    const row = within(table).getByTestId('row-p1');
    expect(within(row).queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
    expect(within(row).getByText('EZ123')).toBeInTheDocument();
    expect(within(row).getByText('Booking.com')).toBeInTheDocument();
    expect(within(row).getByText('Nguyễn Khách')).toBeInTheDocument();
    // Twice over: once as Số tiền, once in the per-method split.
    expect(within(row).getAllByText('300.000 ₫')).toHaveLength(2);
  });

  it('lays the guest requests out with both actors', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('GUEST_REQUEST');

    const table = await screen.findByTestId('admin-table-GUEST_REQUEST');
    expect(screen.getByTestId('admin-category-GUEST_REQUEST')).toHaveTextContent('Vấn đề khách yêu cầu');
    expect(within(table).getByRole('heading')).toHaveTextContent('Ca A · 06:00 – 14:00 · Nguyễn Văn A');

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(1)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Nội dung',
      'Thời gian tiếp nhận',
      'Thời gian hoàn thành',
      'Cách xử lý (nếu có)',
      'Trạng thái',
      'Bản ghi',
    ]);
    // "Ký gửi" and "Số phòng" are not columns any more…
    expect(headers).not.toContain('Ký gửi');
    expect(headers).not.toContain('Số phòng');

    const row = within(table).getByTestId('row-g1');
    // …but an older request's "Ký gửi" still reads, as part of its content.
    expect(within(row).getByText('Balo — Balo đen')).toBeInTheDocument();
    expect(within(row).getByText('Khách ký gửi')).toBeInTheDocument();
    expect(within(row).getByText('EZ305')).toBeInTheDocument();
    expect(within(row).getByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(row).getByText('Đã trả balo cho khách')).toBeInTheDocument();
    // Who took it, and who completed it — two facts, never one overwriting the
    // other. The taker is the shift's person, named once in the heading; the
    // completer, on another shift, is in the row.
    expect(within(table).getByRole('heading')).toHaveTextContent('Nguyễn Văn A');
    expect(within(row).getByText('Nguyễn Văn B · Ca B')).toBeInTheDocument();
  });

  /**
   * THE OLD "SỰ CỐ KHÁCH SẠN" SCREEN LIVES HERE NOW: the HotelIssue rows
   * themselves, from the same `/api/issues` the technical department works.
   */
  it('monitors the incidents — status, technician and how the last attempt ended', async () => {
    const fetchMock = installApiMock(shellRoutes(incidentRoutes()));
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('FACILITY_ISSUE');

    const view = await screen.findByTestId('admin-incident-view');
    expect(screen.getByTestId('admin-category-FACILITY_ISSUE')).toHaveTextContent('Sự cố vật chất đang xử lý');
    // The period's counts, as the old screen had them.
    expect(await within(view).findByTestId('incident-range-summary')).toHaveTextContent('Tổng sự cố phát sinh');

    const table = within(view).getByTestId('admin-incident-table');
    const row = await within(table).findByTestId(`row-${ISSUE.id}`);
    expect(within(row).getByText('Khu Vực Sảnh · Sofa')).toBeInTheDocument();
    expect(within(row).getByText('Sofa rách')).toBeInTheDocument();
    expect(within(row).getByText('Đang sửa')).toBeInTheDocument();
    expect(within(row).getByText('Bảo')).toBeInTheDocument();
    expect(within(row).getByText('Nguyễn Văn A')).toBeInTheDocument();
    // The last attempt's own outcome, in the technical workflow's own words.
    expect(within(row).getByText(/Không sửa được/)).toBeInTheDocument();
    expect(within(row).getByText(/30 phút/)).toBeInTheDocument();

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    for (const h of ['Sự cố', 'Khu vực', 'Người báo', 'Thời gian', 'Trạng thái', 'Kỹ thuật', 'Kết quả gần nhất', 'Lần sửa', 'Cập nhật']) {
      expect(headers).toContain(h);
    }
    // One branch on screen: no branch column.
    expect(headers).not.toContain('Chi nhánh');

    // Scoped by the SERVER to the page's branch and period.
    expect(fetchMock.mock.calls.some(([url]) => `GET ${String(url)}` === ISSUES_TODAY)).toBe(true);

    // And it is a MONITOR: nothing here offers to create or pick an incident.
    expect(screen.queryByTestId('facility-form')).not.toBeInTheDocument();
    expect(screen.queryByText(/chọn sự cố/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-cash-panel')).not.toBeInTheDocument();
  });

  it('opens an incident into its repair history, at desktop width', async () => {
    installApiMock(shellRoutes(incidentRoutes()));
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('FACILITY_ISSUE');

    const toggle = await screen.findByTestId(`row-toggle-${ISSUE.id}`);
    expect(toggle.closest('td')!.className).not.toMatch(/\bmd:hidden\b/);
    await userEvent.click(toggle);
    expect(await screen.findByText('Lịch sử xử lý')).toBeInTheDocument();
    expect(screen.getByText(/Thiếu phụ tùng/)).toBeInTheDocument();
  });

  it('switches to every incident still open, whatever day it was reported', async () => {
    const fetchMock = installApiMock(
      shellRoutes({
        ...incidentRoutes(),
        'GET /api/issues?branchId=11&pageSize=100&outstanding=true': () => ({
          status: 200,
          body: { issues: [ISSUE], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('FACILITY_ISSUE');

    await userEvent.click(await screen.findByTestId('admin-incident-outstanding'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url) === '/api/issues?branchId=11&pageSize=100&outstanding=true',
        ),
      ).toBe(true),
    );
    // "Tồn đọng" has no period, so the period's counts step aside.
    await waitFor(() => expect(screen.queryByTestId('incident-range-summary')).not.toBeInTheDocument());
  });

  it('exports the incident report for the same branch and period', async () => {
    installApiMock(shellRoutes(incidentRoutes()));
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('FACILITY_ISSUE');
    await screen.findByTestId('admin-incident-view');

    await userEvent.click(screen.getByTestId('operational-export-open'));
    const dialog = await screen.findByRole('dialog');
    // The incident export, not the journal's.
    expect(within(dialog).queryByTestId('operational-export-pdf')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(/sự cố/i);
  });

  it('lays the service-quality records out with the full text one click away', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('CUSTOMER_COMPLAINT');

    const table = await screen.findByTestId('admin-table-CUSTOMER_COMPLAINT');
    expect(screen.getByTestId('admin-category-CUSTOMER_COMPLAINT')).toHaveTextContent(
      'Vấn đề về chất lượng và dịch vụ',
    );
    expect(within(table).getByRole('heading')).toHaveTextContent('Ca A · 06:00 – 14:00 · Nguyễn Văn A');

    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(1)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Mô tả',
      'Trạng thái',
      'Hướng xử lý (nếu có)',
      'Thời gian',
      'Bản ghi',
    ]);
    expect(headers).not.toContain('Số phòng / Khác');

    const row = within(table).getByTestId('row-c1');
    expect(within(row).getByText('Trần Complain')).toBeInTheDocument();
    expect(within(row).getByText('EZ202')).toBeInTheDocument();
    expect(within(row).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
    expect(within(row).getByText('Đã tiếp nhận')).toBeInTheDocument();
  });

  it('gives each room-service subtype its own table and its own columns', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('ROOM_SERVICE');

    const upgrade = await screen.findByTestId('admin-table-ROOM_SERVICE-UPGRADE');
    expect(within(upgrade).getByRole('heading')).toHaveTextContent('Upgrade');
    const upgradeHeaders = within(upgrade).getAllByRole('columnheader').map((h) => h.textContent);
    expect(upgradeHeaders.slice(1)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Từ hạng phòng',
      'Tới hạng phòng',
      'Số đêm',
      'Giá tiền',
      'Thời gian',
      'Ghi chú',
      'Trạng thái',
    ]);
    expect(within(upgrade).getByText('Standard')).toBeInTheDocument();
    expect(within(upgrade).getByText('Deluxe')).toBeInTheDocument();
    expect(within(upgrade).getByText('EZ900')).toBeInTheDocument();

    const laundry = screen.getByTestId('admin-table-ROOM_SERVICE-LAUNDRY');
    const laundryHeaders = within(laundry).getAllByRole('columnheader').map((h) => h.textContent);
    expect(laundryHeaders.slice(1)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Giá tiền', 'Thời gian', 'Ghi chú', 'Trạng thái']);
    expect(within(laundry).getByText('Phạm Giặt')).toBeInTheDocument();
    // The room an older laundry row recorded is not a column; it is in the full record.
    await userEvent.click(within(laundry).getByTestId('row-toggle-v2'));
    expect(await within(laundry).findByText('Số phòng (dữ liệu cũ)')).toBeInTheDocument();

    // A subtype with no records gets no empty table of its own — that whitespace
    // is what this redesign removed.
    expect(screen.queryByTestId('admin-table-ROOM_SERVICE-SMOKING')).not.toBeInTheDocument();
  });

  it('totals the room service by subtype, from the rows on screen', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('ROOM_SERVICE');

    const summary = await screen.findByTestId('room-service-summary');
    /*
      Named for what it actually adds up. The server caps this list at 500 rows,
      so "của chi nhánh" would be a claim about the branch's whole takings that
      the figure cannot back.
    */
    expect(within(summary).getByRole('heading')).toHaveTextContent('trong danh sách đang xem');
    expect(within(summary).getByTestId('service-total-UPGRADE')).toHaveTextContent('300.000');
    expect(within(summary).getByTestId('service-total-LAUNDRY')).toHaveTextContent('120.000');
    expect(screen.getByTestId('service-grand-total')).toHaveTextContent('420.000');
  });

  it('puts every category in one chronological table under "Tất cả"', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();

    const table = await screen.findByTestId('admin-table-ALL');
    for (const id of ['p1', 'g1', 'f1', 'c1', 'v1']) {
      expect(within(table).getByTestId(`row-${id}`)).toBeInTheDocument();
    }
    // A mixed table is unreadable unless each row says what it is.
    expect(within(table).getByTestId('row-p1')).toHaveTextContent('Theo dõi thanh toán');
    expect(within(table).getByTestId('row-c1')).toHaveTextContent('Vấn đề về chất lượng và dịch vụ');
    // And the one figure a record carries, where it carries one.
    expect(within(table).getByTestId('row-p1')).toHaveTextContent('300.000 ₫');
    expect(within(table).getByTestId('row-v1')).toHaveTextContent('300.000 ₫');
  });

  it('says so, in the table, when a category has nothing', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&category=PAYMENT&${PERIOD}`]: () => ({
          status: 200,
          body: body([]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    expect(await screen.findByTestId('admin-table-PAYMENT-empty')).toBeInTheDocument();
    expect(screen.getByTestId('admin-table-PAYMENT-empty')).toHaveTextContent('Không có giao dịch');
  });
});

describe('the record is one click under the row', () => {
  it('opens a row into the full record, and closes it again', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    await screen.findByTestId('row-p1');
    expect(screen.queryByTestId('record-detail-p1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('row-toggle-p1'));
    const detail = await screen.findByTestId('record-detail-p1');
    // EVERY field survives — the compact row did not cost the record.
    expect(within(detail).getByText('EZ123')).toBeInTheDocument();
    expect(within(detail).getByText('Booking.com')).toBeInTheDocument();
    expect(within(detail).getByText('101')).toBeInTheDocument();
    expect(within(detail).getByText('50.000 ₫')).toBeInTheDocument();
    expect(within(detail).getByText('100.000 ₫')).toBeInTheDocument();
    expect(within(detail).getByText('Thanh toán đêm đầu')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('row-toggle-p1'));
    expect(screen.queryByTestId('record-detail-p1')).not.toBeInTheDocument();
  });

  /**
   * THE EXPANDER MUST EXIST WHERE THE ADMIN IS.
   *
   * jsdom applies no Tailwind, so a toggle hidden by `md:hidden` is findable in
   * every test and unreachable on every desktop. That is precisely how "the
   * detail is one click away" could be green here and false in the browser.
   */
  it('offers the expander at desktop width, not only on a phone', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    const cell = (await screen.findByTestId('row-toggle-p1')).closest('td');
    expect(cell).not.toBeNull();
    expect(cell!.className).not.toMatch(/\bmd:hidden\b/);
  });

  it('holds two records open at once, because that is how they get compared', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();

    await userEvent.click(await screen.findByTestId('row-toggle-p1'));
    await userEvent.click(screen.getByTestId('row-toggle-c1'));

    expect(await screen.findByTestId('record-detail-p1')).toBeInTheDocument();
    expect(screen.getByTestId('record-detail-c1')).toBeInTheDocument();
  });

  /**
   * EVERY table, not just the one that happened to get a test.
   *
   * `renderDetail` is passed once, through a shared object — so a table that
   * lost it would still show a chevron (its secondary columns keep the column
   * alive) and would open onto an empty strip at desktop width. Only opening a
   * row in each category catches that.
   */
  // FACILITY_ISSUE lists incidents, not journal entries — its expander is
  // covered under "each category is a table".
  it.each([
    ['PAYMENT', 'p1'],
    ['GUEST_REQUEST', 'g1'],
    ['CUSTOMER_COMPLAINT', 'c1'],
    ['ROOM_SERVICE', 'v1'],
  ])('opens the full record from the %s table', async (code, id) => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory(code);

    await userEvent.click(await screen.findByTestId(`row-toggle-${id}`));
    const detail = await screen.findByTestId(`record-detail-${id}`);
    // The shift context every record carries, whatever its category.
    expect(within(detail).getByText('Nguyễn Văn A')).toBeInTheDocument();
  });

  it('carries the correction history down with the record', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    await userEvent.click(await screen.findByTestId('row-toggle-p1'));
    const audits = await screen.findByTestId('record-audits-p1');
    expect(audits).toHaveTextContent('3000000 → 300000');
    expect(audits).toHaveTextContent('Thừa một số 0');
  });

  /**
   * A corrected figure must be visible WITHOUT opening anything: an Admin
   * scanning a branch for a disputed number never opens the row that would have
   * told them it had been edited.
   */
  it('marks a corrected record in the row itself', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    const row = await screen.findByTestId('row-p1');
    expect(within(row).getByTestId('admin-status-p1')).toHaveTextContent('Đã sửa');
  });
});

describe('money', () => {
  it('right-aligns the amounts and formats them', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    const row = await screen.findByTestId('row-p1');
    for (const cell of within(row).getAllByText('300.000 ₫')) {
      expect(cell.closest('td')!.className).toMatch(/text-right/);
      expect(cell.closest('td')!.className).toMatch(/tabular-nums/);
    }
  });

  it('shows an absent figure as "—" and never as "0 ₫"', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    const row = await screen.findByTestId('row-p1');
    // This payment was cash: transfer and card are zero, not "0 ₫".
    expect(within(row).queryByText('0 ₫')).not.toBeInTheDocument();
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('a voided record', () => {
  it('stays on screen, marked, and out of the total', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&category=ROOM_SERVICE&${PERIOD}`]: () => ({
          status: 200,
          body: body([SERVICE, { ...SERVICE, id: 'v9', voided: true, voidReason: 'Nhập nhầm' }]),
        }),
        [`GET /api/admin/reports/operational?branchId=11&category=PAYMENT&${PERIOD}`]: () => ({
          status: 200,
          body: body([PAYMENT, VOIDED_PAYMENT]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');

    // Never removed…
    const row = await screen.findByTestId('row-p2');
    expect(within(row).getByText('Khách Hủy')).toBeInTheDocument();
    // …and marked as withdrawn.
    expect(within(row).getByTestId('admin-status-p2')).toHaveTextContent('Đã hủy');
    expect(row.className).toMatch(/text-slate-400/);

    // The same rule in a total: two upgrades on screen, one of them withdrawn,
    // and the total counts one.
    await openCategory('ROOM_SERVICE');
    const total = await screen.findByTestId('admin-table-ROOM_SERVICE-UPGRADE-total');
    expect(total).toHaveTextContent('1 bản ghi tính vào tổng');
    expect(total).toHaveTextContent('1 đã hủy');
    expect(total).toHaveTextContent('300.000 ₫');
  });
});

/**
 * The incident's status and the JOURNAL ENTRY's status are different facts, and
 * the facility table shows both — it was briefly the one table where a
 * withdrawn record was indistinguishable from a live one.
 */
describe('a withdrawn facility record', () => {
  it('is marked as withdrawn without touching the incident’s own status', async () => {
    installApiMock(
      shellRoutes({
        ...incidentRoutes(),
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({
          status: 200,
          body: body([{ ...FACILITY, id: 'f9', voided: true, voidReason: 'Ghi nhầm sự cố' }]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    // The JOURNAL ENTRY is withdrawn, and says so…
    const row = await screen.findByTestId('row-f9');
    expect(within(row).getByTestId('admin-status-f9')).toHaveTextContent('Đã hủy');

    // …while the incident itself is still whatever the technician says it is.
    await openCategory('FACILITY_ISSUE');
    const incident = await screen.findByTestId(`row-${ISSUE.id}`);
    expect(within(incident).getByText('Đang sửa')).toBeInTheDocument();
  });
});

describe('a cash outflow', () => {
  /**
   * "Chi tiền mặt" is recorded with amount 0 and expense set. Reading `amount`
   * alone printed "—" against a real two-million-đồng outflow — a term of the
   * cash formula, shown on the branch's primary table carrying no figure.
   */
  it('shows its figure, signed, in the "Tất cả" table', async () => {
    const EXPENSE = {
      ...PAYMENT,
      id: 'p3',
      summary: 'Chi tiền mặt · mua nước',
      audits: [],
      payment: { ...PAYMENT.payment, amount: 0, cash: 0, receivable: 0, expense: 2000000 },
    };
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({ status: 200, body: body([EXPENSE]) }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const row = await screen.findByTestId('row-p3');
    expect(within(row).getByText('−2.000.000 ₫')).toBeInTheDocument();
  });
});

describe('an empty room-service category', () => {
  it('names the category, not one of its subtypes', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&category=ROOM_SERVICE&${PERIOD}`]: () => ({
          status: 200,
          body: body([]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('ROOM_SERVICE');

    // "Không có bán phòng" would say the branch sold no rooms, when what it
    // recorded is no services of any kind.
    const table = await screen.findByTestId('admin-table-ROOM_SERVICE-ROOM_SALE');
    expect(within(table).getByRole('heading')).toHaveTextContent('Dịch vụ phòng, KPI');
    expect(screen.getByTestId('admin-table-ROOM_SERVICE-ROOM_SALE-empty')).toHaveTextContent(
      'Không có dịch vụ phòng, kpi',
    );
  });
});

describe('the row cap is declared, never silent', () => {
  it('says nothing when everything fits', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('row-p1');
    expect(screen.queryByTestId('operational-truncated')).not.toBeInTheDocument();
  });

  it('names the true total once, above the tables, and keeps the real counts on the tabs', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({
          status: 200,
          body: body(ALL, { counts: { ...COUNTS, PAYMENT: 1496 }, total: 1500, truncated: true }),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const notices = await screen.findAllByTestId('operational-truncated');
    // Once for the page, not once per table.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent('trong tổng số 1500');
    expect(notices[0]).toHaveTextContent('xuất báo cáo');
    // The counts on the tabs are the branch's real ones, not the page's.
    expect(screen.getByTestId('admin-category-PAYMENT')).toHaveTextContent('1496');
  });
});

describe('deliberately few controls', () => {
  it('has no employee, status or source filter — the branch is the only select', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('admin-category-menu');

    for (const absent of [/nhân viên:/i, /trạng thái:/i, /nguồn:/i]) {
      expect(screen.queryByLabelText(absent)).not.toBeInTheDocument();
    }
    // Exactly one combobox on the page, and it is the branch picker.
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(1);
    expect(selects[0]).toHaveAccessibleName('Chi nhánh');
  });

  /**
   * IN EVERY CATEGORY, AND WITH THE RECORD OPEN.
   *
   * Checking one table with every row closed leaves two ways for a write
   * control to reappear unnoticed: on another category's table, or inside the
   * expanded record (which takes an `actions` node of its own). Both are walked
   * here — a "Tiếp nhận" button in particular only exists where guest requests
   * are rendered, so asserting its absence over the payment table proves
   * nothing at all.
   */
  it.each([
    ['ALL', 'p1'],
    ['PAYMENT', 'p1'],
    ['GUEST_REQUEST', 'g1'],
    ['FACILITY_ISSUE', ISSUE.id],
    ['CUSTOMER_COMPLAINT', 'c1'],
    ['ROOM_SERVICE', 'v1'],
  ])('gives the Admin no writing controls in the %s view, open or closed', async (code, id) => {
    installApiMock(shellRoutes(incidentRoutes()));
    renderApp('/app/reports');
    await chooseBranch();
    if (code !== 'ALL') await openCategory(code);
    await screen.findByTestId(`row-${id}`);

    const assertReadOnly = () => {
      // No action column at all — not an empty one.
      expect(screen.queryByRole('columnheader', { name: 'Thao tác' })).not.toBeInTheDocument();
      for (const testId of [
        'payment-form',
        'opening-cash-edit',
        'opening-cash-save',
        `void-${id}`,
        `edit-${id}`,
        `accept-${id}`,
        `payment-edit-${id}`,
        `payment-void-${id}`,
      ]) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
      // The reception and technician verbs, by name, anywhere on the page.
      for (const label of [
        /^Sửa$/,
        /^Hủy$/,
        /^Xóa$/,
        /^Tiếp nhận$/,
        /^Thêm$/,
        /^Lưu$/,
        /^Hoàn thành$/,
        /^Không sửa được$/,
        /Báo cáo sự cố/,
      ]) {
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      }
    };

    assertReadOnly();
    await userEvent.click(screen.getByTestId(`row-toggle-${id}`));
    if (code === 'FACILITY_ISSUE') await screen.findByText('Lịch sử xử lý');
    else await screen.findByTestId(`record-detail-${id}`);
    assertReadOnly();
  });
});

describe('the drawer', () => {
  it('shows all seven figures and NAMES the period they cover', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();

    const panel = await screen.findByTestId('admin-cash-panel');
    for (const line of [
      'Tiền đầu ca',
      'Thu tiền mặt',
      'Chuyển khoản',
      'Cà thẻ',
      'Công nợ',
      'Chi tiền mặt',
      'Tiền cuối ca',
    ]) {
      expect(within(panel).getByText(line)).toBeInTheDocument();
    }
    expect(panel).toHaveTextContent('7.570.000 ₫');
    expect(panel).toHaveTextContent('7.770.000 ₫');
    /*
      An unlabelled cash figure beside an unfiltered record list reads as "the
      cash position", and there is no such number — a drawer belongs to a shift
      on a day. The panel says which day.
    */
    expect(within(panel).getByTestId('admin-cash-period')).toHaveTextContent(
      'Tiền mặt ngày 19/09/2026',
    );
  });

  it('distinguishes an uncounted drawer from an empty one', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({
          status: 200,
          body: body(ALL, { cash: { ...CASH, openingCash: null, endingCash: null } }),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const panel = await screen.findByTestId('admin-cash-panel');
    expect(within(panel).getByText('Chưa kiểm đếm')).toBeInTheDocument();
    expect(within(panel).getByText('Chưa xác định')).toBeInTheDocument();
  });

  it('is shown where money is the subject, and not over a list of complaints', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('admin-cash-panel');

    await openCategory('CUSTOMER_COMPLAINT');
    await screen.findByTestId('admin-table-CUSTOMER_COMPLAINT');
    expect(screen.queryByTestId('admin-cash-panel')).not.toBeInTheDocument();
  });
});


/* ================== V3.1 — the period, the shift, the export scope ================== */

/** A record on its own shift, for the grouping fixtures. */
function onShift(
  id: string,
  over: {
    shiftDate: string;
    session: string;
    shiftName: string;
    shiftWindow: string;
    employee: string;
    createdAt: string;
    branch?: (typeof BRANCHES)[number];
  },
) {
  return {
    ...COMPLAINT,
    id,
    shiftSessionId: over.session,
    shiftName: over.shiftName,
    shiftWindow: over.shiftWindow,
    shiftDate: over.shiftDate,
    shiftReceptionistName: over.employee,
    createdByName: over.employee,
    createdAt: over.createdAt,
    branchId: (over.branch ?? BRANCHES[0]!).id,
    branch: over.branch ?? BRANCHES[0],
    summary: `${over.employee} · ${id}`,
    complaint: { ...COMPLAINT.complaint, guestName: `Khách ${id}`, description: `Mô tả ${id}` },
  };
}

const TWO_DAYS = [
  // Deliberately out of order: the page must sort, not trust arrival order.
  onShift('x3', {
    shiftDate: '2026-09-20',
    session: 's3',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    employee: 'Lê Văn C',
    createdAt: '2026-09-20T01:00:00.000Z',
  }),
  onShift('x2', {
    shiftDate: '2026-09-19',
    session: 's2',
    shiftName: 'Ca B',
    shiftWindow: '14:00 – 22:00',
    employee: 'Trần Thị B',
    createdAt: '2026-09-19T08:00:00.000Z',
  }),
  onShift('x1', {
    shiftDate: '2026-09-19',
    session: 's1',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    employee: 'Nguyễn Văn A',
    createdAt: '2026-09-19T01:00:00.000Z',
  }),
];

describe('DATE → SHIFT → EMPLOYEE', () => {
  it('lays the records out by day, then by shift, each shift naming its person', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({ status: 200, body: body(TWO_DAYS) }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const day19 = await screen.findByTestId('date-group-2026-09-19');
    const day20 = screen.getByTestId('date-group-2026-09-20');
    // Days in order, whatever order the rows arrived in.
    expect(day19.compareDocumentPosition(day20) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Two shifts on the 19th, in the order they began, each its own table.
    const shifts = within(day19).getAllByTestId(/^shift-group-/);
    expect(shifts).toHaveLength(2);
    expect(within(shifts[0]!).getByRole('heading')).toHaveTextContent('Ca A · 06:00 – 14:00 · Nguyễn Văn A');
    expect(within(shifts[1]!).getByRole('heading')).toHaveTextContent('Ca B · 14:00 – 22:00 · Trần Thị B');
    // Each shift holds only its own records.
    expect(within(shifts[0]!).getByTestId('row-x1')).toBeInTheDocument();
    expect(within(shifts[0]!).queryByTestId('row-x2')).not.toBeInTheDocument();

    expect(within(day20).getByRole('heading', { name: /Ca A · 06:00 – 14:00 · Lê Văn C/ })).toBeInTheDocument();
  });

  /**
   * THE DAY IS THE SERVER'S, NOT THE TIMESTAMP'S.
   *
   * 02:15 on the 20th, on Ca C of the 19th. Grouping by `createdAt` would file
   * it under the 20th and split one night's shift across two dates.
   */
  it('keeps a Ca C entry made after midnight under the day the shift began', async () => {
    const late = onShift('late', {
      shiftDate: '2026-09-19',
      session: 'sC',
      shiftName: 'Ca C',
      shiftWindow: '22:00 – 06:00',
      employee: 'Người Ca Đêm',
      // 02:15 in Ho Chi Minh City on the 20th.
      createdAt: '2026-09-19T19:15:00.000Z',
    });
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({ status: 200, body: body([late]) }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const day = await screen.findByTestId('date-group-2026-09-19');
    expect(within(day).getByTestId('row-late')).toBeInTheDocument();
    expect(screen.queryByTestId('date-group-2026-09-20')).not.toBeInTheDocument();
  });

  it('names the branch on each shift when every branch is on screen', async () => {
    const elsewhere = onShift('y1', {
      shiftDate: '2026-09-19',
      session: 's9',
      shiftName: 'Ca A',
      shiftWindow: '06:00 – 14:00',
      employee: 'Người CN2',
      createdAt: '2026-09-19T02:00:00.000Z',
      branch: BRANCHES[1],
    });
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?${PERIOD}`]: () => ({
          status: 200,
          body: body([elsewhere], { cash: null, cashPeriod: null }),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch('ALL');

    // CHI NHÁNH → NGÀY → CA: the branch heads its own block.
    const branch = await screen.findByTestId('branch-group-12');
    expect(within(branch).getByRole('heading', { level: 2 })).toHaveTextContent('Chi nhánh 2 · 260 Lý Tự Trọng');
    const group = within(branch).getByTestId('shift-group-12|2026-09-19|s9');
    expect(within(group).getByRole('heading')).toHaveTextContent('Ca A · 06:00 – 14:00 · Người CN2');
    // Eight drawers added together describe no drawer at all.
    expect(screen.queryByTestId('admin-cash-panel')).not.toBeInTheDocument();
  });

  it('keeps the branches apart, in branch order, each with its own days and shifts', async () => {
    const at = (id: string, branch: (typeof BRANCHES)[number], session: string) =>
      onShift(id, {
        shiftDate: '2026-09-19',
        session,
        shiftName: 'Ca A',
        shiftWindow: '06:00 – 14:00',
        employee: `Người ${id}`,
        createdAt: '2026-09-19T02:00:00.000Z',
        branch,
      });
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?${PERIOD}`]: () => ({
          status: 200,
          // Branch 3 first on the wire: the page sorts by branch number.
          body: body([at('b3', BRANCHES[2]!, 's30'), at('b1', BRANCHES[0]!, 's10')], { cash: null, cashPeriod: null }),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch('ALL');

    const first = await screen.findByTestId('branch-group-11');
    const third = screen.getByTestId('branch-group-13');
    expect(first.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each branch holds only its own records.
    expect(within(first).getByTestId('row-b1')).toBeInTheDocument();
    expect(within(first).queryByTestId('row-b3')).not.toBeInTheDocument();
    expect(within(third).getByTestId('row-b3')).toBeInTheDocument();
    // The branch heads its block, so no row repeats it in a column of its own.
    for (const h of ['Chi nhánh', 'Nhân viên', 'Ca']) {
      expect(within(first).queryByRole('columnheader', { name: h })).not.toBeInTheDocument();
    }
  });

  it('counts each shift’s records by category, beside the shift', async () => {
    const pay = { ...PAYMENT, id: 'sp1' };
    const pay2 = { ...PAYMENT, id: 'sp2' };
    const complaint = { ...COMPLAINT, id: 'sc1' };
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({
          status: 200,
          body: body([pay, pay2, complaint]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    expect(await screen.findByTestId('shift-counts-11|2026-09-19|s1')).toHaveTextContent(
      'Theo dõi thanh toán: 2 · Vấn đề về chất lượng và dịch vụ: 1',
    );
    // A closed shift carries no "not finished" flag.
    expect(screen.queryByTestId('shift-open-11|2026-09-19|s1')).not.toBeInTheDocument();
  });
});

/**
 * "CA CHƯA KẾT THÚC CHƯA ĐƯỢC ĐƯA VÀO BÁO CÁO CHÍNH THỨC."
 *
 * A shift still running is on screen — the Admin can watch it — but flagged,
 * named, and left out of the export until "Kết thúc ca" is pressed.
 */
describe('an unfinished shift', () => {
  const OPEN_NOTICE = {
    sessionId: 's1',
    branchId: 11,
    branchAddress: '05 Trương Định',
    businessDate: '2026-09-19',
    shiftName: 'Ca C',
    shiftWindow: '18:00 – 06:00',
    receptionistName: 'Người Ca Đêm',
  };
  const openRoutes = () =>
    shellRoutes({
      [`GET /api/admin/reports/operational?branchId=11&${PERIOD}`]: () => ({
        status: 200,
        body: body([{ ...COMPLAINT, shiftClosed: false }], { openShifts: [OPEN_NOTICE] }),
      }),
    });

  it('is flagged on its own shift and named in a warning above the records', async () => {
    installApiMock(openRoutes());
    renderApp('/app/reports');
    await chooseBranch();

    expect(await screen.findByTestId('shift-open-11|2026-09-19|s1')).toHaveTextContent('Chưa kết thúc');
    const warning = screen.getByTestId('open-shift-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveTextContent(OPEN_SHIFT_WARNING);
    expect(warning).toHaveTextContent('Ca C (18:00 – 06:00) · Người Ca Đêm · 05 Trương Định');
  });

  it('is named again in the export dialog, which says only ended shifts are in the file', async () => {
    installApiMock(openRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('open-shift-warning');

    await userEvent.click(screen.getByTestId('operational-export-open'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('open-shift-warning')).toHaveTextContent(OPEN_SHIFT_WARNING);
    expect(dialog).toHaveTextContent('chỉ gồm các ca đã kết thúc');
  });

  it('says nothing when every shift has ended', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('row-p1');
    expect(screen.queryByTestId('open-shift-warning')).not.toBeInTheDocument();
  });
});

describe('the period', () => {
  it('opens on today, and asks the server for today', async () => {
    const fetchMock = installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();

    expect(screen.getByTestId('admin-range-from')).toHaveValue(TODAY);
    expect(screen.getByTestId('admin-range-to')).toHaveValue(TODAY);
    expect(screen.getByTestId('admin-range-0')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
        `/api/admin/reports/operational?branchId=11&${PERIOD}`,
      ),
    );
  });

  it.each([
    [6, '7 ngày'],
    [29, '30 ngày'],
  ])('asks for the last %i days + today when "%s" is chosen', async (back, text) => {
    const from = daysBefore(TODAY, back);
    const fetchMock = installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&from=${from}&to=${TODAY}`]: () => ({
          status: 200,
          body: body([PAYMENT]),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();

    const shortcut = screen.getByTestId(`admin-range-${back}`);
    expect(shortcut).toHaveTextContent(text);
    await userEvent.click(shortcut);

    expect(shortcut).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('admin-range-from')).toHaveValue(from);
    // The FILTER is applied by the server: the page only names the range.
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
        `/api/admin/reports/operational?branchId=11&from=${from}&to=${TODAY}`,
      ),
    );
    expect(await screen.findByTestId('row-p1')).toBeInTheDocument();
  });

  it('asks the server nothing for an incomplete period, and says why', async () => {
    const fetchMock = installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await screen.findByTestId('row-p1');
    const before = fetchMock.mock.calls.length;

    await userEvent.clear(screen.getByTestId('admin-range-from'));

    expect(await screen.findByTestId('admin-range-invalid')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls
        .slice(before)
        .some(([u]) => String(u).startsWith('/api/admin/reports/operational?')),
    ).toBe(false);
    // And there is nothing to export until the period is whole again.
    expect(screen.getByTestId('operational-export-open')).toBeDisabled();
  });
});

describe('the export is what is on screen', () => {
  it('exports the screen’s branch and period, in both formats', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await userEvent.click(screen.getByTestId('operational-export-open'));

    expect(await screen.findByTestId('operational-export-pdf')).toHaveAttribute(
      'href',
      `/api/admin/reports/operational.pdf?branchId=11&${PERIOD}`,
    );
    expect(screen.getByTestId('operational-export-xlsx')).toHaveAttribute(
      'href',
      `/api/admin/reports/operational.xlsx?branchId=11&${PERIOD}`,
    );
  });

  it('carries the chosen category into the file', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await openCategory('PAYMENT');
    await screen.findByTestId('row-p1');
    await userEvent.click(screen.getByTestId('operational-export-open'));

    const scope = await screen.findByTestId('operational-export-scope');
    expect(scope).toHaveTextContent('Theo dõi thanh toán');
    expect(screen.getByTestId('operational-export-pdf')).toHaveAttribute(
      'href',
      `/api/admin/reports/operational.pdf?branchId=11&category=PAYMENT&${PERIOD}`,
    );
  });

  it('carries the chosen period into the file', async () => {
    const from = daysBefore(TODAY, 6);
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?branchId=11&from=${from}&to=${TODAY}`]: () => ({
          status: 200,
          body: body(ALL),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch();
    await userEvent.click(screen.getByTestId('admin-range-6'));
    await screen.findByTestId('row-p1');
    await userEvent.click(screen.getByTestId('operational-export-open'));

    expect(await screen.findByTestId('operational-export-xlsx')).toHaveAttribute(
      'href',
      `/api/admin/reports/operational.xlsx?branchId=11&from=${from}&to=${TODAY}`,
    );
  });

  it('exports every branch when every branch is on screen', async () => {
    installApiMock(
      shellRoutes({
        [`GET /api/admin/reports/operational?${PERIOD}`]: () => ({
          status: 200,
          body: body(ALL, { cash: null, cashPeriod: null }),
        }),
      }),
    );
    renderApp('/app/reports');
    await chooseBranch('ALL');
    await screen.findByTestId('row-p1');
    await userEvent.click(screen.getByTestId('operational-export-open'));

    expect(await screen.findByTestId('operational-export-scope')).toHaveTextContent('Tất cả chi nhánh');
    expect(screen.getByTestId('operational-export-pdf').getAttribute('href')).not.toContain('branchId');
  });

  it('says the file contains the records themselves, by day, shift and person', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/reports');
    await chooseBranch();
    await userEvent.click(screen.getByTestId('operational-export-open'));
    const note = await screen.findByText(
      /in đầy đủ từng bản ghi, xếp theo chi nhánh, ngày, ca và nhân viên/i,
    );
    // Official: the shift's business date, ended shifts only.
    expect(note).toHaveTextContent('Báo cáo chính thức theo ngày nghiệp vụ của ca, chỉ gồm các ca đã kết thúc.');
  });
});
