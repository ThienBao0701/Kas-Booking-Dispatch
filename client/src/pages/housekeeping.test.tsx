/**
 * "BUỒNG PHÒNG" — the three screens over one data set.
 *
 *   HOUSEKEEPING  records an inspection: person, room, the conditions found.
 *   RECEPTION     settles each issue on its own (amount · status · method/reason).
 *   ADMIN         reads and reports on all of it, and can void.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   0. The workday: no shift → "Vào ca" by the hotel's ADDRESS, typed — no
 *      branch shown, prefilled or offered, and no work list (none → "ask the
 *      Admin"); on shift, "Ca hiện tại · Chi nhánh" with "Kết thúc ca" (a
 *      summary) — no "Đổi chi nhánh".
 *   1. On shift, the day's work items: one row per item; "Nhận" confirms
 *      exactly the selected ones; the housekeeper's own carry the next step
 *      ("Kiểm tra"), and a re-clean returns marked "Cần dọn lại" with the
 *      manager's reason. An item opens "Kiểm phòng | Dọn phòng" — the six
 *      conditions, then the cleaning form.
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
import { hcmToday, hcmTomorrow } from '../lib/format';

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
  states: { NOT_STARTED: 'Chưa bắt đầu', INSPECTED: 'Đã kiểm tra', IN_PROGRESS: 'Đang dọn', COMPLETED: 'Hoàn thành' },
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
  collectable: ['BED_SHEET', 'DUVET_COVER', 'MATTRESS_PROTECTOR', 'BATH_TOWEL'],
  maxQuantity: 999,
};

describe('Bộ phận buồng phòng — "Vào ca" and the day’s work groups', () => {
  const GROUPS = `GET /api/housekeeping/work/groups?date=${hcmToday()}`;
  const ITEMS = `GET /api/housekeeping/work/items?date=${hcmToday()}`;
  const HISTORY = `GET /api/housekeeping/work/history?date=${hcmToday()}`;
  const item = (id: string, over: Record<string, unknown> = {}) =>
    roomTask(id, { assignee: null, phase: 'UNCLAIMED', phaseLabel: 'Chưa giao', areaKind: 'ROOM', taskCodes: ['OUT'], ...over });
  const group = (id: string, number: number, items: unknown[], over: Record<string, unknown> = {}) => ({
    id,
    branchId: 1,
    branch: BRANCH,
    workDate: hcmToday(),
    number,
    title: `Công việc ${number}`,
    name: null,
    assignee: null,
    acceptedAt: null,
    status: { code: 'UNASSIGNED', label: 'Chưa giao' },
    floors: ['Tầng 1'],
    counts: { items: items.length, completed: 0, noCleanPending: 0 },
    items,
    createdByName: 'Quản lý',
    createdAt: '2026-10-05T01:00:00.000Z',
    ...over,
  });
  const G1 = group('g1', 1, [
    item('w1', { roomNumber: '101', floor: '1', taskCodes: ['OUT'], priority: true }),
    item('w2', { roomNumber: 'Hành lang - Tầng 1', areaKind: 'HALLWAY', areaKindLabel: 'Hành lang', floor: '1', taskCodes: ['OTHER'], note: 'Lau sàn' }),
  ], { name: 'Tầng 1 buổi sáng' });
  const MINE = { id: 6, name: 'Buồng phòng Một' };
  const G2 = group('g2', 2, [item('w4', { roomNumber: '301', floor: '3', taskCodes: ['OC', 'OTHER'], note: 'Thay rèm', assignee: MINE, phase: 'ACCEPTED', phaseLabel: 'Đã nhận / Chờ kiểm tra' })], {
    assignee: MINE,
    status: { code: 'ACCEPTED', label: 'Đã nhận' },
    floors: ['Tầng 3'],
  });
  const G3 = group('g3', 3, [item('w5', { roomNumber: '201', floor: '2', assignee: { id: 9, name: 'Chị Hoa' }, phase: 'ACCEPTED', phaseLabel: 'Đã nhận / Chờ kiểm tra' })], {
    assignee: { id: 9, name: 'Chị Hoa' },
    status: { code: 'ACCEPTED', label: 'Đã nhận' },
  });
  const EMPTY_HISTORY = { workDate: hcmToday(), items: [], totals: { completed: 0, noClean: 0 }, shifts: [] };
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(HOUSEKEEPING_USER, {
      'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: workShift() } }),
      'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
      [GROUPS]: () => ({ status: 200, body: { working: true, groups: [G1, G2, G3] } }),
      [ITEMS]: () => ({ status: 200, body: { working: true, tasks: [] } }),
      [HISTORY]: () => ({ status: 200, body: EMPTY_HISTORY }),
      ...extra,
    });

  it('shows tomorrow’s prepared work apart from today’s — to accept now, with no room step before its day', async () => {
    const tomorrowMine = group('t2', 2, [item('n2', { roomNumber: '305', floor: '3', assignee: MINE, phase: 'ACCEPTED', phaseLabel: 'Đã nhận / Chờ kiểm tra' })], {
      workDate: hcmTomorrow(),
      assignee: MINE,
      status: { code: 'ACCEPTED', label: 'Đã nhận' },
    });
    const tomorrowFree = group('t1', 1, [item('n1', { roomNumber: '205', floor: '2' })], { workDate: hcmTomorrow() });
    installApiMock(
      routes({
        [`GET /api/housekeeping/work/groups?date=${hcmTomorrow()}`]: () => ({ status: 200, body: { working: true, groups: [tomorrowFree, tomorrowMine] } }),
      }),
    );
    renderApp('/app');
    const next = await screen.findByTestId('worker-tomorrow');
    expect(next).toHaveTextContent(`Công việc ngày mai ${hcmTomorrow().split('-').reverse().join('/')}`);
    expect(next).toHaveTextContent('Kiểm tra và dọn phòng bắt đầu vào đúng ngày');
    // A free group is accepted ahead; one's own shows no step before its day.
    expect(within(next).getByTestId('group-accept-1')).toBeInTheDocument();
    expect(within(next).getByTestId('group-mine-2')).toBeInTheDocument();
    expect(within(next).queryByTestId('work-step-n2')).not.toBeInTheDocument();
    // Today's list is today's alone.
    expect(within(await screen.findByTestId('worker-groups')).queryByTestId('group-card-1')).toHaveTextContent('Tầng 1 buổi sáng');
  });

  it('lands on the numbered work groups: who holds each, and the next step on one’s own rooms', async () => {
    installApiMock(routes());
    renderApp('/app');
    const current = await screen.findByTestId('shift-current');
    expect(current).toHaveTextContent('Ca hiện tại');
    // The hotel by its address — never a branch number.
    expect(within(current).getByTestId('shift-hotel')).toHaveTextContent('Khách sạn: 05 Trương Định');
    expect(document.body).not.toHaveTextContent(/Chi nhánh \d/);
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    // Its work, then its own reports (with its KPI) and its completed issues — folded groups.
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Buồng phòng']);
    expect(within(nav).getByTestId('nav-group-Báo cáo vấn đề')).toBeInTheDocument();
    expect(within(nav).getByTestId('nav-group-Hoàn thành vấn đề')).toBeInTheDocument();

    const list = await screen.findByTestId('worker-groups');
    expect(within(list).getAllByRole('article').map((a) => a.getAttribute('data-testid'))).toEqual(['group-card-1', 'group-card-2', 'group-card-3']);
    const one = screen.getByTestId('group-card-1');
    expect(one).toHaveTextContent('Công việc 1 — Tầng 1 buổi sáng');
    expect(one).toHaveTextContent('Người thực hiện: Chưa giao');
    // Both places of Tầng 1 sit side by side in that floor's one row.
    const floor1 = within(one).getByTestId('group-floor-1-0');
    expect(within(floor1).getByRole('heading')).toHaveTextContent('Tầng 1');
    expect(within(within(floor1).getByTestId('group-floor-row-1-0')).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual(['group-item-w1', 'group-item-w2']);
    expect(within(one).getByTestId('group-item-w1')).toHaveTextContent('Phòng 101');
    expect(within(one).getByTestId('group-item-w2')).toHaveTextContent('Hành lang');
    expect(within(one).getByTestId('group-accept-1')).toHaveTextContent('Nhận công việc');
    // Nobody works a room of a group they have not accepted.
    expect(within(one).queryByTestId('work-step-w1')).not.toBeInTheDocument();

    const two = screen.getByTestId('group-card-2');
    expect(within(two).getByTestId('group-mine-2')).toHaveTextContent('Công việc của bạn');
    expect(within(two).getByTestId('work-step-w4')).toHaveTextContent('Kiểm tra');
    // "Không cần dọn" is asked from the room's own page, not from its tile.
    expect(within(two).queryByTestId('no-clean-open-w4')).not.toBeInTheDocument();
    expect(within(two).queryByRole('button', { name: /Không cần dọn/ })).not.toBeInTheDocument();
    expect(within(two).getByTestId('group-item-w4')).toHaveTextContent('OC');
    expect(within(two).getByTestId('group-item-w4')).toHaveTextContent('Khác');
    // The owner is named once, in the group's header — not again on each tile.
    expect(within(two).getByTestId('group-assignee-2')).toHaveTextContent('Buồng phòng Một');
    expect(within(two).getByTestId('group-item-w4')).not.toHaveTextContent('Người làm');

    // A colleague's group: who has it — and nothing to press.
    const three = screen.getByTestId('group-card-3');
    expect(within(three).getByTestId('group-taken-3')).toHaveTextContent('Chị Hoa đang làm');
    expect(within(three).queryByTestId('group-accept-3')).not.toBeInTheDocument();
    expect(within(three).queryByTestId('work-step-w5')).not.toBeInTheDocument();
  });

  it('names only the one hotel the typed address identifies — its address alone, chosen with "Chọn" — and opens the shift', async () => {
    const posted: Record<string, unknown>[] = [];
    const looked: string[] = [];
    const fetchMock = installApiMock(
      routes({
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
        'POST /api/housekeeping/shift/lookup': (init) => {
          const { address } = JSON.parse(String(init.body)) as { address: string };
          looked.push(address);
          return address === '17'
            ? { status: 200, body: { status: 'RESOLVED', branch: { address: '170-172-174 Nguyễn Thái Bình' } } }
            : { status: 200, body: { status: 'AMBIGUOUS', message: 'Nhập thêm số nhà hoặc tên đường để xác định khách sạn.' } };
        },
        'POST /api/housekeeping/shift/start': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { shift: workShift() } };
        },
      }),
    );
    renderApp('/app/inspections');
    const start = await screen.findByTestId('shift-start');
    // Nothing names a hotel before the shift, and there is no list to pick from.
    expect(document.body).not.toHaveTextContent('05 Trương Định');
    expect(within(start).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(start).queryByRole('listbox')).not.toBeInTheDocument();
    const address = within(start).getByTestId('shift-address');
    expect(address).toHaveValue('');
    expect(address).toHaveAttribute('autocomplete', 'off');
    expect(within(start).getByTestId('shift-start-submit')).toBeDisabled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/housekeeping/work/groups'))).toBe(false);

    await userEvent.type(address, '1');
    expect(await within(start).findByTestId('shift-lookup-hint')).toHaveTextContent('Nhập thêm số nhà');
    expect(within(start).getByTestId('shift-start-submit')).toBeDisabled();
    await userEvent.type(address, '7');
    const match = await within(start).findByTestId('shift-lookup-match');
    // The address only — no branch number — and nothing chosen yet.
    expect(match).toHaveTextContent('170-172-174 Nguyễn Thái Bình');
    expect(match).not.toHaveTextContent('Chi nhánh');
    expect(document.body).not.toHaveTextContent('13 Bùi Thị Xuân');
    expect(within(start).getByTestId('shift-start-submit')).toBeDisabled();
    // "Chọn": the address fills the field, and only then does "Vào ca" open.
    await userEvent.click(within(match).getByTestId('shift-lookup-choose'));
    expect(address).toHaveValue('170-172-174 Nguyễn Thái Bình');
    expect(within(start).getByTestId('shift-lookup-chosen')).toHaveTextContent('Đã chọn: 170-172-174 Nguyễn Thái Bình');
    expect(within(start).getByTestId('shift-start-submit')).toBeEnabled();
    // An edit undoes the choice; choosing again restores it.
    await userEvent.type(address, 'x');
    expect(within(start).getByTestId('shift-start-submit')).toBeDisabled();
    await userEvent.type(address, '{Backspace}');
    expect(within(start).getByTestId('shift-start-submit')).toBeDisabled();
    await userEvent.clear(address);
    await userEvent.type(address, '17');
    await userEvent.click(await within(start).findByTestId('shift-lookup-choose'));
    await userEvent.click(within(start).getByTestId('shift-start-submit'));
    // The chosen address is sent; the server resolves it again itself.
    await waitFor(() => expect(posted).toEqual([{ address: '170-172-174 Nguyễn Thái Bình' }]));
    expect(looked.at(-1)).toBe('17');
  });

  it('offers "Vào ca" to an account with no branch — the shift decides where it works', async () => {
    installApiMock(
      routes({
        'GET /api/auth/me': () => ({ status: 200, body: { user: { ...HOUSEKEEPING_USER, branch: null } } }),
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
      }),
    );
    renderApp('/app/inspections');
    expect(await screen.findByTestId('shift-start')).toBeInTheDocument();
    expect(screen.queryByText('Tài khoản chưa được gán chi nhánh')).not.toBeInTheDocument();
  });

  it('"Nhận công việc" confirms the whole group, every place in it, and takes it', async () => {
    const accepted: string[] = [];
    installApiMock(
      routes({
        'POST /api/housekeeping/work/groups/g1/accept': () => {
          accepted.push('g1');
          return { status: 200, body: { group: { ...G1, assignee: MINE, status: { code: 'ACCEPTED', label: 'Đã nhận' } } } };
        },
      }),
    );
    renderApp('/app/inspections');
    await userEvent.click(await screen.findByTestId('group-accept-1'));
    const dialog = await screen.findByTestId('group-accept-dialog');
    expect(dialog).toHaveTextContent('Công việc 1 — Tầng 1 buổi sáng gồm 2 phòng / khu vực');
    expect(within(within(dialog).getByTestId('group-accept-list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Tầng 1 · Phòng 101 · OUT',
      'Tầng 1 · Hành lang · Khác',
    ]);
    expect(accepted).toEqual([]);
    await userEvent.click(screen.getByTestId('group-accept-confirm'));
    await waitFor(() => expect(accepted).toEqual(['g1']));
    expect(await screen.findByTestId('accept-done')).toHaveTextContent('Đã nhận Công việc 1');
  });

  it('says who was faster when the group is already taken, and reloads the list', async () => {
    let listed = 0;
    installApiMock(
      routes({
        [GROUPS]: () => {
          listed += 1;
          return { status: 200, body: { working: true, groups: [G1, G2, G3] } };
        },
        'POST /api/housekeeping/work/groups/g1/accept': () => ({
          status: 409,
          body: { error: { code: 'CONFLICT', message: 'Công việc 1 đã có người nhận: Chị Hoa.' } },
        }),
      }),
    );
    renderApp('/app/inspections');
    await userEvent.click(await screen.findByTestId('group-accept-1'));
    const dialog = await screen.findByTestId('group-accept-dialog');
    const before = listed;
    await userEvent.click(screen.getByTestId('group-accept-confirm'));
    expect(await within(dialog).findByText('Công việc 1 đã có người nhận: Chị Hoa.')).toBeInTheDocument();
    await waitFor(() => expect(listed).toBeGreaterThan(before));
  });

  it('"Không cần dọn" is asked from the room’s page: the room and its group named, a reason required, then "Chờ Quản lý xác nhận"', async () => {
    const asked: unknown[] = [];
    const own = { ...(G2.items[0] as Record<string, unknown>), workGroup: { id: 'g2', number: 2, name: null } };
    installApiMock(
      routes({
        'GET /api/housekeeping/work/tasks/w4': () => ({ status: 200, body: { task: own } }),
        'POST /api/housekeeping/work/tasks/w4/open': () => ({ status: 200, body: { task: own } }),
        'POST /api/housekeeping/work/tasks/w4/no-clean': (init) => {
          asked.push(JSON.parse(String(init.body)));
          return {
            status: 200,
            body: {
              task: {
                ...own,
                phase: 'NO_CLEAN_PENDING',
                phaseLabel: 'Chờ duyệt không cần dọn',
                noClean: { status: 'PENDING', reason: 'Khách không muốn dọn', requestedAt: '2026-10-05T03:00:00.000Z', requestedByName: 'Buồng phòng Một', decidedAt: null, decidedByName: null, decisionNote: null },
              },
            },
          };
        },
      }),
    );
    renderApp('/app/inspections/room/w4');
    const header = await screen.findByTestId('room-header');
    // Top right of the room's header; the hotel by its address.
    expect(within(header).getByTestId('room-hotel')).toHaveTextContent('Công việc 2 · 05 Trương Định');
    await userEvent.click(within(header).getByTestId('room-no-clean-open'));
    const dialog = await screen.findByTestId('no-clean-dialog');
    expect(within(dialog).getByTestId('no-clean-place')).toHaveTextContent('Tầng 3 · Phòng 301');
    expect(dialog).toHaveTextContent('Công việc 2');
    const send = screen.getByTestId('no-clean-send');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('no-clean-reason'), '   ');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('no-clean-reason'), 'Khách không muốn dọn');
    await userEvent.click(send);
    await waitFor(() => expect(asked).toEqual([{ reason: 'Khách không muốn dọn' }]));
    // Waiting for the manager: said so, asked no twice, nothing inspected meanwhile.
    expect(await within(header).findByTestId('room-no-clean-waiting')).toHaveTextContent('Chờ Quản lý xác nhận');
    expect(within(header).queryByTestId('room-no-clean-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('room-no-clean-pending')).toHaveTextContent('Khách không muốn dọn');
  });

  it('"Chưa dọn — chuyển người khác dọn" leaves an inspected room to a colleague, keeping the inspection', async () => {
    const released: unknown[] = [];
    const inspected = {
      ...(G2.items[0] as Record<string, unknown>),
      workGroup: { id: 'g2', number: 2, name: null },
      state: 'INSPECTED',
      stateLabel: 'Đã kiểm tra',
      phase: 'AWAITING_CLEANING',
      phaseLabel: 'Chờ dọn phòng',
      inspection: { id: 'i1', createdAt: '2026-10-05T02:00:00.000Z', inspectorId: 6, inspectorName: 'Buồng phòng Một', findings: [] },
    };
    installApiMock(
      routes({
        'GET /api/housekeeping/work/tasks/w4': () => ({ status: 200, body: { task: inspected } }),
        'POST /api/housekeeping/work/tasks/w4/release': (init) => {
          released.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: { ...inspected, assignee: null, workGroup: null } } };
        },
      }),
    );
    renderApp('/app/inspections/room/w4');
    const panel = await screen.findByTestId('cleaning-start-panel');
    // Not "Không cần dọn": the room still has to be cleaned — by someone else.
    await userEvent.click(within(panel).getByTestId('cleaning-release'));
    const dialog = await screen.findByTestId('release-dialog');
    expect(dialog).toHaveTextContent('Kết quả kiểm tra của bạn được giữ lại');
    await userEvent.type(within(dialog).getByTestId('release-reason'), 'Hết ca');
    await userEvent.click(screen.getByTestId('release-send'));
    await waitFor(() => expect(released).toEqual([{ reason: 'Hết ca' }]));
    // Back on the list: the room is no longer this housekeeper's.
    expect(await screen.findByTestId('worker-groups')).toBeInTheDocument();
  });

  it('offers a room a colleague inspected and left — saying who — for "Nhận"', async () => {
    const claimed: unknown[] = [];
    const left = item('r1', {
      roomNumber: '102',
      floor: '1',
      state: 'INSPECTED',
      stateLabel: 'Đã kiểm tra',
      phase: 'AWAITING_CLEANING',
      phaseLabel: 'Chờ dọn phòng',
      handoff: { byId: 9, byName: 'Chị Hoa', at: '2026-10-05T03:00:00.000Z', reason: 'Hết ca' },
    });
    installApiMock(
      routes({
        [ITEMS]: () => ({ status: 200, body: { working: true, tasks: [left] } }),
        'POST /api/housekeeping/work/claim': (init) => {
          claimed.push(JSON.parse(String(init.body)));
          return { status: 200, body: { tasks: [{ ...left, assignee: MINE, handoff: null }] } };
        },
      }),
    );
    renderApp('/app/inspections');
    expect(await screen.findByTestId('work-handoff-r1')).toHaveTextContent('Cần người dọn — đã kiểm tra bởi Chị Hoa · Hết ca');
    await userEvent.click(screen.getByTestId('work-claim-r1'));
    await userEvent.click(await screen.findByTestId('claim-confirm'));
    await waitFor(() => expect(claimed).toEqual([{ taskIds: ['r1'] }]));
  });

  it('"Kiểm tra" begins the inspection of one’s own room and opens it', async () => {
    const begun: string[] = [];
    const own = G2.items[0] as Record<string, unknown>;
    installApiMock(
      routes({
        'POST /api/housekeeping/work/tasks/w4/begin-inspection': () => {
          begun.push('w4');
          return { status: 200, body: { task: { ...own, phase: 'INSPECTING' } } };
        },
        'GET /api/housekeeping/work/tasks/w4': () => ({ status: 200, body: { task: { ...own, phase: 'INSPECTING' } } }),
        'POST /api/housekeeping/work/tasks/w4/open': () => ({ status: 200, body: { task: { ...own, phase: 'INSPECTING' } } }),
      }),
    );
    renderApp('/app/inspections');
    await userEvent.click(await screen.findByTestId('work-step-w4'));
    await waitFor(() => expect(begun).toEqual(['w4']));
    expect(await screen.findByRole('heading', { name: 'PHÒNG 301' })).toBeInTheDocument();
  });

  it('shows the day’s own finished work, with its times and the "Không cần dọn" answered', async () => {
    installApiMock(
      routes({
        [HISTORY]: () => ({
          status: 200,
          body: {
            workDate: hcmToday(),
            totals: { completed: 1, noClean: 1 },
            shifts: [{ id: 'sh1', user: { id: 6, fullName: 'Buồng phòng Một' }, startedAt: '2026-09-19T01:00:00.000Z', endedAt: null, segments: [{ id: 'sg1', branch: BRANCH, staffName: 'x', startedAt: '2026-09-19T01:00:00.000Z', endedAt: null }] }],
            items: [
              roomTask('h1', { roomNumber: '101', floor: '1', state: 'COMPLETED', phase: 'COMPLETED', phaseLabel: 'Hoàn thành', cleanedBy: MINE, startedAt: '2026-09-19T02:00:00.000Z', completedAt: '2026-09-19T02:30:00.000Z', durationSeconds: 1800, workGroup: { id: 'g1', number: 1, name: null } }),
              roomTask('h2', { roomNumber: '102', floor: '1', voided: true, phase: 'NO_CLEAN', phaseLabel: 'Không cần dọn', noClean: { status: 'APPROVED', reason: 'Khách từ chối', requestedAt: null, requestedByName: 'Buồng phòng Một', decidedAt: null, decidedByName: 'Quản lý', decisionNote: null } }),
            ],
          },
        }),
      }),
    );
    renderApp('/app/inspections');
    const history = await screen.findByTestId('work-history');
    expect(await within(history).findByTestId('work-history-totals')).toHaveTextContent('Đã dọn xong: 1 · Không cần dọn (đã duyệt): 1');
    expect(within(history).getByTestId('history-item-h1')).toHaveTextContent('Công việc 1 · Tầng 1 · Phòng 101');
    expect(within(history).getByTestId('history-item-h1')).toHaveTextContent('30 phút');
    expect(within(history).getByTestId('history-item-h2')).toHaveTextContent('Không cần dọn — đã duyệt bởi Quản lý · Lý do: Khách từ chối');
    expect(within(history).getByTestId('work-history-shifts')).toHaveTextContent('05 Trương Định');
    expect(within(history).getByTestId('work-history-shifts')).not.toHaveTextContent('Chi nhánh');
  });

  it('offers no "Đổi chi nhánh" on shift — only "Kết thúc ca"', async () => {
    installApiMock(routes());
    renderApp('/app/inspections');
    const current = await screen.findByTestId('shift-current');
    expect(within(current).queryByTestId('shift-switch')).not.toBeInTheDocument();
    expect(within(current).queryByRole('button', { name: /Đổi chi nhánh/ })).not.toBeInTheDocument();
    expect(within(current).getByTestId('shift-end')).toBeInTheDocument();
  });

  it('"Kết thúc ca" shows the day’s summary', async () => {
    installApiMock(routes({ 'POST /api/housekeeping/shift/end': () => ({ status: 200, body: { shift: workShift(true) } }) }));
    renderApp('/app/inspections');
    await userEvent.click(within(await screen.findByTestId('shift-current')).getByTestId('shift-end'));
    await userEvent.click(await screen.findByTestId('shift-end-confirm'));
    const summary = await screen.findByTestId('shift-summary');
    expect(summary).toHaveTextContent('1 khách sạn');
    expect(summary).not.toHaveTextContent(/Chi nhánh \d/);
    expect(summary).toHaveTextContent('Hút thuốc: 2');
  });
});

describe('Bộ phận buồng phòng — a re-clean sent back by the manager', () => {
  const RECLEAN = roomTask('t9', {
    roomNumber: '105',
    cycleNumber: 2,
    phase: 'ACCEPTED',
    phaseLabel: 'Đã tiếp nhận / Chờ kiểm tra',
    reclean: { taskId: 't8', cycleNumber: 1, reason: 'Thiếu khăn tắm', reviewedByName: 'Quản lý Buồng', reviewedAt: '2026-10-05T03:00:00.000Z' },
  });

  it('marks it "Cần dọn lại" in the list and shows the manager’s reason on the room', async () => {
    installApiMock(
      shell(HOUSEKEEPING_USER, {
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: workShift() } }),
        'GET /api/housekeeping/catalog': () => ({ status: 200, body: CATALOG }),
        [`GET /api/housekeeping/work/items?date=${hcmToday()}`]: () => ({
          status: 200,
          body: { working: true, tasks: [roomTask('t1', { roomNumber: '101', phase: 'ACCEPTED' }), RECLEAN] },
        }),
        [`GET /api/housekeeping/work/groups?date=${hcmToday()}`]: () => ({ status: 200, body: { working: true, groups: [] } }),
        [`GET /api/housekeeping/work/history?date=${hcmToday()}`]: () => ({ status: 200, body: { workDate: hcmToday(), items: [], totals: { completed: 0, noClean: 0 }, shifts: [] } }),
        'POST /api/housekeeping/work/tasks/t9/begin-inspection': () => ({ status: 200, body: { task: RECLEAN } }),
        'GET /api/housekeeping/work/tasks/t9': () => ({ status: 200, body: { task: RECLEAN } }),
        'POST /api/housekeeping/work/tasks/t9/open': () => ({ status: 200, body: { task: RECLEAN } }),
      }),
    );
    renderApp('/app/inspections');
    const row = await screen.findByTestId('work-item-t9');
    expect(row).toHaveTextContent('Cần dọn lại');
    expect(screen.getByTestId('work-item-t1')).not.toHaveTextContent('Cần dọn lại');
    await userEvent.click(within(row).getByTestId('work-step-t9'));
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

  it('offers the six conditions; saving the inspection makes the room "Đã kiểm tra" — only "Bắt đầu dọn" starts the clock', async () => {
    const posted: unknown[] = [];
    const starts: unknown[] = [];
    const inspection = { id: 'in1', createdAt: new Date().toISOString(), inspectorId: 6, inspectorName: 'Buồng phòng Một', findings: [] };
    const inspected = roomTask('t1', { state: 'INSPECTED', stateLabel: 'Đã kiểm tra', startedAt: null, inspection });
    const started = roomTask('t1', { state: 'IN_PROGRESS', stateLabel: 'Đang dọn', startedAt: new Date().toISOString(), inspection });
    installApiMock(
      routes(roomTask('t1', { priority: true, note: 'Dọn trước 14:00' }), {
        'POST /api/housekeeping/work/tasks/t1/inspect': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { task: inspected } };
        },
        'POST /api/housekeeping/work/tasks/t1/start': () => {
          starts.push(1);
          return { status: 200, body: { task: started } };
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
    // Saved: "Đã kiểm tra" — nothing has started and no form is open.
    expect(await screen.findByTestId('cleaning-start-panel')).toBeInTheDocument();
    expect(screen.getByTestId('room-state')).toHaveTextContent('Đã kiểm tra');
    expect(screen.queryByTestId('cleaning-form')).not.toBeInTheDocument();
    expect(starts).toEqual([]);
    // "Bắt đầu dọn" — the explicit start; then the cleaning form opens.
    await userEvent.click(screen.getByTestId('cleaning-start'));
    expect(await screen.findByTestId('cleaning-form')).toBeInTheDocument();
    expect(screen.getByTestId('room-state')).toHaveTextContent('Đang dọn');
    expect(starts).toEqual([1]);
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
    // "Hoàn thành dọn phòng" shows everything entered first — nothing is sent yet.
    await userEvent.click(screen.getByTestId('cleaning-complete'));
    const summary = await screen.findByTestId('cleaning-summary');
    expect(within(summary).getByTestId('summary-linen')).toHaveTextContent('Ga giường: Queen × 2');
    expect(within(summary).getByTestId('summary-quantities')).toHaveTextContent('Khăn tắm: 2');
    // The used linen taken out: as many as were put in, unless changed.
    expect(within(summary).getByTestId('summary-collected')).toHaveTextContent('Ga giường: 2');
    expect(within(summary).getByTestId('summary-collected')).toHaveTextContent('Khăn tắm: 2');
    expect(within(summary).getByTestId('summary-replaced')).toHaveTextContent('Dầu gội');
    expect(within(summary).getByTestId('summary-special')).toHaveTextContent('L/B : Khách có hành lý gọn nhẹ');
    expect(within(summary).getByTestId('summary-special')).toHaveTextContent('DND : Không làm phiền');
    expect(within(summary).getByTestId('summary-note')).toHaveTextContent('Rèm hơi bẩn');
    expect(posted).toEqual([]);
    // "Quay lại sửa" returns to the form with every value kept.
    await userEvent.click(screen.getByTestId('cleaning-confirm-back'));
    expect(screen.queryByTestId('cleaning-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('linen-qty-BED_SHEET')).toHaveValue(2);
    expect(screen.getByTestId('cleaning-note')).toHaveValue('Rèm hơi bẩn');
    expect(posted).toEqual([]);
    // Only the final confirmation completes — once.
    await userEvent.click(screen.getByTestId('cleaning-complete'));
    await userEvent.click(await screen.findByTestId('cleaning-confirm-submit'));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          linen: { BED_SHEET: { size: 'Q', quantity: 2 } },
          quantities: { BATH_TOWEL: 2 },
          collected: { BED_SHEET: 2, BATH_TOWEL: 2 },
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
    expect(await within(nav).findByRole('link', { name: 'Phát hiện & thu tiền' })).toHaveAttribute('href', '/app/reports/housekeeping');

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

  it('no longer carries "Các công việc trong ngày" — and asks the server for "Hôm nay", one day or a range', async () => {
    const fetchMock = installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/reports/housekeeping');
    await screen.findByTestId('room-issue-table-1');
    expect(screen.queryByTestId('supervisor-work-orders')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Các công việc trong ngày');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/work-orders'))).toBe(false);
    // The three periods, on the server's query; the branch filter is still there.
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const filters = screen.getByTestId('housekeeping-filters');
    await userEvent.click(within(filters).getByRole('button', { name: 'Hôm nay' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/housekeeping/issues?from=${today}&to=${today}`)).toBe(true),
    );
    await userEvent.click(within(filters).getByRole('button', { name: 'Ngày cụ thể' }));
    expect(within(filters).getByRole('button', { name: 'Khoảng ngày' })).toBeInTheDocument();
    expect(screen.getByTestId('housekeeping-branch')).toBeInTheDocument();
  });

  it('lets a Quản lý lễ tân "Xóa" a finding of its branch too — the same confirmation and reason', async () => {
    const posted: Record<string, unknown>[] = [];
    const manager = { id: 3, username: 'qlletan', fullName: 'Quản lý lễ tân', role: 'RECEPTION_MANAGER' as const, branch: null, active: true, mustChangePassword: false, managedBranchIds: [1] };
    installApiMock(
      shell(manager, {
        'GET /api/branches': () => ({ status: 200, body: { branches: [{ ...BRANCH, active: true }] } }),
        ...anyIssuesRoute(() => ({ status: 200, body: { issues: [roomIssue('a')], total: 1, truncated: false, summary: SUMMARY } })),
        'POST /api/housekeeping/issues/a/void': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { issue: roomIssue('a', { voided: true }) } };
        },
      }),
    );
    renderApp('/app/reports/housekeeping');
    await userEvent.click(await screen.findByTestId('void-room-a'));
    const dialog = await screen.findByRole('dialog', { name: /Hủy vấn đề — Phòng/ });
    await userEvent.type(within(dialog).getByTestId('void-room-reason'), 'Ghi trùng');
    await userEvent.click(within(dialog).getByTestId('void-room-confirm'));
    await waitFor(() => expect(posted).toEqual([{ reason: 'Ghi trùng' }]));
  });

  it('can settle an issue too, exactly as Reception does', async () => {
    installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/housekeeping');
    await userEvent.click(await screen.findByTestId('collect-a'));
    expect(await screen.findByTestId('collection-status-COLLECTED')).toBeChecked();
  });
});
