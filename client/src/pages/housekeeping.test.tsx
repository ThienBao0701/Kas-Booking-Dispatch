/**
 * "BUỒNG PHÒNG" — the three screens over one data set.
 *
 *   HOUSEKEEPING  records an inspection: person, room, the conditions found.
 *   RECEPTION     settles each issue on its own (amount · status · method/reason).
 *   ADMIN         reads and reports on all of it, and can void.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   0. The workday: no shift → "Vào ca" at the branch the Admin gave the account
 *      (shown, never chosen; none → "ask the Admin"); on shift, "Ca hiện tại ·
 *      Chi nhánh" with "Kết thúc ca" (a summary) — no "Đổi chi nhánh".
 *   1. The home is the day's board of the rooms given to this account: gray
 *      not started, blue being cleaned; a finished room leaves it (the server
 *      lists only the rooms still to clean) and a re-clean returns marked "Cần
 *      dọn lại" with the manager's reason. A room opens "Kiểm phòng | Dọn
 *      phòng" — the six conditions, then the cleaning form.
 *   2. One save posts one inspection with every ticked condition.
 *   3. Reception's dialog enforces the money rules: Đã thu needs a method and an
 *      amount, Không thu được needs a reason — and the fields that do not apply
 *      are not rendered.
 *   4. Housekeeping is told THAT an issue was settled, and never the amount.
 *   5. The Admin filters, sees the server's totals, and can void with a reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  HOUSEKEEPING_USER,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';
import { hcmToday } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };

function roomIssue(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    inspectionId: 'in1',
    branchId: 1,
    branch: BRANCH,
    roomNumber: '302',
    staffName: 'Chị Lan',
    recordedByName: 'Buồng phòng Một',
    type: 'SMOKING',
    typeLabel: 'Hút thuốc',
    note: null,
    createdAt: '2026-09-19T03:00:00.000Z',
    voided: false,
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    collectionStatus: 'PENDING',
    collectionStatusLabel: 'Chưa thu',
    collection: null,
    history: [],
    ...over,
  };
}

const SUMMARY = {
  total: 4,
  byStatus: { PENDING: 2, COLLECTED: 1, UNCOLLECTIBLE: 1 },
  byType: [
    { type: 'SMOKING', label: 'Hút thuốc', count: 3 },
    { type: 'ODOR', label: 'Phòng có mùi', count: 1 },
  ],
  collectedByMethod: { CASH: 500000, TRANSFER: 200000, CARD: 0 },
  collectedTotal: 700000,
  pendingAmount: 150000,
  uncollectibleAmount: 300000,
};

/** One segment of a workday at BRANCH. */
function segment(over: Record<string, unknown> = {}) {
  return {
    id: 'seg1',
    branch: BRANCH,
    staffName: 'Chị Lan',
    startedAt: '2026-09-19T01:00:00.000Z',
    endedAt: null,
    rooms: 1,
    inspections: 1,
    issues: 2,
    byType: [{ type: 'SMOKING', label: 'Hút thuốc', count: 2 }],
    ...over,
  };
}

/** A housekeeping workday, open at BRANCH unless `ended`. */
function workShift(ended = false) {
  const seg = segment(ended ? { endedAt: '2026-09-19T09:00:00.000Z' } : {});
  return {
    id: 'sh1',
    user: { id: 6, fullName: 'Buồng phòng Một' },
    startedAt: '2026-09-19T01:00:00.000Z',
    endedAt: ended ? '2026-09-19T09:00:00.000Z' : null,
    segments: [seg],
    current: ended ? null : seg,
    totals: { rooms: 1, inspections: 1, issues: 2, byType: seg.byType },
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
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    ...extra,
  };
}

/** One room work item, as the server sends it. */
function roomTask(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    branchId: 1,
    branch: BRANCH,
    workDate: hcmToday(),
    roomNumber: '101',
    statusCode: 'OUT',
    priority: false,
    note: null,
    assignee: { id: 6, name: 'Buồng phòng Một' },
    state: 'NOT_STARTED',
    stateLabel: 'Chưa bắt đầu',
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
    elapsedSeconds: null,
    inspection: null,
    cleaning: null,
    cleanedBy: null,
    createdByName: 'Quản lý',
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
    events: [],
    ...over,
  };
}

const CATALOG = {
  statusCodes: ['OUT', 'OC', 'VC'],
  states: { NOT_STARTED: 'Chưa bắt đầu', IN_PROGRESS: 'Đang dọn', COMPLETED: 'Hoàn thành' },
  linen: [
    { code: 'BED_SHEET', label: 'Ga giường' },
    { code: 'DUVET_COVER', label: 'Bọc chăn' },
    { code: 'MATTRESS_PROTECTOR', label: 'Bảo vệ nệm' },
  ],
  linenSizes: [
    { code: 'K', label: 'King' },
    { code: 'Q', label: 'Queen' },
    { code: 'T', label: 'Twin' },
  ],
  quantities: [
    { code: 'BATH_TOWEL', label: 'Khăn tắm' },
    { code: 'WATER', label: 'Nước suối' },
  ],
  replacements: [
    { code: 'COMB_COTTON_CAP', label: 'Lược, tăm bông, chụp tóc' },
    { code: 'TEA_COFFEE_SUGAR', label: 'Trà, cà phê, đường. Miễn phí' },
    { code: 'TISSUE', label: 'Giấy ăn, lau tay' },
    { code: 'HAND_WASH', label: 'Nước rửa tay' },
    { code: 'SHAMPOO', label: 'Dầu gội' },
    { code: 'SHOWER_GEL', label: 'Sữa tắm' },
  ],
  specialStatuses: [
    { code: 'LB', short: 'L/B', label: 'Khách có hành lý gọn nhẹ' },
    { code: 'SO', short: 'SO', label: 'Phòng có đồ nhưng khách không ngủ' },
    { code: 'DND', short: 'DND', label: 'Không làm phiền' },
    { code: 'OOO', short: 'OOO', label: 'Không thể bán phòng' },
    { code: 'OS', short: 'OS', label: 'Phòng ngưng tạm' },
    { code: 'LNL', short: 'LNL', label: 'Hàng thất lạc' },
  ],
  maxQuantity: 999,
};

describe('Bộ phận buồng phòng — the day’s rooms', () => {
  const MINE = `GET /api/housekeeping/work?date=${hcmToday()}`;
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(HOUSEKEEPING_USER, {
      'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: workShift() } }),
      'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
      [MINE]: () => ({
        status: 200,
        body: {
          tasks: [
            roomTask('t1', { roomNumber: '101', priority: true, note: 'Dọn trước 14:00' }),
            roomTask('t2', { roomNumber: '102', state: 'IN_PROGRESS', stateLabel: 'Đang dọn', startedAt: '2026-10-05T02:00:00.000Z' }),
            roomTask('t3', { roomNumber: '201', statusCode: 'OC', state: 'COMPLETED', stateLabel: 'Hoàn thành' }),
          ],
        },
      }),
      ...extra,
    });

  it('lands on the board: the current branch in view, its two menu entries, the rooms by code and state', async () => {
    installApiMock(routes());
    renderApp('/app');
    const current = await screen.findByTestId('shift-current');
    expect(current).toHaveTextContent('Ca hiện tại');
    expect(current).toHaveTextContent('Chi nhánh: Chi nhánh 1 — 05 Trương Định');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Buồng phòng', 'KPI & Thu tiền']);

    expect(await screen.findByText(`Tình trạng phòng ngày ${hcmToday().split('-').reverse().join('/')}`)).toBeInTheDocument();
    expect(within(screen.getByTestId('room-row-OUT')).getAllByRole('button').map((b) => b.textContent)).toEqual(['101', '102']);
    expect(within(screen.getByTestId('room-row-OC')).getByRole('button')).toHaveTextContent('201');
    // Gray, blue, green underline — the state, never the code.
    expect(screen.getByTestId('room-chip-101')).toHaveAttribute('data-state', 'NOT_STARTED');
    expect(screen.getByTestId('room-chip-101').className).toContain('bg-slate-100');
    expect(screen.getByTestId('room-chip-102').className).toContain('bg-blue-50');
    expect(screen.getByTestId('room-chip-201').querySelector('span')!.className).toContain('border-green-600');
    expect(screen.getByTestId('room-chip-101')).toHaveAccessibleName(/Ưu tiên/);
  });

  it('opens "Vào ca" at the account’s branch — shown, never chosen — and sends nothing to choose', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      routes({
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
        'POST /api/housekeeping/shift/start': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { shift: workShift() } };
        },
      }),
    );
    renderApp('/app/inspections');
    const start = await screen.findByTestId('shift-start');
    const branch = within(start).getByTestId('shift-branch');
    expect(branch).toHaveTextContent('Chi nhánh hiện tại');
    expect(branch).toHaveTextContent('05 Trương Định');
    // No branch to pick, no name to type.
    expect(within(start).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(start).queryByTestId('shift-staff')).not.toBeInTheDocument();
    await userEvent.click(within(start).getByTestId('shift-start-submit'));
    await waitFor(() => expect(posted).toEqual([{}]));
  });

  it('offers no "Đổi chi nhánh" on shift — only "Kết thúc ca"', async () => {
    installApiMock(routes());
    renderApp('/app/inspections');
    const current = await screen.findByTestId('shift-current');
    expect(within(current).queryByTestId('shift-switch')).not.toBeInTheDocument();
    expect(within(current).queryByRole('button', { name: /Đổi chi nhánh/ })).not.toBeInTheDocument();
    expect(within(current).getByTestId('shift-end')).toBeInTheDocument();
  });

  it('tells an account with no branch to ask the Admin — no "Vào ca"', async () => {
    installApiMock(
      routes({
        'GET /api/auth/me': () => ({ status: 200, body: { user: { ...HOUSEKEEPING_USER, branch: null } } }),
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
      }),
    );
    renderApp('/app/inspections');
    expect(await screen.findByText('Tài khoản chưa được gán chi nhánh')).toBeInTheDocument();
    expect(screen.queryByTestId('shift-start')).not.toBeInTheDocument();
  });

  it('"Kết thúc ca" shows the day’s summary', async () => {
    installApiMock(routes({ 'POST /api/housekeeping/shift/end': () => ({ status: 200, body: { shift: workShift(true) } }) }));
    renderApp('/app/inspections');
    await userEvent.click(within(await screen.findByTestId('shift-current')).getByTestId('shift-end'));
    await userEvent.click(await screen.findByTestId('shift-end-confirm'));
    const summary = await screen.findByTestId('shift-summary');
    expect(summary).toHaveTextContent('1 chi nhánh');
    expect(summary).toHaveTextContent('Hút thuốc: 2');
  });
});

describe('Bộ phận buồng phòng — a re-clean sent back by the manager', () => {
  const RECLEAN = roomTask('t9', {
    roomNumber: '105',
    cycleNumber: 2,
    reclean: { taskId: 't8', cycleNumber: 1, reason: 'Thiếu khăn tắm', reviewedByName: 'Quản lý Buồng', reviewedAt: '2026-10-05T03:00:00.000Z' },
  });

  it('marks it "Cần dọn lại" on the board and shows the manager’s reason on the room', async () => {
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: workShift() } }),
        'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
        [`GET /api/housekeeping/work?date=${hcmToday()}`]: () => ({ status: 200, body: { tasks: [roomTask('t1', { roomNumber: '101' }), RECLEAN] } }),
        'GET /api/housekeeping/work/tasks/t9': () => ({ status: 200, body: { task: RECLEAN } }),
        'POST /api/housekeeping/work/tasks/t9/open': () => ({ status: 200, body: { task: RECLEAN } }),
      }),
    );
    renderApp('/app/inspections');
    const chip = await screen.findByTestId('room-chip-105');
    expect(chip).toHaveTextContent('Cần dọn lại');
    expect(screen.getByTestId('room-chip-101')).not.toHaveTextContent('Cần dọn lại');
    await userEvent.click(chip);
    const banner = await screen.findByTestId('room-reclean');
    expect(banner).toHaveTextContent('CẦN DỌN LẠI');
    expect(banner).toHaveTextContent('Lý do: Thiếu khăn tắm');
    // A new cycle: "Kiểm phòng" first, as always.
    expect(screen.getByTestId('room-tab-clean')).toBeDisabled();
  });
});

describe('Bộ phận buồng phòng — one room: Kiểm phòng | Dọn phòng', () => {
  const routes = (task: unknown, extra: Record<string, Handler> = {}) =>
    shell(HOUSEKEEPING_USER, {
      'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
      'GET /api/housekeeping/work/tasks/t1': () => ({ status: 200, body: { task } }),
      'POST /api/housekeeping/work/tasks/t1/open': () => ({ status: 200, body: { task } }),
      ...extra,
    });

  it('offers the six conditions; "Dọn phòng" stays locked until the inspection is saved, which starts the clock', async () => {
    const posted: unknown[] = [];
    const started = roomTask('t1', {
      state: 'IN_PROGRESS',
      stateLabel: 'Đang dọn',
      startedAt: new Date().toISOString(),
      inspection: { id: 'in1', createdAt: new Date().toISOString(), inspectorId: 6, inspectorName: 'Buồng phòng Một', findings: [] },
    });
    installApiMock(
      routes(roomTask('t1', { priority: true, note: 'Dọn trước 14:00' }), {
        'POST /api/housekeeping/work/tasks/t1/inspect': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { task: started } };
        },
      }),
    );
    renderApp('/app/inspections/room/t1');
    expect(await screen.findByRole('heading', { name: 'PHÒNG 101' })).toBeInTheDocument();
    expect(screen.getByTestId('room-note')).toHaveTextContent('Dọn trước 14:00');
    expect(screen.getByTestId('room-tab-clean')).toBeDisabled();
    const form = screen.getByTestId('inspection-form');
    expect(within(form).getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual([
      'Hút thuốc',
      'Phòng có mùi',
      'Cơ sở vật chất hư hỏng',
      'Khách quên đồ',
      'Phòng có khách nhưng hệ thống không có',
      'Vấn đề khác',
    ]);
    // No name is asked: the account is the inspector.
    expect(within(form).queryByLabelText(/Người dọn|Tên người/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('inspection-type-OTHER'));
    expect(screen.getByTestId('inspection-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('inspection-note-OTHER'), 'Rèm rách');
    await userEvent.click(screen.getByTestId('inspection-type-SMOKING'));
    await userEvent.click(screen.getByTestId('inspection-save'));
    await waitFor(() => expect(posted).toEqual([{ issues: [{ type: 'SMOKING' }, { type: 'OTHER', note: 'Rèm rách' }] }]));
    // Saved: "đang dọn", and the cleaning form opens.
    expect(await screen.findByTestId('cleaning-form')).toBeInTheDocument();
    expect(screen.getByTestId('room-state')).toHaveTextContent('Đang dọn');
  });

  it('records King / Queen / Twin with a count, counts, ✓ replacements and special notes, and completes the room', async () => {
    const posted: unknown[] = [];
    const task = roomTask('t1', {
      state: 'IN_PROGRESS',
      stateLabel: 'Đang dọn',
      startedAt: '2026-10-05T02:00:00.000Z',
      inspection: { id: 'in1', createdAt: '2026-10-05T02:00:00.000Z', inspectorId: 6, inspectorName: 'Buồng phòng Một', findings: [] },
    });
    installApiMock(
      routes(task, {
        'POST /api/housekeeping/work/tasks/t1/complete': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return {
            status: 200,
            body: { task: { ...task, state: 'COMPLETED', stateLabel: 'Hoàn thành', completedAt: '2026-10-05T02:42:00.000Z', durationSeconds: 2520 } },
          };
        },
      }),
    );
    renderApp('/app/inspections/room/t1');
    await screen.findByTestId('cleaning-form');
    // The three linen items, each King / Queen / Twin — the words, never K / Q / T.
    for (const label of ['Ga giường', 'Bọc chăn', 'Bảo vệ nệm']) {
      expect(within(screen.getByRole('group', { name: `Loại ${label}` })).getAllByRole('button').map((b) => b.textContent)).toEqual(['King', 'Queen', 'Twin']);
    }
    // ONE type per item: another choice replaces it; then its count.
    expect(screen.queryByTestId('linen-qty-BED_SHEET')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('linen-BED_SHEET-K'));
    await userEvent.click(screen.getByTestId('linen-BED_SHEET-Q'));
    expect(screen.getByTestId('linen-BED_SHEET-K')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('linen-BED_SHEET-Q')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('linen-qty-BED_SHEET')).toHaveValue(1);
    await userEvent.click(screen.getByRole('button', { name: 'Thêm số lượng Ga giường' }));
    expect(screen.getByTestId('linen-qty-BED_SHEET')).toHaveValue(2);
    await userEvent.click(screen.getByRole('button', { name: 'Thêm Khăn tắm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Thêm Khăn tắm' }));
    // The six replacement items, exactly — each a ✓, never the word "Đúng".
    expect(screen.getAllByTestId(/^replaced-/).map((b) => b.textContent)).toEqual([
      'Lược, tăm bông, chụp tóc',
      'Trà, cà phê, đường. Miễn phí',
      'Giấy ăn, lau tay',
      'Nước rửa tay',
      'Dầu gội',
      'Sữa tắm',
    ]);
    await userEvent.click(screen.getByTestId('replaced-SHAMPOO'));
    expect(screen.getByTestId('replaced-SHAMPOO')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Đúng')).not.toBeInTheDocument();
    // "Ghi nhận đặc biệt": the six, several at once.
    expect(screen.getByRole('heading', { name: 'Ghi nhận đặc biệt' })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^special-/).map((b) => b.textContent)).toEqual([
      'L/B : Khách có hành lý gọn nhẹ',
      'SO : Phòng có đồ nhưng khách không ngủ',
      'DND : Không làm phiền',
      'OOO : Không thể bán phòng',
      'OS : Phòng ngưng tạm',
      'LNL : Hàng thất lạc',
    ]);
    await userEvent.click(screen.getByTestId('special-LB'));
    await userEvent.click(screen.getByTestId('special-DND'));
    expect(screen.getByTestId('special-LB')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('special-DND')).toHaveAttribute('aria-pressed', 'true');
    // The note, under its own placeholder.
    expect(screen.getByTestId('cleaning-note')).toHaveAttribute('placeholder', 'Các lưu ý-Hỏng hóc-Vấn đề khác...');
    await userEvent.type(screen.getByTestId('cleaning-note'), 'Rèm hơi bẩn');
    await userEvent.click(screen.getByTestId('cleaning-complete'));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          linen: { BED_SHEET: { size: 'Q', quantity: 2 } },
          quantities: { BATH_TOWEL: 2 },
          replaced: ['SHAMPOO'],
          special: ['LB', 'DND'],
          note: 'Rèm hơi bẩn',
        },
      ]),
    );
    expect(await screen.findByTestId('cleaning-done')).toHaveTextContent('42 phút');
  });

  it('shows a saved form again on reload — type, count, ✓ and special notes', async () => {
    const task = roomTask('t1', {
      state: 'IN_PROGRESS',
      stateLabel: 'Đang dọn',
      startedAt: '2026-10-05T02:00:00.000Z',
      inspection: { id: 'in1', createdAt: '2026-10-05T02:00:00.000Z', inspectorId: 6, inspectorName: 'Buồng phòng Một', findings: [] },
      cleaning: {
        linen: { DUVET_COVER: { size: 'T', quantity: 3 } },
        quantities: { WATER: 4 },
        replaced: ['TEA_COFFEE_SUGAR'],
        special: ['OOO', 'LNL'],
        note: 'Ổ cắm hỏng',
      },
    });
    installApiMock(routes(task));
    renderApp('/app/inspections/room/t1');
    await screen.findByTestId('cleaning-form');
    expect(screen.getByTestId('linen-DUVET_COVER-T')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('linen-qty-DUVET_COVER')).toHaveValue(3);
    expect(screen.queryByTestId('linen-qty-BED_SHEET')).not.toBeInTheDocument();
    expect(screen.getByTestId('qty-WATER')).toHaveValue(4);
    expect(screen.getByTestId('replaced-TEA_COFFEE_SUGAR')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('special-OOO')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('special-LNL')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('special-DND')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('cleaning-note')).toHaveValue('Ổ cắm hỏng');
  });
});

describe('Bộ phận buồng phòng — KPI & Thu tiền', () => {
  it('shows its own findings and the money collected against them', async () => {
    const today = hcmToday();
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        [`GET /api/housekeeping/kpi/me?from=${today}&to=${today}`]: () => ({
          status: 200,
          body: {
            summary: { userId: 6, fullName: 'Buồng phòng Một', inspections: 3, findings: 2, collectedCount: 1, pendingCount: 1, uncollectibleCount: 0, collectedAmount: 500000, pendingAmount: 200000 },
            findings: [
              {
                id: 'f1',
                inspectionId: 'in1',
                branch: BRANCH,
                roomNumber: '101',
                inspectorName: 'Buồng phòng Một',
                type: 'SMOKING',
                typeLabel: 'Hút thuốc',
                note: null,
                createdAt: '2026-10-05T02:00:00.000Z',
                collectionStatus: 'COLLECTED',
                collectionStatusLabel: 'Đã thu',
                amount: 500000,
                collectedByName: 'Lễ tân CN1',
                collectedAt: '2026-10-05T03:00:00.000Z',
              },
            ],
          },
        }),
      }),
    );
    renderApp('/app/my-kpi');
    const kpi = await screen.findByTestId('my-kpi');
    await waitFor(() => expect(kpi).toHaveTextContent('500.000 ₫'));
    expect(kpi).toHaveTextContent('Lượt kiểm phòng');
    expect(await within(screen.getByTestId('my-findings')).findByText('Hút thuốc')).toBeInTheDocument();
  });
});

describe('Reception — thu tiền buồng phòng', () => {
  const routes = (issues: unknown[], extra: Record<string, Handler> = {}) =>
    shell(RECEPTIONIST_USER, {
      'GET /api/housekeeping/issues?status=PENDING': () => ({
        status: 200,
        body: { issues, total: issues.length, truncated: false, summary: SUMMARY },
      }),
      'GET /api/housekeeping/issues': () => ({
        status: 200,
        body: { issues, total: issues.length, truncated: false, summary: SUMMARY },
      }),
      ...extra,
    });

  it('opens on the issues still to collect, with the server’s totals', async () => {
    installApiMock(routes([roomIssue('a'), roomIssue('b', { type: 'ODOR', typeLabel: 'Phòng có mùi', roomNumber: '101' })]));
    renderApp('/app/room-collections');

    const table = await screen.findByTestId('room-issue-table');
    expect(await within(table).findByText('Hút thuốc')).toBeInTheDocument();
    expect(within(table).getByText('Phòng có mùi')).toBeInTheDocument();
    const summary = await screen.findByTestId('room-issue-summary');
    expect(summary).toHaveTextContent('700.000 ₫');
    expect(screen.getByTestId('room-filter-PENDING')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('room-filter-PENDING')).toHaveTextContent('2');
    // Kept apart from the payment ledger, and says so.
    expect(summary).toHaveTextContent('tách riêng khỏi sổ thanh toán');
  });

  it('is in the receptionist’s menu, and the old chat entry is not', async () => {
    installApiMock(routes([]));
    renderApp('/app/room-collections');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: 'Buồng phòng' })).toBeInTheDocument();
  });

  async function openDialog(issues = [roomIssue('a')], extra: Record<string, Handler> = {}) {
    installApiMock(routes(issues, extra));
    renderApp('/app/room-collections');
    await userEvent.click(await screen.findByTestId('collect-a'));
    return screen.findByRole('dialog', { name: /Thu tiền — Phòng/ });
  }

  it('defaults to Đã thu, and needs a method and an amount before it will save', async () => {
    const dialog = await openDialog();
    const save = within(dialog).getByTestId('collection-save');
    expect(within(dialog).getByTestId('collection-status-COLLECTED')).toBeChecked();
    expect(save).toBeDisabled();

    await userEvent.type(within(dialog).getByTestId('collection-amount'), '500000');
    expect(save).toBeDisabled();
    const method = within(dialog).getByTestId('collection-method');
    expect(within(method).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '— Chọn hình thức —',
      'Tiền mặt',
      'Chuyển khoản',
      'Cà thẻ',
    ]);
    await userEvent.selectOptions(method, 'CASH');
    expect(save).toBeEnabled();
  });

  it('needs a reason for Không thu được, and shows no method for it', async () => {
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByTestId('collection-status-UNCOLLECTIBLE'));
    expect(within(dialog).queryByTestId('collection-method')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('collection-reason')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByTestId('collection-amount'), '300000');
    const save = within(dialog).getByTestId('collection-save');
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('collection-reason'), '   ');
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('collection-reason'), 'Khách đã rời đi');
    expect(save).toBeEnabled();
  });

  it('needs neither for Chưa thu', async () => {
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByTestId('collection-status-PENDING'));
    expect(within(dialog).queryByTestId('collection-method')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('collection-reason')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByTestId('collection-amount'), '150000');
    expect(within(dialog).getByTestId('collection-save')).toBeEnabled();
  });

  it('sends only what belongs to the chosen status', async () => {
    const put: Record<string, unknown>[] = [];
    const dialog = await openDialog([roomIssue('a')], {
      'PUT /api/housekeeping/issues/a/collection': (init) => {
        put.push(JSON.parse(String(init.body)));
        return { status: 200, body: { issue: roomIssue('a') } };
      },
    });
    await userEvent.type(within(dialog).getByTestId('collection-amount'), '500000');
    await userEvent.selectOptions(within(dialog).getByTestId('collection-method'), 'TRANSFER');
    // A reason typed under another status must not travel with this one.
    await userEvent.click(within(dialog).getByTestId('collection-status-UNCOLLECTIBLE'));
    await userEvent.type(within(dialog).getByTestId('collection-reason'), 'nháp');
    await userEvent.click(within(dialog).getByTestId('collection-status-COLLECTED'));
    await userEvent.click(within(dialog).getByTestId('collection-save'));

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ status: 'COLLECTED', amount: 500000, method: 'TRANSFER' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Thu tiền — Phòng/ })).not.toBeInTheDocument());
  });

  it('opens an already-settled issue with its stored values, and shows its history', async () => {
    const settled = roomIssue('a', {
      collectionStatus: 'UNCOLLECTIBLE',
      collectionStatusLabel: 'Không thu được',
      collection: {
        amount: 300000,
        status: 'UNCOLLECTIBLE',
        method: null,
        methodLabel: null,
        reason: 'Khách đã rời đi',
        note: null,
        recordedByName: 'Nguyễn Văn A',
        updatedAt: '2026-09-19T05:00:00.000Z',
      },
      history: [
        { id: 'h1', amount: 300000, status: 'PENDING', statusLabel: 'Chưa thu', methodLabel: null, reason: null, note: null, actorName: 'Nguyễn Văn A', createdAt: '2026-09-19T04:00:00.000Z' },
        { id: 'h2', amount: 300000, status: 'UNCOLLECTIBLE', statusLabel: 'Không thu được', methodLabel: null, reason: 'Khách đã rời đi', note: null, actorName: 'Nguyễn Văn A', createdAt: '2026-09-19T05:00:00.000Z' },
      ],
    });
    installApiMock(routes([settled]));
    renderApp('/app/room-collections');
    const table = await screen.findByTestId('room-issue-table');
    expect(await within(table).findByText('Không thu được')).toBeInTheDocument();
    expect(within(table).getByText(/Lý do: Khách đã rời đi/)).toBeInTheDocument();
    await userEvent.click(within(table).getByTestId('row-toggle-a'));
    const history = await within(table).findByTestId('room-history-a');
    expect(history).toHaveTextContent('Chưa thu');
    expect(history).toHaveTextContent('Không thu được');

    await userEvent.click(within(table).getByTestId('collect-a'));
    const dialog = await screen.findByRole('dialog', { name: /Thu tiền — Phòng/ });
    expect(within(dialog).getByTestId('collection-status-UNCOLLECTIBLE')).toBeChecked();
    expect(within(dialog).getByTestId('collection-reason')).toHaveValue('Khách đã rời đi');
    expect(within(dialog).getByTestId('collection-amount')).toHaveValue('300.000');
  });

  it('shows the server’s refusal in the dialog', async () => {
    const dialog = await openDialog([roomIssue('a')], {
      'PUT /api/housekeeping/issues/a/collection': () => ({
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'Vấn đề phòng đã bị hủy, không thể cập nhật.' } },
      }),
    });
    await userEvent.type(within(dialog).getByTestId('collection-amount'), '1000');
    await userEvent.selectOptions(within(dialog).getByTestId('collection-method'), 'CARD');
    await userEvent.click(within(dialog).getByTestId('collection-save'));
    expect(await within(dialog).findByText(/đã bị hủy/)).toBeInTheDocument();
  });

  it('gives a voided issue no action', async () => {
    installApiMock(routes([roomIssue('a', { voided: true, voidReason: 'Nhập nhầm', voidedByName: 'Quản trị viên' })]));
    renderApp('/app/room-collections');
    const table = await screen.findByTestId('room-issue-table');
    expect(await within(table).findByText(/Đã hủy: Nhập nhầm/)).toBeInTheDocument();
    expect(within(table).queryByTestId('collect-a')).not.toBeInTheDocument();
  });
});

describe('Admin — buồng phòng', () => {
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(ADMIN_USER, {
      'GET /api/admin/branches': () => ({
        status: 200,
        body: { branches: [{ ...BRANCH, active: true }, { id: 2, code: 'LT', hotelName: 'KAS 2', address: '260 Lý Tự Trọng', branchNumber: 2, active: true }] },
      }),
      ...extra,
    });

  const list = (over: Record<string, unknown> = {}) => () => ({
    status: 200,
    body: {
      issues: [roomIssue('a'), roomIssue('b', { branchId: 2, branch: { ...BRANCH, id: 2, address: '260 Lý Tự Trọng', branchNumber: 2 }, type: 'ODOR', typeLabel: 'Phòng có mùi' })],
      total: 2,
      truncated: false,
      summary: SUMMARY,
      ...over,
    },
  });

  function anyIssuesRoute(handler: Handler): Record<string, Handler> {
    // The exact URL carries the period, which is today's date — match any.
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const from = new Date(Date.now() + 7 * 3600_000 - 29 * 86_400_000).toISOString().slice(0, 10);
    return {
      [`GET /api/housekeeping/issues?from=${from}&to=${today}`]: handler,
      [`GET /api/housekeeping/shifts?from=${from}&to=${today}`]: () => ({
        status: 200,
        body: { shifts: [{ ...workShift(true), segments: [segment({ endedAt: '2026-09-19T09:00:00.000Z' })] }] },
      }),
    };
  }

  it('is in the Admin menu, with the branch picker built from the branch table', async () => {
    installApiMock(routes(anyIssuesRoute(list())));
    // The old address lands under "Báo cáo vấn đề", whose group opens on it.
    renderApp('/app/housekeeping');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Buồng phòng' })).toHaveAttribute('href', '/app/reports/housekeeping');

    const branch = await screen.findByTestId('housekeeping-branch');
    await waitFor(() =>
      expect(within(branch).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'Tất cả chi nhánh',
        '05 Trương Định - Chi nhánh 01',
        '260 Lý Tự Trọng - Chi nhánh 02',
      ]),
    );
  });

  it('shows every branch’s issues with the server’s totals, and the split by type', async () => {
    installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/housekeeping');
    // Branch → room → finding: one table per branch.
    const first = await screen.findByTestId('room-issue-table-1');
    expect(await within(first).findByText('Hút thuốc')).toBeInTheDocument();
    expect(first).toHaveTextContent('Chi nhánh 1 — 05 Trương Định');
    const second = screen.getByTestId('room-issue-table-2');
    expect(within(second).getByText('Phòng có mùi')).toBeInTheDocument();
    expect(second).toHaveTextContent('Chi nhánh 2 — 260 Lý Tự Trọng');
    // The housekeeping workdays of the period, with the export beside them.
    const shifts = await screen.findByTestId('housekeeping-shifts');
    expect(await within(shifts).findByText('Chị Lan')).toBeInTheDocument();
    expect(screen.getByTestId('housekeeping-export-pdf').getAttribute('href')).toMatch(/section=HOUSEKEEPING/);
    const summary = await screen.findByTestId('room-issue-summary');
    expect(summary).toHaveTextContent('Tổng đã thu');
    expect(summary).toHaveTextContent('700.000 ₫');
    expect(await screen.findByTestId('housekeeping-by-type')).toHaveTextContent('Hút thuốc: 3 · Phòng có mùi: 1');
  });

  it('passes a filter to the server rather than filtering rows itself', async () => {
    const fetchMock = installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/housekeeping');
    await screen.findByTestId('room-issue-table');
    await userEvent.selectOptions(screen.getByTestId('housekeeping-status'), 'PENDING');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => /status=PENDING/.test(String(url)))).toBe(true),
    );
  });

  it('says when the list was cut short, while the totals cover everything', async () => {
    installApiMock(routes(anyIssuesRoute(list({ total: 812, truncated: true }))));
    renderApp('/app/housekeeping');
    expect(await screen.findByTestId('housekeeping-truncated')).toHaveTextContent('trên tổng số 812');
  });

  it('voids an issue with a reason — and needs one', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      routes({
        ...anyIssuesRoute(list()),
        'POST /api/housekeeping/issues/a/void': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { issue: roomIssue('a', { voided: true }) } };
        },
      }),
    );
    renderApp('/app/housekeeping');
    await userEvent.click(await screen.findByTestId('void-room-a'));
    const dialog = await screen.findByRole('dialog', { name: /Hủy vấn đề — Phòng/ });
    expect(within(dialog).getByTestId('void-room-confirm')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('void-room-reason'), 'Nhập nhầm phòng');
    await userEvent.click(within(dialog).getByTestId('void-room-confirm'));
    await waitFor(() => expect(posted).toEqual([{ reason: 'Nhập nhầm phòng' }]));
  });

  it('can settle an issue too, exactly as Reception does', async () => {
    installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/housekeeping');
    await userEvent.click(await screen.findByTestId('collect-a'));
    expect(await screen.findByTestId('collection-status-COLLECTED')).toBeChecked();
  });
});
