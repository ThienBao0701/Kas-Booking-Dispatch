/**
 * "QUẢN LÝ BUỒNG PHÒNG" — the manager's six screens over its one branch.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The role lands on "Tổng quan" with exactly its six menu entries, its
 *      branch fixed and named — no picker.
 *   2. "Tình trạng phòng" puts the chosen rooms on the day's board with their
 *      code, worker, priority and note — one POST.
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
    ...extra,
  };
}

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
  it('puts the chosen rooms on the board with their code, worker, priority and note — in one request', async () => {
    const posted: unknown[] = [];
    installApiMock(
      shell(MANAGER, {
        [TASKS_URL]: () => ({ status: 200, body: { tasks: [task('t1', { assignee: { id: 6, name: 'Buồng phòng Một' } })] } }),
        'GET /api/branches/1/rooms': () => ({ status: 200, body: { branchId: 1, rooms: ['101', '102', '103'] } }),
        'POST /api/housekeeping/manager/tasks': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { created: 2, skipped: [] } };
        },
      }),
    );
    renderApp('/app/hk/rooms');
    expect(await screen.findByRole('heading', { name: `Tình trạng phòng ngày ${TODAY.split('-').reverse().join('/')}` })).toBeInTheDocument();
    const row = await screen.findByTestId('room-row-OUT');
    expect(within(row).getByTestId('room-chip-101')).toHaveAttribute('data-state', 'NOT_STARTED');
    expect(within(row).getByTestId('room-chip-101')).toHaveTextContent('Buồng phòng Một');
    const summary = screen.getByTestId('board-summary');
    expect(summary).toHaveTextContent('Đang thực hiện1');
    expect(summary).toHaveTextContent('Chưa bắt đầu1');
    expect(summary).not.toHaveTextContent('₫');

    const setup = screen.getByTestId('board-setup');
    // A room already on the board is not offered again.
    const free = await within(setup).findByTestId('free-rooms');
    expect(within(free).queryByTestId('room-chip-101')).not.toBeInTheDocument();
    await userEvent.click(within(free).getByTestId('room-chip-102'));
    await userEvent.click(within(free).getByTestId('room-chip-103'));
    await waitFor(() => expect(within(setup).getByTestId('setup-code')).toHaveValue('OUT'));
    await userEvent.selectOptions(within(setup).getByTestId('setup-code'), 'OC');
    await userEvent.selectOptions(within(setup).getByTestId('setup-assignee'), '7');
    await userEvent.click(within(setup).getByTestId('setup-priority'));
    await userEvent.type(within(setup).getByTestId('setup-note'), 'Dọn trước 14:00');
    await userEvent.click(within(setup).getByTestId('setup-submit'));

    await waitFor(() =>
      expect(posted).toEqual([
        { branchId: 1, workDate: TODAY, roomNumbers: ['102', '103'], statusCode: 'OC', priority: true, note: 'Dọn trước 14:00', assigneeUserId: 7 },
      ]),
    );
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
  const chips = (el: HTMLElement) => within(el).queryAllByTestId(/^room-chip-/).map((c) => c.getAttribute('data-testid')!.replace('room-chip-', ''));

  it('splits the board: rooms being cleaned, rooms waiting for review, and rooms that can be added again', async () => {
    installApiMock(routes());
    renderApp('/app/hk/rooms');
    const active = await screen.findByTestId('board-active');
    await waitFor(() => expect(chips(active)).toEqual(['101', '102', '105']));
    // A re-clean, marked.
    expect(within(active).getByTestId('room-chip-105')).toHaveAttribute('data-reclean', 'true');
    expect(within(active).getByTestId('room-chip-105')).toHaveTextContent('Cần dọn lại');
    // Waiting for the manager: its own area, with who, when and how long.
    const review = screen.getByTestId('board-review');
    expect(within(review).queryAllByTestId(/^review-card-/).map((c) => c.getAttribute('data-testid'))).toEqual(['review-card-103']);
    const card = within(review).getByTestId('review-card-103');
    expect(card).toHaveTextContent('PHÒNG 103');
    expect(card).toHaveTextContent('Nhân viên:Buồng phòng Một');
    expect(card).toHaveTextContent('Thời gian dọn:32 phút');
    // 104 passed: released to "Thêm phòng vào bảng"; the open rooms are not offered.
    expect(chips(await screen.findByTestId('free-rooms'))).toEqual(['104', '106']);
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
    expect(chips(await screen.findByTestId('free-rooms'))).toEqual([]);
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
