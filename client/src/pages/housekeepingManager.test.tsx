/**
 * "QUẢN LÝ BUỒNG PHÒNG" — the manager's six screens over its one branch.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The role lands on "Tổng quan" with exactly its six menu entries, its
 *      branch fixed and named — no picker.
 *   2. "+ Tạo công việc" saves ONE work group: its optional name, then floor →
 *      tiles (several places) → each place's own checkboxes (one of OUT / OC /
 *      VC, and/or Khác), note and priority — after a review, one POST with one
 *      request id. "Phòng đang thực hiện" shows the day's groups as numbered
 *      cards ("Công việc 1, 2, …"), never by OUT / OC / VC; "Chỉnh sửa" renames,
 *      gives the whole group, takes one room out with its confirmation;
 *      "Không cần dọn" waits for the manager's confirmed decision.
 *   3. "Phân công công việc" assigns from the row; the room's dialog edits,
 *      shows the history, and voids with a reason.
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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';
import { hcmToday } from '../lib/format';

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

describe('Quản lý buồng phòng — menu and overview', () => {
  it('lands on "Tổng quan" with its six entries and its one branch, fixed', async () => {
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
      }),
    );
    renderApp('/app');
    const overview = await screen.findByTestId('hk-overview');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Tổng quan',
      'Tình trạng phòng',
      'Phân công công việc',
      'Theo dõi nhân viên',
      'KPI & Thu tiền',
      'Báo cáo',
    ]);
    // The sections are headings, not levels.
    expect(within(nav).getByText('Vận hành')).toBeInTheDocument();
    expect(within(nav).getByText('KPI & Báo cáo')).toBeInTheDocument();
    // Quản lý buồng phòng · Chi nhánh · Ngày nghiệp vụ — then the page's title.
    const context = screen.getByTestId('hk-context');
    expect(context).toHaveTextContent('Quản lý buồng phòng');
    expect(screen.getByTestId('manager-branch')).toHaveTextContent('Chi nhánh 1 — 05 Trương Định');
    expect(screen.getByTestId('hk-period-value')).toHaveTextContent(TODAY.split('-').reverse().join('/'));
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeInTheDocument();
    expect(screen.queryByTestId('branch-select')).not.toBeInTheDocument();
    expect(overview).toHaveTextContent('Tổng phòng12');
    expect(overview).toHaveTextContent('Đang dọn3');
    expect(within(screen.getByTestId('hk-quick')).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/app/hk/rooms',
      '/app/hk/assign',
      '/app/hk/staff',
      '/app/hk/kpi',
      '/app/hk/report',
    ]);
    expect(overview).toHaveTextContent('500.000 ₫');
    expect(within(overview).getAllByText('Buồng phòng Một')).toHaveLength(2);
  });

  it('gives the Admin the same screens as one menu group', async () => {
    installApiMock(
      shell(ADMIN_USER, {
        [`GET /api/housekeeping/manager/overview?date=${TODAY}`]: () => ({
          status: 200,
          body: {
            workDate: TODAY,
            rooms: { total: 0, notStarted: 0, inProgress: 0, completed: 0, priority: 0, unassigned: 0 },
            working: [],
            employees: [],
            inspections: 0,
            findings: 0,
            collectedAmount: 0,
            pendingCollections: 0,
          },
        }),
      }),
    );
    renderApp('/app/hk/overview');
    // Every branch at once — no branch in the request.
    expect(await screen.findByTestId('hk-overview')).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    // Open, since the page is inside it.
    expect(within(nav).getByTestId('nav-group-Quản lý buồng phòng')).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Phân công công việc' })).toHaveAttribute('href', '/app/hk/assign');
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
    expect(await screen.findByRole('heading', { name: `Tình trạng phòng ngày ${TODAY.split('-').reverse().join('/')}` })).toBeInTheDocument();
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
    expect(tileOrder()).toEqual(before);
    expect(floor0).toBeDisabled();

    // "+ Thêm khu vực": Khu vực 2 — Tầng 2, its own tiles; Tầng 1 is already taken.
    await userEvent.click(within(dialog).getByTestId('place-add-section'));
    const floor1 = within(dialog).getByTestId('place-floor-1');
    expect(within(floor1).getByRole('option', { name: /Tầng 1/ })).toBeDisabled();
    await userEvent.selectOptions(floor1, '2');
    await userEvent.click(within(dialog).getByTestId('place-tile-ROOM:201'));
    await userEvent.click(within(dialog).getByTestId('place-code-ROOM:201-OUT'));
    // What was entered on Tầng 1 is all still there.
    await userEvent.click(within(dialog).getByTestId('place-open-ROOM:101'));
    expect(within(dialog).getByTestId('place-note-ROOM:101')).toHaveValue('Thay rèm');

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
    expect(within(review).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '1. Tầng 1 · Phòng 101 · OC + KhácGhi chú: Thay rèm',
      '2. Tầng 1 · Phòng 102 · VC',
      '3. Tầng 1 · Hành lang · KhácGhi chú: Lau sàn',
      '4. Tầng 2 · Phòng 201 · OUT',
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
    renderApp('/app/hk/rooms');
    const bar = await screen.findByTestId('manager-shift');
    // Off shift: nothing to take yet.
    await waitFor(() => expect(within(bar).getByTestId('manager-shift-start')).toBeEnabled());
    expect(await screen.findByTestId('group-accept-1')).toBeDisabled();
    await userEvent.click(within(bar).getByTestId('manager-shift-start'));
    // No address: the manager works at its own branch.
    await waitFor(() => expect(started).toEqual([{}]));
    expect(await within(bar).findByTestId('manager-shift-end')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('group-accept-1')).toBeEnabled());
    await userEvent.click(screen.getByTestId('group-accept-1'));
    await userEvent.click(await screen.findByTestId('group-accept-confirm'));
    await waitFor(() => expect(accepted).toEqual(['g1']));
    // Its own group: "Công việc của bạn", and the next step on its room.
    const two = screen.getByTestId('group-card-2');
    expect(within(two).getByTestId('group-mine-2')).toHaveTextContent('Công việc của bạn');
    expect(within(two).getByTestId('work-step-b1')).toHaveTextContent('Kiểm tra');
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
    renderApp('/app/hk/rooms');
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
    expect(screen.getByTestId('metric-groups')).toHaveTextContent('2');
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
    renderApp('/app/hk/rooms');
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
    renderApp('/app/hk/rooms');
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

  it('splits the board: rooms being cleaned, rooms waiting for review, and every item of the day', async () => {
    installApiMock(routes());
    renderApp('/app/hk/rooms');
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
    expect(card).toHaveTextContent('PHÒNG 103');
    expect(card).toHaveTextContent('Nhân viên:Buồng phòng Một');
    expect(card).toHaveTextContent('Thời gian dọn:32 phút');
    // Every item of the day is also a row of "Các công việc trong ngày".
    const table = await screen.findByTestId('work-orders-table');
    await waitFor(() => expect(within(table).queryAllByTestId(/^phase-/)).toHaveLength(5));
    const summary = screen.getByTestId('board-summary');
    for (const text of ['Đang thực hiện3', 'Cần dọn lại1', 'Chờ đánh giá1', 'Đạt1']) expect(summary).toHaveTextContent(text);
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
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(MANAGER, {
      [TASKS_URL]: () => ({
        status: 200,
        body: { tasks: [task('t1', { assignee: { id: 6, name: 'Buồng phòng Một' } }), task('t2', { roomNumber: '102', priority: true })] },
      }),
      'GET /api/housekeeping/manager/tasks/t1/history': () => ({ status: 200, body: { cycles: [task('t1', { assignee: { id: 6, name: 'Buồng phòng Một' } })] } }),
      ...extra,
    });

  it('reassigns a room from its row, priority rooms first', async () => {
    const posted: unknown[] = [];
    installApiMock(
      routes({
        'POST /api/housekeeping/manager/tasks/t1/assign': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: task('t1', { assignee: { id: 7, name: 'Buồng phòng Hai' } }) } };
        },
      }),
    );
    renderApp('/app/hk/assign');
    const table = await screen.findByTestId('assign-table');
    const select = await within(table).findByTestId('assign-101');
    // The priority room heads the list.
    const selects = within(table).getAllByRole('combobox');
    expect(selects[0]).toHaveAccessibleName('Người được giao phòng 102');
    await waitFor(() => expect(select).toHaveValue('6'));
    await userEvent.selectOptions(select, '7');
    await waitFor(() => expect(posted).toEqual([{ assigneeUserId: 7 }]));
  });

  it('offers only the branch’s own workers — the list the server scopes', async () => {
    const fetchMock = installApiMock(
      routes({
        // The server's answer for this branch: its one worker, not every account.
        [`GET /api/housekeeping/manager/staff?branchId=1`]: () => ({ status: 200, body: { staff: [{ id: 6, fullName: 'Buồng phòng Một' }] } }),
      }),
    );
    renderApp('/app/hk/assign');
    const select = await screen.findByTestId('assign-102');
    await waitFor(() => expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Chưa giao —', 'Buồng phòng Một']));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/housekeeping/manager/staff?branchId=1`)).toBe(true);
    // Columns as a manager reads them.
    const table = screen.getByTestId('assign-table');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent).filter(Boolean)).toEqual([
      'Phòng',
      'Tình trạng',
      'Ưu tiên',
      'Nhân viên',
      'Trạng thái',
      'Thời gian',
      'Thao tác',
    ]);
    expect(within(table).getByText('1 phòng chưa giao')).toBeInTheDocument();
  });

  it('edits a room’s code, priority and note in its dialog, beside the history', async () => {
    const patched: unknown[] = [];
    installApiMock(
      routes({
        'PATCH /api/housekeeping/manager/tasks/t1': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: task('t1') } };
        },
      }),
    );
    renderApp('/app/hk/assign');
    await userEvent.click(await screen.findByTestId('task-open-101'));
    const dialog = await screen.findByRole('dialog', { name: /Phòng 101/ });
    expect(within(dialog).getByTestId('task-history')).toHaveTextContent('Tạo công việc · Quản lý Buồng');
    // OUT, OC, VC — there is no CC.
    await waitFor(() => expect(within(dialog).getByTestId('task-code').querySelectorAll('option')).toHaveLength(3));
    expect([...within(dialog).getByTestId('task-code').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['OUT', 'OC', 'VC']);
    await userEvent.selectOptions(within(dialog).getByTestId('task-code'), 'VC');
    await userEvent.click(within(dialog).getByTestId('task-priority'));
    await userEvent.type(within(dialog).getByTestId('task-note'), 'Khách VIP');
    await userEvent.click(within(dialog).getByTestId('task-save'));
    await waitFor(() => expect(patched).toEqual([{ statusCode: 'VC', priority: true, note: 'Khách VIP' }]));
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
    renderApp('/app/hk/assign');
    await userEvent.click(await screen.findByTestId('task-open-101'));
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

  it('opens a worker’s full detail: rooms with their cleaning, findings and money', async () => {
    installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/staff-progress?${PERIOD}`]: () => ({
          status: 200,
          body: { rows: [{ ...KPI_ROW, assigned: 6, notStarted: 1, inProgress: 2, completed: 3, completionRate: 50 }] },
        }),
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
    // The status: once in its column, once in the phone's folded row.
    expect(within(table).getAllByText('Đang dọn', { selector: 'span' })).toHaveLength(2);
    const team = screen.getByTestId('staff-summary');
    expect(team).toHaveTextContent('Được giao6');
    expect(team).toHaveTextContent('Hoàn thành3');
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
          body: { rows: [KPI_ROW], totals: { ...KPI_ROW, userId: undefined, fullName: undefined }, findings: [] },
        }),
        [`GET /api/housekeeping/manager/kpi?${PERIOD}&status=COLLECTED`]: () => ({
          status: 200,
          body: { rows: [], totals: { inspections: 0, findings: 0, collectedCount: 0, pendingCount: 0, uncollectibleCount: 0, collectedAmount: 0, pendingAmount: 0 }, findings: [] },
        }),
      }),
    );
    renderApp('/app/hk/kpi');
    const totals = await screen.findByTestId('kpi-totals');
    expect(within(totals).getByRole('heading', { name: 'KPI vận hành' })).toBeInTheDocument();
    expect(within(totals).getByRole('heading', { name: 'Thu tiền' })).toBeInTheDocument();
    expect(screen.getByTestId('kpi-collected')).toHaveTextContent('500.000 ₫');
    expect(totals).toHaveTextContent('200.000 ₫');
    expect(within(screen.getByTestId('kpi-table')).getByText('Buồng phòng Một')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('kpi-status'), 'COLLECTED');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/housekeeping/manager/kpi?${PERIOD}&status=COLLECTED`)).toBe(true),
    );
  });

  it('offers the operations report as PDF and Excel for the chosen period', async () => {
    installApiMock(
      shell(MANAGER, {
        [`GET /api/housekeeping/manager/report?${PERIOD}`]: () => ({
          status: 200,
          body: {
            from: TODAY,
            to: TODAY,
            rows: [
              {
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
                voided: 0,
                notes: 0,
              },
            ],
          },
        }),
      }),
    );
    renderApp('/app/hk/report');
    expect(await screen.findByRole('heading', { name: 'Báo cáo vận hành buồng phòng' })).toBeInTheDocument();
    const report = screen.getByTestId('hk-report');
    expect(await within(report).findByText('3 (75%)')).toBeInTheDocument();
    expect(within(report).getByText('30 phút')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bộ lọc' })).toContainElement(screen.getByTestId('hk-period'));
    expect(within(screen.getByTestId('hk-report-export')).getAllByRole('link')).toHaveLength(2);
    expect(screen.getByTestId('hk-report-totals')).toHaveTextContent('Hoàn thành 3/4 phòng');
    expect(screen.getByTestId('hk-report-pdf')).toHaveAttribute('href', `/api/housekeeping/manager/report.pdf?${PERIOD}`);
    expect(screen.getByTestId('hk-report-xlsx')).toHaveAttribute('href', `/api/housekeeping/manager/report.xlsx?${PERIOD}`);
  });
});
