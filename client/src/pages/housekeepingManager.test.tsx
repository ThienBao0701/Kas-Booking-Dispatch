/**
 * "QUẢN LÝ BUỒNG PHÒNG" — the manager's six screens over its one branch.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The role lands on "Tổng quan" with exactly its five menu entries (no
 *      "Phân công công việc" — work is assigned in "Tình trạng phòng"), its
 *      branch fixed and named — no picker; the overview only watches: it has no
 *      way to create, assign or edit work.
 *   2. "+ Tạo công việc" saves ONE work group: its optional name, then floor →
 *      tiles (several places) → each place's own checkboxes (one of OUT / OC /
 *      VC, and/or Khác), note and priority — after a review, one POST with one
 *      request id. "Phòng đang thực hiện" shows the day's groups as numbered
 *      cards ("Công việc 1, 2, …"), never by OUT / OC / VC; "Chỉnh sửa" renames,
 *      gives the whole group, takes one room out with its confirmation;
 *      "Không cần dọn" waits for the manager's confirmed decision.
 *   3. "Phân công công việc" is no longer a menu entry for anyone: an old link
 *      lands on "Tình trạng phòng" → "Danh sách", where the room's dialog
 *      assigns, edits, shows the history, and voids with a reason.
 *   4. "Theo dõi nhân viên" opens a worker's full detail, cleaning included.
 *   5. "KPI & Thu tiền" filters by collection status; "Báo cáo" exports PDF/Excel.
 *   6. The Admin reaches the same screens as a menu group, over every branch.
 *   8. "Tình trạng phòng" has three areas: rooms being cleaned, rooms waiting for
 *      "Đạt" / "Không đạt" (a reason required for the latter, with the re-clean
 *      sent to a chosen worker), and rooms that can be added again; the room's
 *      dialog shows every cleaning cycle and its review.
 *   7. Every screen opens with "Quản lý buồng phòng · Chi nhánh · Ngày nghiệp vụ";
 *      the worker lists come from the server's list of the branch's own accounts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';
import { hcmToday, hcmTomorrow } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const TODAY = hcmToday();

const MANAGER: AuthUser = {
  id: 9,
  username: 'qlbp',
  fullName: 'Quản lý Buồng',
  role: 'HOUSEKEEPING_MANAGER',
  branch: BRANCH,
  active: true,
  mustChangePassword: false,
};

const CATALOG = {
  statusCodes: ['OUT', 'OC', 'VC'],
  states: { NOT_STARTED: 'Chưa bắt đầu', INSPECTED: 'Đã kiểm tra', IN_PROGRESS: 'Đang dọn', COMPLETED: 'Hoàn thành' },
  linen: [{ code: 'BED_SHEET', label: 'Ga giường' }],
  linenSizes: [
    { code: 'K', label: 'King' },
    { code: 'Q', label: 'Queen' },
    { code: 'T', label: 'Twin' },
  ],
  quantities: [{ code: 'BATH_TOWEL', label: 'Khăn tắm' }],
  replacements: [{ code: 'SHAMPOO', label: 'Dầu gội' }],
  specialStatuses: [{ code: 'DND', short: 'DND', label: 'Không làm phiền' }],
  maxQuantity: 999,
};

const STAFF = { staff: [{ id: 6, fullName: 'Buồng phòng Một' }, { id: 7, fullName: 'Buồng phòng Hai' }] };

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    branchId: 1,
    branch: BRANCH,
    workDate: TODAY,
    roomNumber: '101',
    statusCode: 'OUT',
    priority: false,
    note: null,
    assignee: null,
    state: 'NOT_STARTED',
    stateLabel: 'Chưa bắt đầu',
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
    elapsedSeconds: null,
    inspection: null,
    cleaning: null,
    cleanedBy: null,
    createdByName: 'Quản lý Buồng',
    createdAt: '2026-10-05T01:00:00.000Z',
    updatedAt: '2026-10-05T01:00:00.000Z',
    voided: false,
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    cycleNumber: 1,
    reclean: null,
    review: null,
    nextCycleId: null,
    events: [
      { id: 'e1', type: 'CREATED', label: 'Tạo công việc', actorName: 'Quản lý Buồng', actorRole: 'HOUSEKEEPING_MANAGER', detail: null, createdAt: '2026-10-05T01:00:00.000Z' },
    ],
    ...over,
  };
}

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
    // KPI's employee filter (the server defaults to the manager's branch) …
    'GET /api/housekeeping/manager/staff': () => ({ status: 200, body: STAFF }),
    // … and the branch's own workers, for setting up and assigning rooms.
    [`GET /api/housekeeping/manager/staff?branchId=1`]: () => ({ status: 200, body: STAFF }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    // "Phòng đang thực hiện": the day's work groups (none unless a test says so).
    [`GET /api/housekeeping/manager/work-groups?date=${hcmToday()}&branchId=1`]: () => ({ status: 200, body: { groups: [] } }),
    ...extra,
  };
}

const AREAS = {
  hasRoomCatalog: true,
  hasFloorCatalog: true,
  floors: [
    { floor: '1', label: 'Tầng 1', rooms: ['101', '102', '103'] },
    { floor: '2', label: 'Tầng 2', rooms: ['201'] },
  ],
  unplacedRooms: ['001'],
  unplacedLabel: 'Phòng chưa xác định tầng',
  sharedAreas: [
    { kind: 'HALLWAY', label: 'Hành lang' },
    { kind: 'STAIRCASE', label: 'Cầu thang' },
    { kind: 'OTHER', label: 'Khác' },
  ],
  hasRooftop: false,
  rooftopLabel: 'Rooftop',
  roomTaskCodes: [
    { code: 'OUT', label: 'OUT' },
    { code: 'OC', label: 'OC' },
    { code: 'VC', label: 'VC' },
    { code: 'OTHER', label: 'Khác' },
  ],
};

/** One "Công việc N" as the server sends it. */
function workGroup(id: string, number: number, items: unknown[], over: Record<string, unknown> = {}) {
  return {
    id,
    branchId: 1,
    branch: BRANCH,
    workDate: TODAY,
    number,
    title: `Công việc ${number}`,
    name: null,
    assignee: null,
    acceptedAt: null,
    status: { code: 'UNASSIGNED', label: 'Chưa giao' },
    floors: ['Tầng 1'],
    counts: { items: items.length, completed: 0, noCleanPending: 0 },
    items,
    createdByName: 'Quản lý Buồng',
    createdAt: '2026-10-05T01:00:00.000Z',
    ...over,
  };
}

const GROUPS_URL = `GET /api/housekeeping/manager/work-groups?date=${TODAY}&branchId=1`;

const TASKS_URL = `GET /api/housekeeping/manager/tasks?date=${TODAY}&branchId=1`;
const KPI_ROW = {
  userId: 6,
  fullName: 'Buồng phòng Một',
  inspections: 4,
  findings: 2,
  collectedCount: 1,
  pendingCount: 1,
  uncollectibleCount: 0,
  collectedAmount: 500000,
  pendingAmount: 200000,
};

/** One finding line of the KPI, as the server sends it. */
function finding(id: string, createdAt: string, collectionStatus: 'COLLECTED' | 'PENDING' | 'UNCOLLECTIBLE', amount: number | null) {
  return {
    id,
    inspectionId: `i-${id}`,
    branch: BRANCH,
    roomNumber: '101',
    inspectorName: 'Buồng phòng Một',
    type: 'SMOKING',
    typeLabel: 'Hút thuốc',
    note: null,
    createdAt,
    collectionStatus,
    collectionStatusLabel: collectionStatus === 'COLLECTED' ? 'Đã thu' : collectionStatus === 'PENDING' ? 'Chưa thu' : 'Không thu được',
    amount,
    collectedByName: null,
    collectedAt: null,
  };
}

/** The "Quản lý buồng phòng" menu, exactly, in order. */
const MENU = ['Công việc chung', 'Công việc mỗi ngày cần làm', 'Phát hiện & thu tiền', 'Individual PerformanceSẽ phát triển'];
/** "Kho hàng", opened: the four warehouses, in code order. */
const STORES = [
  ['Kho hóa chất & dụng cụ', '/app/hk/store/chemicals'],
  ['Đồ dùng cho khách', '/app/hk/store/guest-supplies'],
  ['Kho đồ vải', '/app/hk/store/linens'],
  ['Kho đồ dùng khác / Đồ tiêu hao (Amenities)', '/app/hk/store/amenities'],
];
/** What "Công việc chung" no longer shows. */
const REMOVED = ['hk-context', 'hk-date', 'hk-overview-rooms', 'hk-overview-progress', 'hk-working', 'hk-overview-kpi', 'hk-quick'];

describe('Quản lý buồng phòng — menu and overview', () => {
  it('lands on "Công việc chung": one "Công việc mỗi ngày cần làm" link, "Kho hàng" folded, "Phát hiện & thu tiền" — watching only, no "Tạo công việc"', async () => {
    installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/overview?date=${TODAY}&branchId=1`]: () => ({
          status: 200,
          body: {
            workDate: TODAY,
            rooms: { total: 12, notStarted: 5, inProgress: 3, completed: 4, priority: 2, unassigned: 1 },
            working: [{ userId: 6, name: 'Buồng phòng Một', branch: BRANCH, since: '2026-10-05T01:00:00.000Z' }],
            employees: [{ userId: 6, name: 'Buồng phòng Một', assigned: 6, inProgress: 2, completed: 3 }],
            inspections: 7,
            findings: 2,
            collectedAmount: 500000,
            pendingCollections: 1,
          },
        }),
        [GROUPS_URL]: () => ({
          status: 200,
          body: {
            groups: [
              workGroup('g1', 1, [task('a1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'], state: 'IN_PROGRESS', stateLabel: 'Đang dọn', phase: 'CLEANING', assignee: { id: 6, name: 'Buồng phòng Một' } })], {
                assignee: { id: 6, name: 'Buồng phòng Một' },
                status: { code: 'IN_PROGRESS', label: 'Đang làm' },
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/app');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    // "Theo dõi nhân viên" and "Báo cáo" stay off the menu (their pages remain); KPI is under "Báo cáo vấn đề".
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(MENU);
    expect(within(nav).getByRole('link', { name: 'Công việc mỗi ngày cần làm' })).toHaveAttribute('href', '/app/hk/daily');
    expect(within(nav).queryByTestId('nav-group-Công việc cá nhân')).not.toBeInTheDocument();
    const stores = within(nav).getByTestId('nav-group-Kho hàng');
    const reports = within(nav).getByTestId('nav-group-Báo cáo vấn đề');
    expect(stores.compareDocumentPosition(reports) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).getByTestId('nav-group-Hoàn thành vấn đề')).toBeInTheDocument();
    await userEvent.click(reports);
    // Its own three categories (no "Dịch vụ phòng, KPI"), the private reports, then its inspections and KPI.
    expect(within(reports.parentElement!).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/app/hk/reports?category=GUEST_REQUEST',
      '/app/hk/reports?category=FACILITY_ISSUE',
      '/app/hk/reports?category=HOTEL_DELIVERY',
      '/app/reports/confidential',
    ]);
    expect(within(reports.parentElement!).getByTestId('nav-group-Kiểm tra phòng & KPI buồng phòng')).toBeInTheDocument();
    await userEvent.click(reports);
    await userEvent.click(stores);
    expect(within(stores.parentElement!).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual(STORES);
    expect(await within(screen.getByRole('main')).findByRole('heading', { level: 1, name: 'Công việc chung' })).toBeInTheDocument();
    // Gone: the date / branch strip and its cards, the progress bar, "Nhân viên trong ca",
    // "KPI & thu tiền hôm nay" and "Truy cập nhanh". The manager never had a branch filter.
    for (const id of [...REMOVED, 'branch-select']) expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    expect(screen.queryByText('Truy cập nhanh')).not.toBeInTheDocument();
    expect(screen.queryByText('Nhân viên trong ca')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Chi nhánh \d/);
    // Kept: the day's progress, and no dead "choose a branch" line.
    expect(screen.getByTestId('hk-overview-groups')).toHaveTextContent('Tiến độ công việc hôm nay');
    expect(screen.queryByText(/Chọn một chi nhánh/)).not.toBeInTheDocument();
    // The day's groups, read-only: who has it, its floors, each room's status.
    const group = await screen.findByTestId('overview-group-1');
    expect(group).toHaveTextContent('Công việc 1');
    expect(group).toHaveTextContent('Người thực hiện: Buồng phòng Một');
    expect(group).toHaveTextContent('Phòng 101');
    expect(group).toHaveTextContent('Đang dọn');
    // Watching only: nothing here creates, assigns, accepts or edits work.
    expect(screen.queryByTestId('work-create-open')).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: /Tạo công việc|Nhận công việc|Chỉnh sửa/ })).not.toBeInTheDocument();
  });

  it('gives the Admin three entries — Công việc chung, Công việc mỗi ngày cần làm, Kho hàng — and keeps its branch filter on "Công việc chung"', async () => {
    const CN2 = { id: 2, code: 'LTT', hotelName: 'KAS', address: '260 Lý Tự Trọng', branchNumber: 2 };
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, CN2] } }),
        [GROUPS_URL]: () => ({
          status: 200,
          body: { groups: [workGroup('g1', 1, [task('a1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'] })])] },
        }),
        [`GET /api/housekeeping/manager/work-groups?date=${TODAY}&branchId=2`]: () => ({ status: 200, body: { groups: [] } }),
      }),
    );
    renderApp('/app/hk/overview');
    // "Tất cả chi nhánh" first: one block per branch with work today — none for an idle one.
    expect(await screen.findByTestId('overview-branch-1')).toHaveTextContent('05 Trương Định');
    expect(screen.getByTestId('overview-group-1')).toHaveTextContent('Phòng 101');
    expect(screen.queryByTestId('overview-branch-2')).not.toBeInTheDocument();
    for (const id of REMOVED) expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    // The Admin's branch filter stays: one branch shows its own day.
    await userEvent.click(screen.getByTestId('branch-select'));
    await userEvent.click(screen.getByTestId('branch-option-2'));
    expect(await screen.findByText('Chưa có công việc nào trong ngày. Công việc được tạo ở “Công việc mỗi ngày cần làm”.')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-group-1')).not.toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    // Open, since the page is inside it.
    expect(within(nav).getByTestId('nav-group-Quản lý buồng phòng')).toHaveAttribute('aria-expanded', 'true');
    const group = within(nav).getByTestId('nav-group-Quản lý buồng phòng').parentElement!;
    // Three rows: two links, one folded group.
    expect(within(group).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/app/hk/overview', '/app/hk/daily']);
    // The Admin's view spans every branch: "Kho hàng tổng".
    expect(within(group).queryByTestId('nav-group-Kho hàng')).not.toBeInTheDocument();
    const stores = within(group).getByTestId('nav-group-Kho hàng tổng');
    expect(within(group).queryByTestId('nav-group-Điều phối công việc')).not.toBeInTheDocument();
    // Never "Dọn phòng": the Admin works no shift and cleans no room.
    expect(within(nav).queryByRole('link', { name: 'Dọn phòng' })).not.toBeInTheDocument();
    await userEvent.click(stores);
    expect(within(stores.parentElement!).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([...STORES.map(([, href]) => href), '/app/inventory']);
    // "Tồn kho & Báo hỏng": inside "Quản lý buồng phòng", nowhere else.
    expect(within(group).getByRole('link', { name: 'Tồn kho & Báo hỏng' })).toHaveAttribute('href', '/app/inventory');
    // Its reports are under "Báo cáo vấn đề", not here.
    expect(within(group).queryByRole('link', { name: /KPI/ })).not.toBeInTheDocument();
    expect(within(nav).getAllByRole('link', { name: 'Tồn kho & Báo hỏng' })).toHaveLength(1);
    expect(within(nav).queryByRole('link', { name: 'Phân công công việc' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Theo dõi nhân viên' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Báo cáo' })).not.toBeInTheDocument();
    // The separate "Báo cáo vấn đề" menu is untouched.
    expect(within(nav).getByTestId('nav-group-Báo cáo vấn đề')).toBeInTheDocument();
  });

  it('opens each warehouse with its own states — the server’s balances, nothing computed or invented', async () => {
    const empty = { status: 200, body: { receipts: [] } };
    const routesFor = (warehouse: string, items: unknown[]) =>
      shell(MANAGER, {
        [`GET /api/housekeeping/inventory/items?warehouse=${warehouse}`]: () => ({ status: 200, body: { items } }),
        [`GET /api/housekeeping/inventory/receipts?warehouse=${warehouse}`]: () => empty,
      });
    const towel = {
      id: 'i1',
      branch: BRANCH,
      warehouse: 'LINEN',
      name: 'Khăn tắm',
      variant: '',
      label: 'Khăn tắm',
      code: '3.001',
      unit: 'cái',
      lowStockThreshold: 20,
      lowStock: true,
      note: null,
      archived: false,
      opened: true,
      cleaningOrder: 1,
      unclassified: false,
      legacyBalances: [{ state: 'DIRTY', stateLabel: 'Bẩn', quantity: 2 }],
      balances: { AVAILABLE: 18, DAMAGED: 1 },
      pendingDamage: 1,
    };
    installApiMock(routesFor('LINEN', [towel]));
    const linen = renderApp('/app/hk/store/linens');
    const main = await screen.findByRole('main');
    expect(await within(main).findByRole('heading', { level: 1, name: 'Kho đồ vải' })).toBeInTheDocument();
    const table = await screen.findByTestId('inventory-items');
    expect(await within(table).findByText('Khăn tắm')).toBeInTheDocument();
    expect(within(table).getByText('Sắp hết')).toBeInTheDocument();
    expect(within(table).getByText('Dùng khi dọn phòng')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-total-AVAILABLE')).toHaveTextContent('18');
    expect(screen.getByTestId('inventory-pending-damage')).toHaveTextContent('1');
    // One on-hand figure: no "Bẩn", no "đang giặt"; a dirty balance from before is flagged apart.
    expect(screen.queryByTestId('inventory-total-DIRTY')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inventory-total-IN_LAUNDRY')).not.toBeInTheDocument();
    expect(screen.getByTestId('inventory-legacy-i1')).toHaveTextContent('bẩn 2');
    for (const id of ['inventory-receive-open', 'inventory-damage-open', 'inventory-manage-open']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // No transfers in the four warehouses.
    expect(screen.queryByTestId(/^inventory-transfer-/)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Giặt xong');
    linen.unmount();
    for (const [path, warehouse, title] of [
      ['chemicals', 'CHEMICAL_TOOLS', 'Kho hóa chất & dụng cụ'],
      ['guest-supplies', 'GUEST_SUPPLIES', 'Đồ dùng cho khách'],
      ['amenities', 'AMENITY', 'Kho đồ dùng khác / Đồ tiêu hao (Amenities)'],
    ] as const) {
      installApiMock(routesFor(warehouse, []));
      const view = renderApp(`/app/hk/store/${path}`);
      expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(await screen.findByText('Kho chưa có mặt hàng')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('keeps "Theo dõi nhân viên" and "Báo cáo" reachable by address — off the menu, not removed', async () => {
    const PERIOD = `from=${TODAY}&to=${TODAY}`;
    installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/staff-progress?${PERIOD}`]: () => ({ status: 200, body: { rows: [] } }),
        [`GET /api/housekeeping/shifts?${PERIOD}`]: () => ({ status: 200, body: { shifts: [] } }),
        [`GET /api/housekeeping/manager/work-groups?date=${TODAY}`]: () => ({ status: 200, body: { groups: [] } }),
      }),
    );
    const first = renderApp('/app/hk/staff');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Theo dõi nhân viên' })).toBeInTheDocument();
    // The topbar still names the page.
    expect(screen.getAllByRole('heading', { level: 1, name: 'Theo dõi nhân viên' })).toHaveLength(2);
    first.unmount();
    installApiMock(shell(MANAGER, { [`GET /api/housekeeping/manager/report?${PERIOD}`]: () => ({ status: 200, body: { from: TODAY, to: TODAY, rows: [], findings: [] } }) }));
    renderApp('/app/hk/report');
    expect(await screen.findByRole('heading', { level: 1, name: 'Báo cáo vận hành buồng phòng' })).toBeInTheDocument();
    // The topbar names it as the reporting menu does.
    expect(screen.getByRole('heading', { level: 1, name: 'Lịch sử kiểm tra & dọn phòng' })).toBeInTheDocument();
  });
});

describe('Quản lý buồng phòng — Tình trạng phòng', () => {
  it('creates ONE work group across floors — sections, compact rows, a note only with "Khác", nothing lost on the way', async () => {
    const posted: { requestId: string; [k: string]: unknown }[] = [];
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({ status: 200, body: { areas: { branchId: 1, ...AREAS } } }),
        'POST /api/housekeeping/manager/work-groups': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { duplicate: false, group: workGroup('g1', 1, []) } };
        },
      }),
    );
    renderApp('/app/hk/rooms');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Phân công ca, việc làm' })).toBeInTheDocument();
    expect(screen.getByTestId('hk-period-value')).toHaveTextContent(TODAY.split('-').reverse().join('/'));
    await userEvent.click(screen.getByTestId('work-create-open'));
    const dialog = await screen.findByRole('dialog');
    // The group's name, first — optional.
    await userEvent.type(await within(dialog).findByTestId('work-name'), 'Tổng vệ sinh buổi sáng');

    // Khu vực 1 — its own floor and tiles.
    const floor0 = within(dialog).getByTestId('place-floor-0');
    expect([...floor0.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Chọn tầng —', 'Tầng 1', 'Tầng 2', 'Phòng chưa xác định tầng']);
    await userEvent.selectOptions(floor0, '1');
    const tiles0 = within(dialog).getByTestId('place-tiles-0');
    const tileOrder = () => within(tiles0).getAllByRole('button').map((b) => b.getAttribute('data-testid'));
    const before = tileOrder();
    expect(within(tiles0).getAllByRole('button').map((b) => b.textContent)).toEqual(['101', '102', '103', 'Hành lang', 'Cầu thang', 'Khác']);

    // 101: picked — one compact row, its details open; no note and no priority until "Khác".
    await userEvent.click(within(tiles0).getByTestId('place-tile-ROOM:101'));
    expect(within(dialog).getByTestId('place-row-ROOM:101')).toHaveTextContent('Phòng 101 — chưa chọn việc');
    expect(within(dialog).getByTestId('place-detail-ROOM:101')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('place-note-ROOM:101')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Ưu tiên/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:101-OUT'));
    // One of OUT / OC / VC: OC clears OUT; "Khác" brings its required note.
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:101-OC'));
    expect(within(dialog).getByTestId('place-code-ROOM:101-OUT')).not.toBeChecked();
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:101-OTHER'));
    expect(within(dialog).getByTestId('place-problem-ROOM:101')).toHaveTextContent('"Khác" cần ghi rõ');
    await userEvent.type(within(dialog).getByTestId('place-note-ROOM:101'), 'Thay rèm');
    // Typed is not confirmed: the box's own "Xác nhận" — then "Đã xác nhận".
    expect(within(dialog).getByTestId('place-problem-ROOM:101')).toHaveTextContent('Bấm “Xác nhận”');
    expect(within(dialog).getByTestId('place-note-ROOM:101-box')).toContainElement(within(dialog).getByTestId('place-note-ROOM:101-confirm'));
    await userEvent.click(within(dialog).getByTestId('place-note-ROOM:101-confirm'));
    expect(within(dialog).getByTestId('place-note-ROOM:101-state')).toHaveTextContent('Đã xác nhận');
    expect(within(dialog).queryByTestId('place-problem-ROOM:101')).not.toBeInTheDocument();
    // An edit after confirming asks for it again.
    await userEvent.type(within(dialog).getByTestId('place-note-ROOM:101'), '!');
    expect(within(dialog).getByTestId('place-note-ROOM:101-state')).toHaveTextContent('Chưa xác nhận');
    expect(within(dialog).getByTestId('work-review')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('place-note-ROOM:101'), '{Backspace}');
    await userEvent.click(within(dialog).getByTestId('place-note-ROOM:101-confirm'));
    // Unticking "Khác" hides the note; ticking it again shows what was typed.
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:101-OTHER'));
    expect(within(dialog).queryByTestId('place-note-ROOM:101')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:101-OTHER'));
    expect(within(dialog).getByTestId('place-note-ROOM:101')).toHaveValue('Thay rèm');

    // 102: its row opens and 101's closes — the tiles never move.
    await userEvent.click(within(tiles0).getByTestId('place-tile-ROOM:102'));
    expect(within(dialog).queryByTestId('place-detail-ROOM:101')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('place-row-ROOM:101')).toHaveTextContent('Phòng 101 — OC + Khác');
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:102-VC'));
    // A hallway always says what to do.
    await userEvent.click(within(tiles0).getByTestId('place-tile-HALLWAY:1'));
    expect(within(dialog).getByTestId('place-problem-HALLWAY:1')).toHaveTextContent('cần ghi rõ việc cần làm');
    await userEvent.type(within(dialog).getByTestId('place-note-HALLWAY:1'), 'Lau sàn');
    await userEvent.click(within(dialog).getByTestId('place-note-HALLWAY:1-confirm'));
    expect(tileOrder()).toEqual(before);
    expect(floor0).toBeDisabled();

    // "+ Thêm khu vực": Khu vực 2 — Tầng 2, its own tiles; Tầng 1 is already taken.
    await userEvent.click(within(dialog).getByTestId('place-add-section'));
    const floor1 = within(dialog).getByTestId('place-floor-1');
    expect(within(floor1).getByRole('option', { name: /Tầng 1/ })).toBeDisabled();
    await userEvent.selectOptions(floor1, '2');
    await userEvent.click(within(dialog).getByTestId('place-tile-ROOM:201'));
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:201-OUT'));
    // What was entered on Tầng 1 is all still there — confirmed still.
    await userEvent.click(within(dialog).getByTestId('place-open-ROOM:101'));
    expect(within(dialog).getByTestId('place-note-ROOM:101')).toHaveValue('Thay rèm');
    expect(within(dialog).getByTestId('place-note-ROOM:101-state')).toHaveTextContent('Đã xác nhận');

    // A third section with a pick, removed only after confirming what goes with it.
    await userEvent.click(within(dialog).getByTestId('place-add-section'));
    await userEvent.selectOptions(within(dialog).getByTestId('place-floor-2'), '__unplaced__');
    await userEvent.click(within(dialog).getByTestId('place-tile-ROOM:001'));
    await userEvent.click(within(dialog).getByTestId('place-section-remove-2'));
    expect(within(dialog).getByTestId('place-section-confirm-2')).toHaveTextContent('sẽ bỏ 1 phòng / khu vực đã chọn (Phòng 001)');
    await userEvent.click(within(within(dialog).getByTestId('place-section-confirm-2')).getByRole('button', { name: 'Giữ lại' }));
    expect(within(dialog).getByTestId('place-row-ROOM:001')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByTestId('place-section-remove-2'));
    await userEvent.click(within(dialog).getByTestId('place-section-remove-confirm-2'));
    expect(within(dialog).queryByTestId('place-section-2')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('place-row-ROOM:001')).not.toBeInTheDocument();

    // The review — then back, and nothing is lost.
    await userEvent.click(within(dialog).getByTestId('work-review'));
    const review = within(dialog).getByTestId('work-review-list');
    expect(review).toHaveTextContent('Tên công việc: Tổng vệ sinh buổi sáng');
    expect(review).toHaveTextContent('Tầng / khu vực: Tầng 1, Tầng 2');
    // One section per floor, the area under its own floor.
    expect(within(review).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Tầng 1', 'Tầng 2']);
    expect(within(screen.getByTestId('work-review-floor-Tầng 1')).getAllByRole('listitem')).toHaveLength(3);
    expect(within(review).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Phòng 101 — OC + KhácGhi chú: Thay rèm',
      'Phòng 102 — VC',
      'Hành lang — KhácGhi chú: Lau sàn',
      'Phòng 201 — OUT',
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: /Sửa lại/ }));
    expect(within(dialog).getByTestId('place-row-ROOM:201')).toHaveTextContent('Phòng 201 — OUT');
    expect(within(dialog).getByTestId('place-floor-1')).toHaveValue('2');
    await userEvent.click(within(dialog).getByTestId('work-review'));
    await userEvent.click(within(dialog).getByTestId('work-save'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      branchId: 1,
      workDate: TODAY,
      requestId: expect.any(String),
      name: 'Tổng vệ sinh buổi sáng',
      items: [
        { areaKind: 'ROOM', roomNumber: '101', taskCodes: ['OC', 'OTHER'], note: 'Thay rèm' },
        { areaKind: 'ROOM', roomNumber: '102', taskCodes: ['VC'] },
        { areaKind: 'HALLWAY', floor: '1', taskCodes: ['OTHER'], note: 'Lau sàn' },
        { areaKind: 'ROOM', roomNumber: '201', taskCodes: ['OUT'] },
      ],
    });
    expect(posted[0]!.requestId.length).toBeGreaterThanOrEqual(8);
    // No "Giao cho" chosen: no assignee is sent — the group waits in the pool (the exact body above).
    // A long interactive flow (~3.5 s alone): its own timeout, so a loaded full run does not cut it short.
  }, 15_000);

  it('does not offer a room or area that is still in an open item — until its work is resolved — and reloads them on a conflict', async () => {
    let created = 0;
    const day = [
      // 102: open (not started) — held. 103: reviewed "Đạt" — free again. 101: cleaned, waiting for review — held.
      task('o2', { roomNumber: '102', floor: '1', areaKind: 'ROOM' }),
      task('o3', { roomNumber: '103', floor: '1', areaKind: 'ROOM', state: 'COMPLETED', review: { status: 'PASSED', label: 'Đạt', reviewedAt: null, reviewedByName: null, failureReason: null, recleanRequested: false } }),
      task('o1', { roomNumber: '101', floor: '1', areaKind: 'ROOM', state: 'COMPLETED', review: { status: 'PENDING', label: 'Chờ đánh giá', reviewedAt: null, reviewedByName: null, failureReason: null, recleanRequested: false } }),
      // The floor's hallway is open; an approved "Không cần dọn" (voided) frees its room.
      task('oh', { roomNumber: 'Hành lang - Tầng 1', floor: '1', areaKind: 'HALLWAY' }),
      task('o4', { roomNumber: '201', floor: '2', areaKind: 'ROOM', voided: true, phase: 'NO_CLEAN' }),
    ];
    const fetchMock = installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: day } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({ status: 200, body: { areas: { branchId: 1, ...AREAS } } }),
        'POST /api/housekeeping/manager/work-groups': () => {
          created += 1;
          return { status: 409, body: { error: { code: 'CONFLICT', message: 'Đã có việc đang mở trong ngày: Phòng 103 (Công việc 2).' } } };
        },
      }),
    );
    renderApp('/app/hk/rooms');
    await userEvent.click(await screen.findByTestId('work-create-open'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(await within(dialog).findByTestId('place-floor-0'), '1');
    const tiles = within(dialog).getByTestId('place-tiles-0');
    expect(within(tiles).getAllByRole('button').map((b) => b.textContent)).toEqual(['103', 'Cầu thang', 'Khác']);
    expect(within(dialog).getByTestId('place-held-0')).toHaveTextContent('3 phòng / khu vực đang có công việc chưa xong');
    // Another floor is untouched; an approved "Không cần dọn" gives its room back.
    await userEvent.click(within(dialog).getByTestId('place-add-section'));
    await userEvent.selectOptions(within(dialog).getByTestId('place-floor-1'), '2');
    expect(within(within(dialog).getByTestId('place-tiles-1')).getByTestId('place-tile-ROOM:201')).toBeInTheDocument();
    // The server has the last word: a conflict is shown, and the open places are read again.
    await userEvent.click(within(tiles).getByTestId('place-tile-ROOM:103'));
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:103-OUT'));
    await userEvent.click(within(dialog).getByTestId('work-review'));
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes('/manager/tasks?')).length;
    await userEvent.click(within(dialog).getByTestId('work-save'));
    expect(await within(dialog).findByText(/Đã có việc đang mở trong ngày: Phòng 103/)).toBeInTheDocument();
    expect(created).toBe(1);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/manager/tasks?')).length).toBeGreaterThan(before));
  });

  it('says a failed save is a failed save — no "danh sách đã tải lại" unless the server reports a conflict (room 401, as reported)', async () => {
    const fetchMock = installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({
          status: 200,
          body: { areas: { branchId: 1, ...AREAS, floors: [...AREAS.floors, { floor: '4', label: 'Tầng 4', rooms: ['401', '402'] }] } },
        }),
        'POST /api/housekeeping/manager/work-groups': () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi hệ thống.' } } }),
      }),
    );
    renderApp('/app/hk/rooms');
    await userEvent.click(await screen.findByTestId('work-create-open'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(await within(dialog).findByTestId('place-floor-0'), '4');
    // Floor 4 has no work: both rooms are offered.
    expect(within(within(dialog).getByTestId('place-tiles-0')).getAllByRole('button').map((b) => b.textContent).slice(0, 2)).toEqual(['401', '402']);
    await userEvent.click(within(dialog).getByTestId('place-tile-ROOM:401'));
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:401-OUT'));
    await userEvent.click(within(dialog).getByTestId('work-review'));
    expect(within(dialog).getByTestId('work-review-list')).toHaveTextContent('Tầng 4Phòng 401 — OUT');
    const reads = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/manager/tasks?')).length;
    const before = reads();
    await userEvent.click(within(dialog).getByTestId('work-save'));
    const alert = await within(dialog).findByText(/Đã xảy ra lỗi hệ thống/);
    expect(alert).toHaveTextContent('Công việc chưa được lưu');
    expect(alert).not.toHaveTextContent('đã được tải lại');
    // Not a conflict: nothing to reload.
    expect(reads()).toBe(before);
  });

  it('offers the Rooftop only where the branch has one, and no "chưa xác định tầng" when every room is placed', async () => {
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({
          status: 200,
          body: { areas: { branchId: 1, ...AREAS, unplacedRooms: [], hasRooftop: true, rooftopLabel: 'Rooftop' } },
        }),
      }),
    );
    renderApp('/app/hk/rooms');
    await userEvent.click(await screen.findByTestId('work-create-open'));
    const floor = await screen.findByTestId('place-floor-0');
    expect([...floor.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Chọn tầng —', 'Tầng 1', 'Tầng 2', 'Rooftop']);
    await userEvent.selectOptions(floor, '__rooftop__');
    await userEvent.click(screen.getByTestId('place-tile-ROOFTOP'));
    expect(screen.getByTestId('place-row-ROOFTOP')).toHaveTextContent('Rooftop — Khác');
    // The Rooftop is always "Khác": its note is there and required.
    expect(screen.getByTestId('place-note-ROOFTOP')).toBeInTheDocument();
    expect(screen.getByTestId('work-review')).toBeDisabled();
  });

  it('lets the Quản lý buồng phòng take a group and do the work — on its shift at its branch', async () => {
    const MANAGER_ID = 9;
    let onShift = false;
    const started: unknown[] = [];
    const accepted: string[] = [];
    const shiftBody = () =>
      onShift
        ? { shift: { id: 's1', user: { id: MANAGER_ID, fullName: 'Quản lý Buồng' }, startedAt: '2026-10-05T01:00:00.000Z', endedAt: null, segments: [], current: { id: 'seg', branch: BRANCH, staffName: 'Quản lý Buồng', startedAt: '2026-10-05T01:00:00.000Z', endedAt: null, rooms: 0, inspections: 0, issues: 0, byType: [] }, totals: { rooms: 0, inspections: 0, issues: 0, byType: [] } } }
        : { shift: null };
    const free = workGroup('g1', 1, [task('a1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'], phase: 'UNCLAIMED', phaseLabel: 'Chưa giao' })]);
    const mine = workGroup('g2', 2, [task('b1', { roomNumber: '201', floor: '2', taskCodes: ['VC'], assignee: { id: MANAGER_ID, name: 'Quản lý Buồng' }, phase: 'ACCEPTED', phaseLabel: 'Đã nhận / Chờ kiểm tra' })], {
      assignee: { id: MANAGER_ID, name: 'Quản lý Buồng' },
      status: { code: 'ACCEPTED', label: 'Đã nhận' },
    });
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        [GROUPS_URL]: () => ({ status: 200, body: { groups: [free, mine] } }),
        'GET /api/housekeeping/shift': () => ({ status: 200, body: shiftBody() }),
        'POST /api/housekeeping/shift/start': (init) => {
          started.push(JSON.parse(String(init.body)));
          onShift = true;
          return { status: 201, body: shiftBody() };
        },
        'POST /api/housekeeping/work/groups/g1/accept': () => {
          accepted.push('g1');
          return { status: 200, body: { group: { ...free, assignee: { id: MANAGER_ID, name: 'Quản lý Buồng' } } } };
        },
      }),
    );
    const first = renderApp('/app/hk/clean');
    const bar = await screen.findByTestId('manager-shift');
    // Off shift: nothing to take yet.
    await waitFor(() => expect(within(bar).getByTestId('manager-shift-start')).toBeEnabled());
    expect(screen.queryByTestId('panel-accept-1')).not.toBeInTheDocument();
    await userEvent.click(within(bar).getByTestId('manager-shift-start'));
    // No address: the manager works at its own branch.
    await waitFor(() => expect(started).toEqual([{}]));
    expect(await within(bar).findByTestId('manager-shift-end')).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('panel-accept-1'));
    await userEvent.click(await screen.findByTestId('group-accept-confirm'));
    await waitFor(() => expect(accepted).toEqual(['g1']));
    // Its own room, with its next step.
    expect(within(screen.getByTestId('panel-own-b1')).getByTestId('work-step-b1')).toHaveTextContent('Kiểm tra');
    first.unmount();
    // "Phân công ca, việc làm" gives out the work: no shift bar, no "Nhận" there.
    renderApp('/app/hk/rooms?view=groups');
    const two = await screen.findByTestId('group-card-2');
    expect(screen.queryByTestId('manager-shift')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-accept-1')).not.toBeInTheDocument();
    expect(within(two).getByTestId('group-edit-2')).toBeInTheDocument();
  });

  it('shows the day’s work groups as numbered cards inside "Phòng đang thực hiện" — one row per floor, never by OUT / OC / VC', async () => {
    const g1 = workGroup('g1', 1, [
      task('a1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'], phase: 'UNCLAIMED', phaseLabel: 'Chưa giao' }),
      task('a2', { roomNumber: '102', floor: '1', taskCodes: ['OC', 'OTHER'], note: 'Thay rèm', phase: 'UNCLAIMED', phaseLabel: 'Chưa giao' }),
      task('a3', { roomNumber: '103', floor: '1', taskCodes: ['VC'], phase: 'UNCLAIMED', phaseLabel: 'Chưa giao' }),
      task('a4', { roomNumber: 'Hành lang - Tầng 2', areaKind: 'HALLWAY', areaKindLabel: 'Hành lang', floor: '2', taskCodes: ['OTHER'], note: 'Lau sàn', phase: 'UNCLAIMED', phaseLabel: 'Chưa giao' }),
    ], { name: 'Dọn sáng', floors: ['Tầng 1', 'Tầng 2'] });
    const g2 = workGroup('g2', 2, [task('b1', { roomNumber: '201', floor: '2', taskCodes: ['VC'], assignee: { id: 6, name: 'Buồng phòng Một' }, phase: 'ACCEPTED', phaseLabel: 'Đã nhận / Chờ kiểm tra' })], {
      assignee: { id: 6, name: 'Buồng phòng Một' },
      status: { code: 'ACCEPTED', label: 'Đã nhận' },
      floors: ['Tầng 2'],
    });
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [task('old', { roomNumber: '301' })] } }),
        [GROUPS_URL]: () => ({ status: 200, body: { groups: [g1, g2] } }),
      }),
    );
    renderApp('/app/hk/rooms?view=groups');
    const active = await screen.findByTestId('board-active');
    await waitFor(() => expect(within(active).getAllByRole('article').map((a) => a.getAttribute('data-testid'))).toEqual(['group-card-1', 'group-card-2', 'older-task-301']));
    expect(within(active).queryByTestId('room-row-OUT')).not.toBeInTheDocument();
    const one = within(active).getByTestId('group-card-1');
    expect(one).toHaveTextContent('Công việc 1 — Dọn sáng');
    expect(within(one).getByTestId('group-assignee-1')).toHaveTextContent('Người thực hiện: Chưa giao');
    expect(within(one).getByTestId('group-edit-1')).toHaveTextContent('Chỉnh sửa');
    // One floor, one row: 101, 102 and 103 side by side in the SAME row container.
    const floor1 = within(one).getByTestId('group-floor-1-0');
    expect(within(floor1).getByRole('heading')).toHaveTextContent('Tầng 1');
    const row1 = within(floor1).getByTestId('group-floor-row-1-0');
    expect(row1.className).toContain('flex-wrap');
    expect(within(row1).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual(['group-item-a1', 'group-item-a2', 'group-item-a3']);
    // Another floor: its own section and row.
    const floor2 = within(one).getByTestId('group-floor-1-1');
    expect(within(floor2).getByRole('heading')).toHaveTextContent('Tầng 2');
    expect(within(within(floor2).getByTestId('group-floor-row-1-1')).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual(['group-item-a4']);
    // Each tile keeps what is to be done, who has it, and where it stands.
    const tile = within(row1).getByTestId('group-item-a2');
    expect(tile).toHaveTextContent('Phòng 102');
    expect(tile).toHaveTextContent('OC');
    expect(tile).toHaveTextContent('Khác');
    expect(tile).toHaveTextContent('Chưa giao');
    expect(within(tile).getByTestId('phase-a2')).toHaveTextContent('Chưa giao');
    expect(tile).toHaveTextContent('Ghi chú: Thay rèm');
    expect(within(floor2).getByTestId('group-item-a4')).toHaveTextContent('Hành lang');
    // Separate groups stay separate cards; the second has its own floor row.
    const two = within(active).getByTestId('group-card-2');
    expect(within(two).getByTestId('group-floor-2-0')).toHaveTextContent('Tầng 2');
    expect(within(one).queryByTestId('group-item-b1')).not.toBeInTheDocument();
    // "Chi tiết" on a tile still opens that room.
    await userEvent.click(within(tile).getByTestId('group-item-open-a2'));
    expect(await screen.findByRole('dialog', { name: /Phòng 102/ })).toBeInTheDocument();
    expect(within(active).getByTestId('group-assignee-2')).toHaveTextContent('Người thực hiện: Buồng phòng Một');
    // The view's tab counts the day's groups.
    expect(screen.getByTestId('board-view-groups')).toHaveTextContent('Công việc (2)');
    expect(screen.getByTestId('board-view-groups')).toHaveAttribute('aria-pressed', 'true');
  });

  it('"Chỉnh sửa": renames, gives the whole group, and takes one room out only with its confirmation', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const record = (url: string, status = 200, body: unknown = {}) => (init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body ?? '{}')) });
      return { status, body };
    };
    const g1 = workGroup('g1', 1, [
      task('a1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'], assignee: { id: 6, name: 'Buồng phòng Một' }, phase: 'ACCEPTED', phaseLabel: 'Đã nhận' }),
      task('a2', { roomNumber: '102', floor: '1', taskCodes: ['OC'], assignee: { id: 6, name: 'Buồng phòng Một' }, phase: 'ACCEPTED', phaseLabel: 'Đã nhận' }),
    ], { assignee: { id: 6, name: 'Buồng phòng Một' } });
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        [GROUPS_URL]: () => ({ status: 200, body: { groups: [g1] } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({ status: 200, body: { areas: { branchId: 1, ...AREAS } } }),
        'PATCH /api/housekeeping/manager/work-groups/g1': record('rename', 200, { group: { ...g1, name: 'Ca chiều' } }),
        'POST /api/housekeeping/manager/work-groups/g1/assign': record('assign', 200, { group: { ...g1, assignee: { id: 7, name: 'Buồng phòng Hai' } } }),
        'POST /api/housekeeping/manager/tasks/a2/void': record('void', 200, { voided: true }),
      }),
    );
    renderApp('/app/hk/rooms?view=groups');
    await userEvent.click(await screen.findByTestId('group-edit-1'));
    const editor = await screen.findByTestId('group-editor');
    await userEvent.type(within(editor).getByTestId('group-name'), 'Ca chiều');
    await userEvent.click(within(editor).getByTestId('group-name-save'));
    await waitFor(() => expect(calls[0]).toEqual({ url: 'rename', body: { name: 'Ca chiều' } }));

    await waitFor(() => expect([...within(editor).getByTestId('group-assignee').querySelectorAll('option')].length).toBeGreaterThan(1));
    await userEvent.selectOptions(within(editor).getByTestId('group-assignee'), '7');
    await userEvent.click(within(editor).getByTestId('group-assign-save'));
    await waitFor(() => expect(calls[1]).toEqual({ url: 'assign', body: { assigneeUserId: 7 } }));

    // A room's note appears only with "Khác", and is then required; no priority input.
    expect(within(editor).queryByTestId('item-note-a1')).not.toBeInTheDocument();
    expect(within(editor).queryByText(/Ưu tiên/)).not.toBeInTheDocument();
    await userEvent.click(within(editor).getByTestId('item-code-a1-OTHER'));
    expect(within(editor).getByTestId('item-note-a1')).toBeInTheDocument();
    expect(within(editor).getByTestId('item-save-a1')).toBeDisabled();
    await userEvent.click(within(editor).getByTestId('item-code-a1-OTHER'));
    expect(within(editor).queryByTestId('item-note-a1')).not.toBeInTheDocument();

    // Taking out a room someone holds: confirmed, with its reason.
    await userEvent.click(within(editor).getByTestId('item-remove-a2'));
    const confirm = await screen.findByTestId('item-remove-confirm');
    expect(screen.getByTestId('item-remove-dialog')).toHaveTextContent('Phòng vẫn còn trong danh sách phòng của chi nhánh');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId('item-remove-reason'), 'Khách ở thêm');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls[2]).toEqual({ url: 'void', body: { reason: 'Khách ở thêm' } }));
  });

  it('shows "Không cần dọn" requests to the manager, and approves one only after confirming', async () => {
    const decided: unknown[] = [];
    const pending = task('a1', {
      roomNumber: '101',
      floor: '1',
      taskCodes: ['OUT'],
      assignee: { id: 6, name: 'Buồng phòng Một' },
      phase: 'NO_CLEAN_PENDING',
      phaseLabel: 'Chờ duyệt không cần dọn',
      workGroup: { id: 'g1', number: 1, name: null },
      noClean: { status: 'PENDING', reason: 'Khách không muốn dọn', requestedAt: '2026-10-05T03:00:00.000Z', requestedByName: 'Buồng phòng Một', decidedAt: null, decidedByName: null, decisionNote: null },
    });
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        [GROUPS_URL]: () => ({ status: 200, body: { groups: [workGroup('g1', 1, [pending], { assignee: { id: 6, name: 'Buồng phòng Một' } })] } }),
        'POST /api/housekeeping/manager/tasks/a1/no-clean-decision': (init) => {
          decided.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: { ...pending, phase: 'NO_CLEAN', voided: true } } };
        },
      }),
    );
    renderApp('/app/hk/rooms');
    const box = await screen.findByTestId('board-no-clean');
    const row = within(box).getByTestId('no-clean-a1');
    expect(row).toHaveTextContent('Công việc 1 · Tầng 1 · Phòng 101');
    expect(row).toHaveTextContent('Lý do: Khách không muốn dọn');
    expect(row).toHaveTextContent('Buồng phòng Một');
    await userEvent.click(within(row).getByTestId('no-clean-approve-a1'));
    expect(await screen.findByTestId('no-clean-decision')).toHaveTextContent('phòng ra khỏi công việc đang làm hôm nay');
    expect(decided).toEqual([]);
    await userEvent.click(screen.getByTestId('no-clean-decision-confirm'));
    await waitFor(() => expect(decided).toEqual([{ approve: true }]));
  });

  it('lists one row per item in "Các công việc trong ngày", filters them, and reassigns one waiting for cleaning', async () => {
    const reassigned: unknown[] = [];
    const items = [
      task('w1', { roomNumber: '102', statusCode: 'OC', areaKind: 'ROOM', areaLabel: 'Phòng - 102', floor: '1', taskLabel: 'OC', phase: 'UNCLAIMED', phaseLabel: 'Chưa tiếp nhận' }),
      task('w2', {
        roomNumber: '102',
        statusCode: 'OTHER',
        areaKind: 'ROOM',
        areaLabel: 'Phòng - 102',
        floor: '1',
        taskLabel: 'Khác',
        note: 'Thay rèm cửa sổ',
        state: 'INSPECTED',
        stateLabel: 'Đã kiểm tra',
        phase: 'AWAITING_CLEANING',
        phaseLabel: 'Chờ dọn phòng',
        assignee: { id: 6, name: 'Buồng phòng Một' },
      }),
      task('w3', {
        roomNumber: 'Hành lang - Tầng 2',
        statusCode: 'OTHER',
        areaKind: 'HALLWAY',
        areaKindLabel: 'Hành lang',
        areaLabel: 'Hành lang - Tầng 2',
        floor: '2',
        taskName: 'Hút bụi thảm',
        taskLabel: 'Hút bụi thảm',
        note: 'Thảm trước phòng 201',
        phase: 'ACCEPTED',
        phaseLabel: 'Đã tiếp nhận / Chờ kiểm tra',
        assignee: { id: 7, name: 'Buồng phòng Hai' },
      }),
    ];
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: items } }),
        'POST /api/housekeeping/work-orders/w2/reassign': (init) => {
          reassigned.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: items[1] } };
        },
      }),
    );
    renderApp('/app/hk/rooms?view=list');
    const table = await screen.findByTestId('work-orders-table');
    const rowIds = () => within(table).queryAllByTestId(/^phase-/).map((b) => b.getAttribute('data-testid'));
    await waitFor(() => expect(rowIds()).toEqual(['phase-w1', 'phase-w2', 'phase-w3']));
    expect(within(table).getByTestId('phase-w2')).toHaveTextContent('Chờ dọn phòng');
    // "Giao lại" only where the item waits for cleaning.
    expect(within(table).queryByTestId('work-reassign-w1')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('work-reassign-w3')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId('work-filter-area'), 'Tầng 2');
    expect(rowIds()).toEqual(['phase-w3']);
    await userEvent.selectOptions(screen.getByTestId('work-filter-area'), '');
    await userEvent.selectOptions(screen.getByTestId('work-filter-phase'), 'UNCLAIMED');
    expect(rowIds()).toEqual(['phase-w1']);
    await userEvent.selectOptions(screen.getByTestId('work-filter-phase'), '');
    await userEvent.selectOptions(screen.getByTestId('work-filter-person'), '6');
    expect(rowIds()).toEqual(['phase-w2']);
    await userEvent.selectOptions(screen.getByTestId('work-filter-person'), 'NONE');
    expect(rowIds()).toEqual(['phase-w1']);
    await userEvent.selectOptions(screen.getByTestId('work-filter-person'), '');

    await userEvent.click(within(table).getByTestId('work-reassign-w2'));
    const dialog = await screen.findByTestId('reassign-dialog');
    const target = within(dialog).getByTestId('reassign-target');
    // The current housekeeper is not offered.
    await waitFor(() => expect([...target.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Chọn nhân viên buồng phòng —', 'Buồng phòng Hai']));
    expect(screen.getByTestId('reassign-next')).toBeDisabled();
    await userEvent.selectOptions(target, '7');
    await userEvent.type(within(dialog).getByTestId('reassign-reason'), 'Chị Một về sớm');
    await userEvent.click(screen.getByTestId('reassign-next'));
    expect(within(dialog).getByTestId('reassign-summary')).toHaveTextContent('Giao Phòng - 102 · Khác từ Buồng phòng Một cho Buồng phòng Hai?');
    expect(reassigned).toEqual([]);
    await userEvent.click(screen.getByTestId('reassign-confirm'));
    await waitFor(() => expect(reassigned).toEqual([{ assigneeUserId: 7, reason: 'Chị Một về sớm' }]));
  });
});

describe('Quản lý buồng phòng — đánh giá chất lượng', () => {
  const done = (id: string, room: string, over: Record<string, unknown> = {}) =>
    task(id, {
      roomNumber: room,
      state: 'COMPLETED',
      stateLabel: 'Hoàn thành',
      assignee: { id: 6, name: 'Buồng phòng Một' },
      cleanedBy: { id: 6, name: 'Buồng phòng Một' },
      startedAt: '2026-10-05T03:10:00.000Z',
      completedAt: '2026-10-05T03:42:00.000Z',
      durationSeconds: 32 * 60,
      review: { status: 'PENDING', label: 'Chờ đánh giá', reviewedAt: null, reviewedByName: null, failureReason: null, recleanRequested: false },
      ...over,
    });
  const BOARD = [
    task('t1', { roomNumber: '101' }),
    task('t2', { roomNumber: '102', state: 'IN_PROGRESS', stateLabel: 'Đang dọn' }),
    done('t3', '103'),
    done('t4', '104', { review: { status: 'PASSED', label: 'Đạt', reviewedAt: '2026-10-05T03:50:00.000Z', reviewedByName: 'Quản lý Buồng', failureReason: null, recleanRequested: false } }),
    task('t5', { roomNumber: '105', cycleNumber: 2, assignee: { id: 7, name: 'Buồng phòng Hai' }, reclean: { taskId: 't0', cycleNumber: 1, reason: 'Thiếu khăn tắm', reviewedByName: 'Quản lý Buồng', reviewedAt: '2026-10-05T03:00:00.000Z' } }),
  ];
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(MANAGER, {
      [TASKS_URL]: () => ({ status: 200, body: { tasks: BOARD } }),
      'GET /api/branches/1/rooms': () => ({ status: 200, body: { branchId: 1, rooms: ['101', '102', '103', '104', '105', '106'] } }),
      ...extra,
    });

  it('splits the board: each room by floor with its cleaning status, rooms waiting for review, and every item of the day', async () => {
    installApiMock(routes());
    renderApp('/app/hk/rooms');
    // "Theo tầng" (the default view): one tile per room, its latest cycle's status in words.
    const floors = await screen.findByTestId('board-floors');
    await waitFor(() => expect(within(floors).getByTestId('room-status-ROOM:101')).toHaveTextContent('Chưa dọn'));
    expect(within(floors).getByTestId('room-status-ROOM:102')).toHaveTextContent('Đang dọn');
    expect(within(floors).getByTestId('room-status-ROOM:103')).toHaveTextContent('Chờ đánh giá');
    expect(within(floors).getByTestId('room-status-ROOM:104')).toHaveTextContent('Đạt');
    expect(within(floors).getByTestId('room-status-ROOM:105')).toHaveTextContent('Cần dọn lại');
    // Cleaning status only — never occupancy.
    expect(floors).not.toHaveTextContent(/Đang thuê|Có khách|Trống/);
    // The status filter narrows the tiles.
    await userEvent.selectOptions(screen.getByTestId('room-status-filter'), 'cleaning');
    expect(within(floors).queryAllByTestId(/^room-tile-/).map((t) => t.getAttribute('data-testid'))).toEqual(['room-tile-ROOM:102']);
    await userEvent.selectOptions(screen.getByTestId('room-status-filter'), '');
    const summary = screen.getByTestId('board-summary');
    expect(within(summary).getByTestId('metric-todo')).toHaveTextContent('Chưa dọn1');
    expect(within(summary).getByTestId('metric-cleaning')).toHaveTextContent('Đang dọn1');
    expect(within(summary).getByTestId('metric-done')).toHaveTextContent('Đã dọn1');
    expect(within(summary).getByTestId('metric-review')).toHaveTextContent('Chờ đánh giá1');
    expect(within(summary).getByTestId('metric-review')).toHaveTextContent('1 cần dọn lại / không đạt');

    await userEvent.click(screen.getByTestId('board-view-groups'));
    const active = await screen.findByTestId('board-active');
    // Rooms set up before work groups existed: each its own card, in the same container.
    await waitFor(() =>
      expect(within(active).getAllByRole('article').map((a) => a.getAttribute('data-testid'))).toEqual(['older-task-101', 'older-task-102', 'older-task-105']),
    );
    // A re-clean, marked.
    expect(within(active).getByTestId('older-task-105')).toHaveTextContent('Cần dọn lại');
    // Waiting for the manager: its own area, with who, when and how long.
    const review = screen.getByTestId('board-review');
    expect(within(review).queryAllByTestId(/^review-card-/).map((c) => c.getAttribute('data-testid'))).toEqual(['review-card-103']);
    const card = within(review).getByTestId('review-card-103');
    expect(card).toHaveTextContent('Phòng 103');
    expect(card).toHaveTextContent('Nhân viên:Buồng phòng Một');
    expect(card).toHaveTextContent('Thời gian dọn:32 phút');
    // Every item of the day is also a row of "Các công việc trong ngày" ("Danh sách").
    await userEvent.click(screen.getByTestId('board-view-list'));
    const table = await screen.findByTestId('work-orders-table');
    await waitFor(() => expect(within(table).queryAllByTestId(/^phase-/)).toHaveLength(5));
  });

  it('confirms "Đạt", and sends "Không đạt" only with its reason — with the re-clean for the chosen worker', async () => {
    const posted: unknown[] = [];
    installApiMock(
      routes({
        'POST /api/housekeeping/manager/tasks/t3/review': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: done('t3', '103'), reclean: null } };
        },
      }),
    );
    renderApp('/app/hk/rooms');
    await userEvent.click(await screen.findByTestId('review-pass-103'));
    await userEvent.click(await screen.findByTestId('pass-confirm'));
    await waitFor(() => expect(posted).toEqual([{ result: 'PASSED' }]));

    await userEvent.click(screen.getByTestId('review-fail-103'));
    const confirm = await screen.findByTestId('fail-confirm');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('fail-reclean')).toBeChecked();
    await userEvent.type(screen.getByTestId('fail-reason'), '   ');
    expect(confirm).toBeDisabled();
    await userEvent.clear(screen.getByTestId('fail-reason'));
    await userEvent.type(screen.getByTestId('fail-reason'), 'Thiếu khăn tắm');
    await waitFor(() => expect([...screen.getByTestId('fail-assignee').querySelectorAll('option')].length).toBeGreaterThan(1));
    expect(screen.getByTestId('fail-assignee')).toHaveValue('6');
    await userEvent.selectOptions(screen.getByTestId('fail-assignee'), '7');
    await userEvent.click(confirm);
    await waitFor(() => expect(posted[1]).toEqual({ result: 'FAILED', reason: 'Thiếu khăn tắm', reclean: true, assigneeUserId: 7 }));

    // Without "Yêu cầu dọn lại": no worker to choose, none sent.
    await userEvent.click(screen.getByTestId('review-fail-103'));
    await userEvent.type(await screen.findByTestId('fail-reason'), 'Khách đã nhận phòng');
    await userEvent.click(screen.getByTestId('fail-reclean'));
    expect(screen.queryByTestId('fail-assignee')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('fail-confirm'));
    await waitFor(() => expect(posted[2]).toEqual({ result: 'FAILED', reason: 'Khách đã nhận phòng', reclean: false }));
  });

  it('shows every cleaning cycle of the room, with its review — from the review card', async () => {
    const first = done('t0', '105', {
      review: { status: 'FAILED', label: 'Không đạt', reviewedAt: '2026-10-05T03:00:00.000Z', reviewedByName: 'Quản lý Buồng', failureReason: 'Thiếu khăn tắm', recleanRequested: true },
      nextCycleId: 't5',
    });
    const second = done('t5', '105', {
      cycleNumber: 2,
      assignee: { id: 7, name: 'Buồng phòng Hai' },
      cleanedBy: { id: 7, name: 'Buồng phòng Hai' },
      completedAt: '2026-10-05T04:05:00.000Z',
      reclean: { taskId: 't0', cycleNumber: 1, reason: 'Thiếu khăn tắm', reviewedByName: 'Quản lý Buồng', reviewedAt: '2026-10-05T03:00:00.000Z' },
    });
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [first, second] } }),
        'GET /api/housekeeping/manager/tasks/t5/history': () => ({ status: 200, body: { cycles: [first, second] } }),
        'GET /api/branches/1/rooms': () => ({ status: 200, body: { branchId: 1, rooms: ['105'] } }),
      }),
    );
    renderApp('/app/hk/rooms');
    // The failed cycle is history; only its re-clean waits for review — and holds the room.
    const card = await screen.findByTestId('review-card-105');
    expect(card).toHaveTextContent('Lần dọn 2');
    expect(card).toHaveTextContent('Nhân viên:Buồng phòng Hai');
    await userEvent.click(within(card).getByRole('button', { name: 'Xem chi tiết phòng 105' }));
    const history = await screen.findByTestId('cycle-history');
    const one = await within(history).findByTestId('cycle-1');
    expect(one).toHaveTextContent('Không đạt');
    expect(one).toHaveTextContent('Người dọn:Buồng phòng Một');
    expect(one).toHaveTextContent('Người đánh giá:Quản lý Buồng');
    expect(one).toHaveTextContent('Yêu cầu dọn lại:Có');
    expect(one).toHaveTextContent('Lý do: Thiếu khăn tắm');
    const two = within(history).getByTestId('cycle-2');
    expect(two).toHaveTextContent('Chờ đánh giá');
    expect(two).toHaveTextContent('Người dọn:Buồng phòng Hai');
    expect(within(history).getByTestId('cycle-current')).toHaveTextContent('Hiện tại: Chờ đánh giá');
  });
});

describe('Quản lý buồng phòng — Phân công công việc', () => {
  const routes = (extra: Record<string, Handler> = {}, user: AuthUser = MANAGER) =>
    shell(user, {
      [TASKS_URL]: () => ({
        status: 200,
        body: { tasks: [task('t1', { assignee: { id: 6, name: 'Buồng phòng Một' } }), task('t2', { roomNumber: '102', priority: true })] },
      }),
      'GET /api/housekeeping/manager/tasks/t1/history': () => ({ status: 200, body: { cycles: [task('t1', { assignee: { id: 6, name: 'Buồng phòng Một' } })] } }),
      ...extra,
    });

  it('sends an old "Phân công công việc" link to "Tình trạng phòng" — Danh sách — for the manager and the Admin alike', async () => {
    installApiMock(routes());
    const first = renderApp('/app/hk/assign?from=menu');
    // The list of the day's items, in "Tình trạng phòng"; no separate assignment screen.
    expect(await screen.findByTestId('work-orders-table')).toBeInTheDocument();
    expect(screen.getByTestId('board-view-list')).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: 'Phân công ca, việc làm' })).toBeInTheDocument();
    expect(screen.queryByTestId('assign-table')).not.toBeInTheDocument();
    first.unmount();

    installApiMock(routes({}, ADMIN_USER));
    renderApp('/app/hk/assign');
    // The Admin picks the branch on the board, as everywhere on it.
    await userEvent.click(await screen.findByTestId('branch-select'));
    await userEvent.click(await screen.findByTestId('branch-option-1'));
    expect(await screen.findByTestId('work-orders-table')).toBeInTheDocument();
    expect(screen.getByTestId('board-view-list')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the room’s detail compactly and read-only — no status, assignee, priority or note to edit — beside its history', async () => {
    installApiMock(routes());
    renderApp('/app/hk/rooms?view=list');
    await userEvent.click(await screen.findByTestId('work-open-t1'));
    const dialog = await screen.findByRole('dialog', { name: /Phòng 101/ });
    // The key facts in one row: the work, where it stands, who has it.
    const facts = within(dialog).getByTestId('task-facts');
    expect(facts).toHaveTextContent('OUT');
    expect(facts).toHaveTextContent('Chưa bắt đầu');
    expect(facts).toHaveTextContent('Người làm: Buồng phòng Một');
    expect(within(dialog).getByTestId('task-history')).toHaveTextContent('Tạo công việc · Quản lý Buồng');
    // Nothing of the old "Điều chỉnh" block: assigning and editing belong to the group and "Giao lại".
    for (const id of ['task-code', 'task-assignee', 'task-priority', 'task-note', 'task-save']) {
      expect(within(dialog).queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByText('Điều chỉnh')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Ưu tiên/)).not.toBeInTheDocument();
    expect(within(dialog).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(0);
    // One cycle only: no second copy of the same record as "Lịch sử các lần dọn".
    await waitFor(() => expect(within(dialog).queryByTestId('cycle-history')).not.toBeInTheDocument());
    // Still there: "Xóa" (confirmed) and "Đóng".
    expect(within(dialog).getByTestId('task-void-open')).toBeInTheDocument();
  });

  it('removes a room from the day only with the confirmation, sending the reason', async () => {
    const voided: unknown[] = [];
    installApiMock(
      routes({
        'POST /api/housekeeping/manager/tasks/t1/void': (init) => {
          voided.push(JSON.parse(String(init.body)));
          return { status: 200, body: { voided: true } };
        },
      }),
    );
    renderApp('/app/hk/rooms?view=list');
    await userEvent.click(await screen.findByTestId('work-open-t1'));
    await userEvent.click(await screen.findByTestId('task-void-open'));
    // The evidence is kept — and the dialog says so.
    expect(await screen.findByText(/Kiểm phòng, phát sinh, thu tiền và lịch sử vẫn được giữ/)).toBeInTheDocument();
    expect(voided).toEqual([]);
    await userEvent.type(screen.getByTestId('task-void-reason'), 'Khách gia hạn');
    await userEvent.click(screen.getByTestId('task-void-confirm'));
    await waitFor(() => expect(voided).toEqual([{ reason: 'Khách gia hạn' }]));
  });
});

describe('Quản lý buồng phòng — Theo dõi nhân viên, KPI, Báo cáo', () => {
  const PERIOD = `from=${TODAY}&to=${TODAY}`;

  it('shows each worker’s shift and progress, and opens its full detail: rooms with their cleaning, findings and money', async () => {
    const shiftOf = (id: string, userId: number, fullName: string, startedAt: string, endedAt: string | null) => ({
      id,
      user: { id: userId, fullName },
      startedAt,
      endedAt,
      segments: [{ id: `${id}-seg`, branch: BRANCH, staffName: fullName, startedAt, endedAt, rooms: 0, inspections: 0, issues: 0, byType: [] }],
      current: null,
      totals: { rooms: 0, inspections: 0, issues: 0, byType: [] },
    });
    installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/staff-progress?${PERIOD}`]: () => ({
          status: 200,
          body: {
            rows: [
              { ...KPI_ROW, assigned: 6, notStarted: 1, inProgress: 2, completed: 3, completionRate: 50 },
              { ...KPI_ROW, userId: 7, fullName: 'Buồng phòng Hai', assigned: 2, notStarted: 2, inProgress: 0, completed: 0, completionRate: 0 },
            ],
          },
        }),
        // Real shifts on record: one open now, and a third person on shift with no room yet.
        [`GET /api/housekeeping/shifts?${PERIOD}`]: () => ({
          status: 200,
          body: { shifts: [shiftOf('s1', 6, 'Buồng phòng Một', `${TODAY}T00:10:00.000Z`, null), shiftOf('s3', 8, 'Buồng phòng Ba', `${TODAY}T00:30:00.000Z`, `${TODAY}T08:30:00.000Z`)] },
        }),
        [`GET /api/housekeeping/manager/work-groups?date=${TODAY}`]: () => ({ status: 200, body: { groups: [workGroup('g9', 3, [task('z1')])] } }),
        [`GET /api/housekeeping/manager/staff/6?${PERIOD}`]: () => ({
          status: 200,
          body: {
            employee: { id: 6, fullName: 'Buồng phòng Một' },
            kpi: KPI_ROW,
            tasks: [
              task('t1', {
                assignee: { id: 6, name: 'Buồng phòng Một' },
                state: 'COMPLETED',
                stateLabel: 'Hoàn thành',
                durationSeconds: 2520,
                cleaning: { linen: { BED_SHEET: { size: 'Q', quantity: 2 } }, quantities: { BATH_TOWEL: 2 }, replaced: ['SHAMPOO'], special: ['DND'], note: null },
              }),
            ],
            findings: [],
            shifts: [],
          },
        }),
      }),
    );
    renderApp('/app/hk/staff');
    const table = await screen.findByTestId('staff-table');
    expect(await within(table).findByText('50%')).toBeInTheDocument();
    // The shift: on shift since 07:10 (Asia/Ho_Chi_Minh), ended, or not started — said in words.
    await waitFor(() => expect(within(table).getByText('07:10 – đang mở')).toBeInTheDocument());
    expect(within(table).getAllByText('Đang trong ca', { selector: 'span' }).length).toBeGreaterThan(0);
    expect(within(table).getByText('07:30 – 15:30')).toBeInTheDocument();
    expect(within(table).getAllByText('Chưa vào ca', { selector: 'span' }).length).toBeGreaterThan(0);
    const team = screen.getByTestId('staff-summary');
    expect(team).toHaveTextContent('Nhân viên trong ca1');
    expect(team).toHaveTextContent('Công việc được giao8');
    expect(team).toHaveTextContent('Đã hoàn thành3');
    // Real conditions only: work left with someone off shift, and a group nobody took.
    const attention = screen.getByTestId('staff-attention');
    expect(attention).toHaveTextContent('1 nhân viên còn việc nhưng không trong ca');
    expect(attention).toHaveTextContent('Buồng phòng Hai (2 việc chưa xong)');
    await waitFor(() => expect(attention).toHaveTextContent('1 công việc chưa có người nhận'));
    expect(within(screen.getByTestId('staff-timeline')).getByText('Buồng phòng Ba')).toBeInTheDocument();
    // The status filter and the search narrow the table.
    await userEvent.selectOptions(screen.getByTestId('staff-state'), 'ON_SHIFT');
    expect(within(table).queryAllByTestId(/^staff-open-/).map((b) => b.getAttribute('data-testid'))).toEqual(['staff-open-6']);
    await userEvent.selectOptions(screen.getByTestId('staff-state'), '');
    await userEvent.type(screen.getByTestId('staff-search'), 'ba');
    expect(within(table).queryAllByTestId(/^staff-open-/).map((b) => b.getAttribute('data-testid'))).toEqual(['staff-open-8']);
    await userEvent.clear(screen.getByTestId('staff-search'));
    await userEvent.click(within(table).getByTestId('staff-open-6'));
    const detail = await screen.findByTestId('staff-detail');
    expect(detail).toHaveTextContent('500.000 ₫');
    await userEvent.click(within(detail).getByTestId('staff-task-t1'));
    const cleaning = within(detail).getByTestId('task-cleaning');
    expect(cleaning).toHaveTextContent('Ga giường: Queen × 2');
    expect(cleaning).toHaveTextContent('Ghi nhận đặc biệt: DND (Không làm phiền)');
    expect(cleaning).toHaveTextContent('Khăn tắm: 2');
    expect(cleaning).toHaveTextContent('Dầu gội');
    expect(within(detail).getByTestId('staff-task-t1')).toHaveTextContent('42 phút');
  });

  it('shows the KPI totals and asks again for one collection status', async () => {
    const fetchMock = installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/kpi?${PERIOD}`]: () => ({
          status: 200,
          body: {
            rows: [KPI_ROW],
            totals: { ...KPI_ROW, userId: undefined, fullName: undefined },
            findings: [
              finding('f1', `${TODAY}T02:15:00.000Z`, 'COLLECTED', 500000),
              finding('f2', `${TODAY}T02:40:00.000Z`, 'PENDING', 200000),
            ],
          },
        }),
        [`GET /api/housekeeping/manager/kpi?${PERIOD}&status=COLLECTED`]: () => ({
          status: 200,
          body: { rows: [], totals: { inspections: 0, findings: 0, collectedCount: 0, pendingCount: 0, uncollectibleCount: 0, collectedAmount: 0, pendingAmount: 0 }, findings: [] },
        }),
      }),
    );
    renderApp('/app/hk/kpi');
    const totals = await screen.findByTestId('kpi-totals');
    for (const text of ['Lượt kiểm phòng4', 'Phát sinh2', 'Tổng tiền đã thu500.000 ₫', 'Chưa thu200.000 ₫', 'Không thu được0 khoản']) expect(totals).toHaveTextContent(text);
    expect(screen.getByTestId('kpi-collected')).toHaveTextContent('1 khoản đã thu');
    // No second copy of the same figures: the totals above are the summary.
    expect(screen.queryByTestId('kpi-collection')).not.toBeInTheDocument();
    // One day: the findings by hour, each in its hour (09:00 Asia/Ho_Chi_Minh), by collection status.
    const bucket = await screen.findByTestId('kpi-chart-bars-bucket-09');
    expect(bucket).toHaveAccessibleName('09:00–10:00 — Đã thu: 1 khoản, Chưa thu: 1 khoản, Không thu được: 0 khoản');
    const row = within(screen.getByTestId('kpi-table')).getByText('Buồng phòng Một').closest('tr')!;
    expect(row).toHaveTextContent('50%');
    // The search narrows the table to matching people.
    await userEvent.type(screen.getByTestId('kpi-search'), 'không có ai');
    expect(within(screen.getByTestId('kpi-table')).queryByText('Buồng phòng Một')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByTestId('kpi-search'));
    await userEvent.selectOptions(screen.getByTestId('kpi-status'), 'COLLECTED');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/housekeeping/manager/kpi?${PERIOD}&status=COLLECTED`)).toBe(true),
    );
  });

  it('offers the operations report as PDF and Excel — filtered by worker, type and search on the server, the files with the very same filters', async () => {
    const row = (over: Record<string, unknown> = {}) => ({
      branchLabel: 'Chi nhánh 1 — 05 Trương Định',
      workDate: TODAY,
      employee: 'Buồng phòng Một',
      assigned: 4,
      completed: 3,
      completionRate: 75,
      inspections: 3,
      findings: 1,
      avgCleaningSeconds: 1800,
      collectedAmount: 500000,
      pendingAmount: 0,
      pendingCount: 0,
      uncollectibleCount: 1,
      voided: 0,
      notes: 0,
      ...over,
    });
    const answer = (rows: unknown[]) => () => ({
      status: 200,
      body: { from: TODAY, to: TODAY, filters: { type: 'ALL', typeLabel: 'Tổng hợp vận hành', employee: null, q: null }, rows, findings: [] },
    });
    const fetchMock = installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/report?${PERIOD}`]: answer([row(), row({ employee: 'Buồng phòng Hai', assigned: 2, completed: 0, completionRate: 0, avgCleaningSeconds: null, inspections: 0, findings: 0, collectedAmount: 0, uncollectibleCount: 0 })]),
        [`GET /api/housekeeping/manager/report?${PERIOD}&userId=6`]: answer([row()]),
        [`GET /api/housekeeping/manager/report?${PERIOD}&userId=6&type=INSPECTION`]: answer([row({ assigned: 0, completed: 0, completionRate: 0, avgCleaningSeconds: null })]),
        [`GET /api/housekeeping/manager/report?${PERIOD}&userId=6&type=INSPECTION&q=101`]: answer([]),
      }),
    );
    const asked = (url: string) => fetchMock.mock.calls.some(([u]) => String(u) === url);
    renderApp('/app/hk/report');
    expect(await screen.findByRole('heading', { name: 'Báo cáo vận hành buồng phòng' })).toBeInTheDocument();
    const report = screen.getByTestId('hk-report');
    expect(await within(report).findByText('3 (75%)')).toBeInTheDocument();
    expect(within(report).getByText('30 phút')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bộ lọc báo cáo' })).toBe(screen.getByTestId('hk-period'));
    // Excel first (the primary action), then PDF — beside the title.
    expect(within(screen.getByTestId('hk-report-export')).getAllByRole('link').map((l) => l.textContent)).toEqual(['Xuất Excel', 'Xuất PDF']);
    const summary = screen.getByTestId('hk-report-summary');
    for (const text of ['Công việc được giao6', 'Đã hoàn thành3', '50% công việc được giao', 'Lượt kiểm phòng3', 'Phát sinh1', 'Tiền đã thu500.000 ₫']) expect(summary).toHaveTextContent(text);
    // The chart is the real day: 6 given, 3 done.
    expect(await screen.findByTestId(`hk-report-bars-bucket-${TODAY}`)).toHaveAccessibleName(/Được giao: 6 công việc, Hoàn thành: 3 công việc/);
    // "Không thu được" from the same filtered rows — a count, never an amount.
    expect(screen.getByTestId('hk-report-collection')).toHaveTextContent('Không thu được1 khoản');
    expect(screen.getByTestId('hk-report-totals')).toHaveTextContent('Hoàn thành 3/6 phòng');
    expect(screen.getByTestId('hk-report-pdf')).toHaveAttribute('href', `/api/housekeeping/manager/report.pdf?${PERIOD}`);
    expect(screen.getByTestId('hk-report-xlsx')).toHaveAttribute('href', `/api/housekeeping/manager/report.xlsx?${PERIOD}`);

    // One worker: the server is asked for it; the table, the figures and both files follow.
    await waitFor(() => expect(screen.getByTestId('report-employee').querySelectorAll('option').length).toBeGreaterThan(1));
    await userEvent.selectOptions(screen.getByTestId('report-employee'), '6');
    await waitFor(() => expect(asked(`/api/housekeeping/manager/report?${PERIOD}&userId=6`)).toBe(true));
    await waitFor(() => expect(within(report).queryByText('Buồng phòng Hai')).not.toBeInTheDocument());
    expect(screen.getByTestId('hk-report-summary')).toHaveTextContent('Công việc được giao4');
    expect(screen.getByTestId('hk-report-xlsx')).toHaveAttribute('href', `/api/housekeeping/manager/report.xlsx?${PERIOD}&userId=6`);

    // "Kiểm phòng & thu tiền": the inspections' figures only, their own chart and columns.
    await userEvent.selectOptions(screen.getByTestId('report-type'), 'INSPECTION');
    await waitFor(() => expect(asked(`/api/housekeeping/manager/report?${PERIOD}&userId=6&type=INSPECTION`)).toBe(true));
    await waitFor(() => expect(screen.getByTestId('hk-report-summary')).not.toHaveTextContent('Công việc được giao'));
    expect(screen.getByTestId('hk-report-summary')).toHaveTextContent('Lượt kiểm phòng3');
    expect(within(screen.getByTestId('hk-report-chart')).getByRole('heading')).toHaveTextContent('Kiểm phòng và phát sinh theo ngày');
    expect([...report.querySelectorAll('thead th')].map((th) => th.textContent)).not.toContain('Được giao');
    expect(screen.getByTestId('hk-report-pdf')).toHaveAttribute('href', `/api/housekeeping/manager/report.pdf?${PERIOD}&userId=6&type=INSPECTION`);

    // A search: sent to the server once typing pauses — and carried into both files.
    await userEvent.type(screen.getByTestId('report-search'), '101');
    await waitFor(() => expect(asked(`/api/housekeeping/manager/report?${PERIOD}&userId=6&type=INSPECTION&q=101`)).toBe(true));
    expect(await within(report).findByText('Không có dữ liệu khớp bộ lọc')).toBeInTheDocument();
    expect(screen.getByTestId('hk-report-xlsx')).toHaveAttribute('href', `/api/housekeeping/manager/report.xlsx?${PERIOD}&userId=6&type=INSPECTION&q=101`);
    expect(screen.getByTestId('hk-report-pdf')).toHaveAttribute('href', `/api/housekeeping/manager/report.pdf?${PERIOD}&userId=6&type=INSPECTION&q=101`);

    // "Xóa bộ lọc": back to the whole period.
    await userEvent.click(screen.getByTestId('report-clear'));
    expect(await within(report).findByText('Buồng phòng Hai')).toBeInTheDocument();
    expect(screen.getByTestId('hk-report-xlsx')).toHaveAttribute('href', `/api/housekeeping/manager/report.xlsx?${PERIOD}`);
  });
});

describe('"Phân công ca, việc làm" — today and the days before it', () => {
  it('sends a later day to "Phân công việc ngày hôm sau", and reads a past day without giving out work', async () => {
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [] } }),
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({ status: 200, body: { areas: { branchId: 1, ...AREAS } } }),
      }),
    );
    renderApp('/app/hk/rooms');
    const date = await screen.findByTestId('hk-date');
    expect(date).toHaveAttribute('max', TODAY);
    expect(await screen.findByTestId('work-create-open')).toBeInTheDocument();
    // A later day: not scheduled here — the page says where.
    fireEvent.change(date, { target: { value: hcmTomorrow() } });
    const future = await screen.findByTestId('board-future');
    expect(within(future).getByTestId('board-future-link')).toHaveAttribute('href', '/app/hk/tomorrow');
    expect(screen.queryByTestId('work-create-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board-summary')).not.toBeInTheDocument();
    await userEvent.click(within(future).getByTestId('board-future-today'));
    expect(await screen.findByTestId('work-create-open')).toBeInTheDocument();
    // A past day: read as that day, never as today's active work.
    fireEvent.change(screen.getByTestId('hk-date'), { target: { value: '2020-01-02' } });
    expect(await screen.findByTestId('board-past')).toHaveTextContent('02/01/2020');
    expect(screen.queryByTestId('work-create-open')).not.toBeInTheDocument();
  });
});
