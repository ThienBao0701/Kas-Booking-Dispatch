/**
 * "KHO HÀNG", ON SCREEN — four warehouses, coded items — and the manager's daily work.
 *
 *   1. "Nhập kho": many items in ONE "Lưu phiếu nhập", each item once
 *   2. "Kiểm kho": the manager counts blind — no book figure, no difference — and gives a reason when asked
 *   3. "Báo hỏng": quantity no more than there is, a reason, sent once
 *   4. the Admin: every branch's stock, and the damage report to review
 *   5. "Phân công việc ngày hôm sau": tomorrow's board, its own day
 *   6. "Dọn phòng": the manager's own rooms, the worker flow
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';
import { hcmToday, hcmTomorrow } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const BRANCH2 = { id: 2, code: 'LTT', hotelName: 'KAS', address: '260 Lý Tự Trọng', branchNumber: 2 };
const MANAGER: AuthUser = { id: 9, username: 'qlbp', fullName: 'Quản lý Buồng', role: 'HOUSEKEEPING_MANAGER', branch: BRANCH, active: true, mustChangePassword: false };

type Handler = (init: RequestInit) => { status: number; body: unknown };

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
    'GET /api/nav-badges': () => ({ status: 200, body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } } }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH2] } }),
    ...extra,
  };
}

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    branch: BRANCH,
    warehouse: 'LINEN',
    name: 'Khăn tắm',
    variant: '',
    label: 'Khăn tắm',
    code: '3.001',
    unit: 'cái',
    cleaningOrder: null,
    unclassified: false,
    legacyBalances: [],
    lowStockThreshold: null,
    lowStock: false,
    note: null,
    archived: false,
    balances: { AVAILABLE: 20, DAMAGED: 0 },
    pendingDamage: 0,
    opened: true,
    ...over,
  };
}

const TOWEL = item('towel');
const KING = item('king', { name: 'Ga giường King', label: 'Ga giường King', code: '3.002', balances: { AVAILABLE: 5, DAMAGED: 0 } });
const LINEN_ITEMS = 'GET /api/housekeeping/inventory/items?warehouse=LINEN';
const RECEIPTS = 'GET /api/housekeeping/inventory/receipts?warehouse=LINEN';

describe('"Nhập kho" — one delivery, many items', () => {
  it('saves every line in ONE "Lưu phiếu nhập" — an item already on a line is not offered again', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL, KING] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'POST /api/housekeeping/inventory/receipts': (init) => {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          return { status: 201, body: { duplicate: false, receipt: { id: 'r1', lines: body.lines } } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-receive-open'));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByTestId('receipt-save');
    expect(save).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByTestId('receipt-item-0'), 'towel');
    await userEvent.type(within(dialog).getByTestId('receipt-qty-0'), '20');
    await userEvent.click(within(dialog).getByTestId('receipt-add-line'));
    // The towel is on the first line: the second offers the sheet only.
    const second = within(dialog).getByTestId('receipt-item-1');
    expect(within(second).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Chọn mặt hàng —', 'Ga giường King (cái)']);
    await userEvent.selectOptions(second, 'king');
    // A line without its quantity holds the save.
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('receipt-qty-1'), '5');
    expect(within(dialog).getByTestId('receipt-count')).toHaveTextContent('2 mặt hàng');
    // Only the date and time, the items, their quantities and an optional note are asked.
    expect(within(dialog).getByTestId('receipt-at')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Số phiếu|Ghi chú phiếu/)).not.toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty('reference');
    expect(posted[0]).not.toHaveProperty('note');
    expect(posted[0]).toMatchObject({
      warehouse: 'LINEN',
      receivedAt: expect.any(String),
      requestId: expect.any(String),
      lines: [
        { itemId: 'towel', quantity: 20 },
        { itemId: 'king', quantity: 5 },
      ],
    });
  });
});

describe('"Kiểm kho"', () => {
  it('lets the Quản lý buồng phòng count blind — no book figure, no difference — sending only what was counted and why', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL, KING] } }),
        'GET /api/housekeeping/inventory/items?warehouse=CHEMICAL_TOOLS': () => ({ status: 200, body: { items: [] } }),
        'GET /api/housekeeping/inventory/counts': () => ({
          status: 200,
          body: {
            counts: [
              {
                id: 'c0',
                opening: false,
                branch: BRANCH,
                warehouse: 'LINEN',
                note: null,
                createdBy: { id: 9, name: 'Quản lý Buồng', role: 'HOUSEKEEPING_MANAGER' },
                createdAt: '2026-10-06T03:00:00.000Z',
                lines: [{ itemId: 'king', label: 'Ga giường · King', unit: 'cái', state: 'AVAILABLE', stateLabel: 'Sẵn dùng', countedQuantity: 7, reason: null }],
              },
            ],
          },
        }),
        'POST /api/housekeeping/inventory/counts': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { duplicate: false, count: { id: 'c1', lines: [{ countedQuantity: 19 }] } } };
        },
      }),
    );
    renderApp('/app/hk/stock-count');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Kiểm kho' })).toBeInTheDocument();
    expect(screen.getByTestId('daily-tab-count')).toHaveAttribute('aria-pressed', 'true');
    // The four warehouses, in their order; the count starts on the first.
    expect(within(screen.getByTestId('count-warehouse')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Hóa chất & dụng cụ', 'Đồ dùng cho khách', 'Đồ vải', 'Đồ tiêu hao']);
    await userEvent.click(screen.getByTestId('count-warehouse-LINEN'));
    await userEvent.selectOptions(await screen.findByTestId('count-item-0'), 'towel');
    // Neither the book's figure nor a difference is on the screen.
    expect(screen.queryByTestId('count-system-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('count-diff-0')).not.toBeInTheDocument();
    expect(screen.queryByText('Trên sổ')).not.toBeInTheDocument();
    expect(screen.queryByText('Chênh lệch')).not.toBeInTheDocument();
    await userEvent.type(screen.getByTestId('count-counted-0'), '19');
    await userEvent.type(screen.getByTestId('count-reason-0'), 'Mất 1 khăn');
    await userEvent.click(screen.getByTestId('count-save'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ warehouse: 'LINEN', lines: [{ itemId: 'towel', state: 'AVAILABLE', countedQuantity: 19, reason: 'Mất 1 khăn' }] });
    expect((posted[0]!.lines as Record<string, unknown>[])[0]).not.toHaveProperty('systemQuantity');
    expect(await screen.findByText('Đã lưu kiểm kho.')).toBeInTheDocument();
    // The history: what was counted, never "Sổ → thực tế".
    await userEvent.click(screen.getAllByText('Lịch sử kiểm kho')[0]!);
    const history = await screen.findByTestId('count-history');
    expect(within(history).getByText('Đếm được')).toBeInTheDocument();
    expect(within(history).queryByText('Sổ → thực tế')).not.toBeInTheDocument();
  });
});

describe('"Báo hỏng / Không thể tái sử dụng"', () => {
  it('sends the item, quantity, state and reason — never more than there is', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'POST /api/housekeeping/inventory/damage': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { duplicate: false, report: { quantity: 2, unit: 'cái', label: 'Khăn tắm' } } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-more-towel'));
    await userEvent.click(await screen.findByTestId('inventory-damage-towel'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('damage-quantity'), '21');
    expect(within(dialog).getByText('Chỉ còn 20 cái.')).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByTestId('damage-quantity'));
    await userEvent.type(within(dialog).getByTestId('damage-quantity'), '2');
    expect(within(dialog).getByTestId('damage-save')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('damage-reason'), 'Rách không dùng được');
    // The room and the sources: one tap further, optional.
    await userEvent.click(within(dialog).getByText(/Phòng, công việc, sự cố liên quan/));
    await userEvent.type(within(dialog).getByTestId('damage-room'), '102');
    await userEvent.click(within(dialog).getByTestId('damage-save'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ itemId: 'towel', quantity: 2, fromState: 'AVAILABLE', reason: 'Rách không dùng được', roomNumber: '102', requestId: expect.any(String) });
    expect(await screen.findByText(/đã gửi Admin/)).toBeInTheDocument();
  });
});

describe('the Admin — "Tồn kho & Báo hỏng"', () => {
  const report = {
    id: 'd1',
    branch: BRANCH,
    warehouse: 'LINEN',
    warehouseLabel: 'Kho Linens',
    itemId: 'towel',
    label: 'Khăn tắm',
    unit: 'cái',
    quantity: 3,
    fromState: 'AVAILABLE',
    fromStateLabel: 'Sẵn dùng',
    reason: 'Rách',
    roomNumber: '102',
    taskId: 'task-102',
    issueId: 'issue-9',
    task: { id: 'task-102', label: 'Phòng 102 · 20/10/2026 · Công việc 3', roomNumber: '102', workDate: '2026-10-20' },
    issue: { id: 'issue-9', label: 'Phòng 102 — Ống nước rò', status: 'IN_PROGRESS', statusLabel: 'Đang sửa', reportedAt: '2026-10-20T01:00:00.000Z' },
    status: 'PENDING',
    statusLabel: 'Chờ Admin xem',
    reportedBy: { id: 9, name: 'Quản lý Buồng' },
    reportedAt: '2026-10-20T02:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    balances: { AVAILABLE: 17, DAMAGED: 3 },
    history: [],
  };

  it('shows every branch’s stock, and reviews the report a notification links to — a rejection needs its reason', async () => {
    const reviewed: Record<string, unknown>[] = [];
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/housekeeping/inventory/items': () => ({
          status: 200,
          body: { items: [TOWEL, item('t2', { branch: BRANCH2, balances: { AVAILABLE: 4, DAMAGED: 0 }, legacyBalances: [{ state: 'DIRTY', stateLabel: 'Bẩn', quantity: 6 }] })] },
        }),
        'GET /api/housekeeping/inventory/damage?status=PENDING': () => ({ status: 200, body: { reports: [report] } }),
        'GET /api/housekeeping/inventory/damage': () => ({ status: 200, body: { reports: [report] } }),
        'POST /api/housekeeping/inventory/damage/d1/review': (init) => {
          reviewed.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: { ...report, status: 'REJECTED' } } };
        },
      }),
    );
    renderApp('/app/inventory?damage=d1');
    const dialog = await screen.findByRole('dialog', { name: /Báo hỏng — Khăn tắm/ });
    expect(within(dialog).getByTestId('review-detail')).toHaveTextContent('3 cái · từ “Sẵn dùng”');
    expect(within(dialog).getByTestId('review-detail')).toHaveTextContent('Rách · Phòng 102');
    // The linked sources, as the manager chose them.
    expect(within(dialog).getByTestId('review-sources')).toHaveTextContent('Công việc buồng phòng: Phòng 102 · 20/10/2026 · Công việc 3');
    expect(within(dialog).getByTestId('review-sources')).toHaveTextContent('Sự cố kỹ thuật: Phòng 102 — Ống nước rò · Đang sửa');
    expect(within(dialog).getByTestId('review-reject')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('review-note'), 'Còn dùng được');
    await userEvent.click(within(dialog).getByTestId('review-reject'));
    await waitFor(() => expect(reviewed).toEqual([{ decision: 'REJECT', note: 'Còn dùng được' }]));
    expect(await screen.findByText(/số lượng đã hoàn lại kho/)).toBeInTheDocument();
    expect(screen.getByTestId('admin-pending-damage')).toHaveTextContent('1');
    // The stock of every branch, side by side.
    await userEvent.click(screen.getByRole('button', { name: 'Tồn kho' }));
    const table = await screen.findByTestId('admin-inventory-items');
    expect(table).toHaveTextContent('260 Lý Tự Trọng');
    expect(table).toHaveTextContent('05 Trương Định');
    // One on-hand figure and the written-off; a dirty balance from before is flagged, not added.
    expect(table).not.toHaveTextContent('Đang giặt');
    expect(table).toHaveTextContent('3.001');
    expect(table).toHaveTextContent('Số cũ cần kiểm tra: bẩn 6');
  });
});

describe('"Công việc mỗi ngày cần làm"', () => {
  const TOMORROW = hcmTomorrow();

  it('"Phân công việc ngày hôm sau" prepares TOMORROW’s board — its own day, no date to change', async () => {
    const asked: string[] = [];
    installApiMock(
      shell(MANAGER, {
        'GET /api/housekeeping/catalog': () => ({ status: 200, body: { statusCodes: [], states: {}, linen: [], linenSizes: [], quantities: [], replacements: [], specialStatuses: [], maxQuantity: 999 } }),
        'GET /api/housekeeping/manager/staff?branchId=1': () => ({ status: 200, body: { staff: [] } }),
        [`GET /api/housekeeping/manager/tasks?date=${TOMORROW}&branchId=1`]: () => {
          asked.push('tasks');
          return { status: 200, body: { tasks: [] } };
        },
        [`GET /api/housekeeping/manager/work-groups?date=${TOMORROW}&branchId=1`]: () => {
          asked.push('groups');
          return { status: 200, body: { groups: [] } };
        },
        'GET /api/housekeeping/manager/areas?branchId=1': () => ({ status: 200, body: { areas: { branchId: 1, floors: [], areas: [], unplacedRooms: [] } } }),
      }),
    );
    renderApp('/app/hk/tomorrow');
    expect(await screen.findByTestId('daily-tab-tomorrow')).toHaveAttribute('aria-pressed', 'true');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Phân công việc ngày hôm sau' })).toBeInTheDocument();
    await waitFor(() => expect(asked).toEqual(expect.arrayContaining(['tasks', 'groups'])));
    expect(screen.getByTestId('hk-period-value')).toHaveTextContent(TOMORROW.split('-').reverse().join('/'));
    // Tomorrow is fixed: no date field; and no "your shift" panel — work is done on its day.
    expect(screen.queryByTestId('hk-date')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-shift')).not.toBeInTheDocument();
  });

  it('"Dọn phòng" is the manager’s own shift and rooms — the worker flow', async () => {
    installApiMock(
      shell(MANAGER, {
        'GET /api/housekeeping/shift': () => ({ status: 200, body: { shift: null } }),
        [`GET /api/housekeeping/manager/work-groups?date=${hcmToday()}&branchId=1`]: () => ({ status: 200, body: { groups: [] } }),
      }),
    );
    renderApp('/app/hk/clean');
    expect(await screen.findByTestId('daily-tab-clean')).toHaveAttribute('aria-pressed', 'true');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Dọn phòng' })).toBeInTheDocument();
    expect(await screen.findByTestId('manager-shift')).toBeInTheDocument();
    expect(screen.getByTestId('manager-shift-start')).toBeInTheDocument();
  });
});

describe('keeping the items, and the Admin’s damage filters', () => {
  it('edits an item’s unit, threshold and note — never its name or code — and lists archived items when asked', async () => {
    const patched: Record<string, unknown>[] = [];
    let archived = false;
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL] } }),
        [`${LINEN_ITEMS}&includeArchived=true`]: () => {
          archived = true;
          return { status: 200, body: { items: [TOWEL, item('old', { name: 'Khăn cũ', label: 'Khăn cũ', code: '3.009', archived: true })] } };
        },
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'PATCH /api/housekeeping/inventory/items/towel': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { item: { ...TOWEL, lowStockThreshold: 5 } } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    // The code beside the name — the manager's view.
    expect(await screen.findByTestId('inventory-code-towel')).toHaveTextContent('3.001');
    // The catalog tools are one tap away: "Quản lý danh mục".
    await userEvent.click(await screen.findByTestId('inventory-manage-open'));
    const manage = await screen.findByTestId('inventory-manage');
    // "Xuất Excel" opens the file of this warehouse.
    expect(within(manage).getByTestId('inventory-export')).toHaveAttribute('href', '/api/housekeeping/inventory/export.xlsx?warehouse=LINEN');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByTestId('inventory-more-towel'));
    await userEvent.click(await screen.findByTestId('inventory-edit-towel'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa Khăn tắm' });
    expect(within(dialog).getByTestId('inventory-item-name')).toBeDisabled();
    expect(within(dialog).getByTestId('inventory-item-code')).toBeDisabled();
    expect(within(dialog).getByTestId('inventory-item-code')).toHaveValue('3.001');
    await userEvent.type(within(dialog).getByTestId('inventory-item-threshold'), '5');
    await userEvent.click(within(dialog).getByTestId('inventory-item-save'));
    await waitFor(() => expect(patched).toEqual([{ unit: 'cái', lowStockThreshold: 5, note: '' }]));
    // Archived items: off the list until asked for, then marked and without actions.
    await userEvent.click(await screen.findByTestId('inventory-manage-open'));
    await userEvent.click(await screen.findByTestId('inventory-show-archived'));
    await userEvent.keyboard('{Escape}');
    const table = screen.getByTestId('inventory-items');
    expect(await within(table).findByText('Khăn cũ')).toBeInTheDocument();
    expect(archived).toBe(true);
    expect(within(table).getByText('Ngừng sử dụng')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-more-old')).not.toBeInTheDocument();
  });

  it('filters the Admin’s damage reports by status and period, and opens a reviewed one read-only with its history', async () => {
    const asked: string[] = [];
    const reviewed = {
      id: 'd2',
      branch: BRANCH2,
      warehouse: 'LINEN',
      warehouseLabel: 'Kho đồ vải',
      itemId: 't2',
      label: 'Khăn tắm',
      unit: 'cái',
      quantity: 1,
      fromState: 'AVAILABLE',
      fromStateLabel: 'Sẵn dùng',
      reason: 'Cháy',
      roomNumber: null,
      taskId: null,
      status: 'ACKNOWLEDGED',
      statusLabel: 'Đã xác nhận',
      reportedBy: { id: 8, name: 'QL CN2' },
      reportedAt: '2026-10-19T02:00:00.000Z',
      reviewedBy: { id: 1, name: 'Quản trị viên' },
      reviewedAt: '2026-10-19T03:00:00.000Z',
      reviewNote: null,
      balances: { AVAILABLE: 3, DAMAGED: 1 },
      history: [
        { type: 'DAMAGE', typeLabel: 'Báo hỏng', state: 'AVAILABLE', stateLabel: 'Sẵn dùng', delta: -1, balanceAfter: 3, createdAt: '2026-10-19T02:00:00.000Z', actorNameSnapshot: 'QL CN2' },
        { type: 'DAMAGE', typeLabel: 'Báo hỏng', state: 'DAMAGED', stateLabel: 'Hỏng', delta: 1, balanceAfter: 1, createdAt: '2026-10-19T02:00:00.000Z', actorNameSnapshot: 'QL CN2' },
      ],
    };
    const handler = (url: string) => () => {
      asked.push(url);
      return { status: 200, body: { reports: [reviewed] } };
    };
    installApiMock(
      shell(ADMIN_USER, {
        'GET /api/housekeeping/inventory/items': () => ({ status: 200, body: { items: [] } }),
        'GET /api/housekeeping/inventory/items?includeArchived=true': () => ({ status: 200, body: { items: [] } }),
        'GET /api/housekeeping/inventory/damage?status=PENDING': () => ({ status: 200, body: { reports: [] } }),
        'GET /api/housekeeping/inventory/damage': handler('all'),
        'GET /api/housekeeping/inventory/damage?status=ACKNOWLEDGED': handler('acknowledged'),
        'GET /api/housekeeping/inventory/damage?status=ACKNOWLEDGED&from=2026-10-01&to=2026-10-31': handler('period'),
      }),
    );
    renderApp('/app/inventory');
    expect(await screen.findByTestId('inventory-export')).toHaveAttribute('href', '/api/housekeeping/inventory/export.xlsx');
    await userEvent.click(screen.getByRole('button', { name: 'Báo hỏng' }));
    await userEvent.selectOptions(await screen.findByTestId('damage-filter-status'), 'ACKNOWLEDGED');
    await userEvent.type(screen.getByTestId('damage-filter-from'), '2026-10-01');
    await userEvent.type(screen.getByTestId('damage-filter-to'), '2026-10-31');
    await waitFor(() => expect(asked).toEqual(expect.arrayContaining(['acknowledged', 'period'])));
    await userEvent.click(await screen.findByTestId('damage-review-d2'));
    const dialog = await screen.findByRole('dialog', { name: /Báo hỏng — Khăn tắm/ });
    expect(within(dialog).getByTestId('review-outcome')).toHaveTextContent('Đã xác nhận · Quản trị viên');
    expect(within(dialog).getByTestId('review-history')).toHaveTextContent('Báo hỏng: -1 sẵn dùng (còn 3)');
    // Reviewed once: no second decision offered.
    expect(within(dialog).queryByTestId('review-acknowledge')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('review-reject')).not.toBeInTheDocument();
  });
});

describe('damage sources, the room-cleaning list and the opening count', () => {
  it('links a damage report to this room’s work item and incident — both optional — and the Admin reads them', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'GET /api/housekeeping/inventory/damage/sources': () => ({ status: 200, body: { tasks: [], issues: [] } }),
        'GET /api/housekeeping/inventory/damage/sources?roomNumber=102': () => ({
          status: 200,
          body: {
            tasks: [{ id: 'task-102', label: 'Phòng 102 · 20/10/2026 · Công việc 3', roomNumber: '102', workDate: '2026-10-20' }],
            issues: [{ id: 'issue-9', label: 'Phòng 102 — Ống nước rò', statusLabel: 'Đang sửa' }],
          },
        }),
        'POST /api/housekeeping/inventory/damage': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { duplicate: false, report: { quantity: 1, unit: 'cái', label: 'Khăn tắm' } } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-more-towel'));
    await userEvent.click(await screen.findByTestId('inventory-damage-towel'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByText(/Phòng, công việc, sự cố liên quan/));
    await userEvent.type(within(dialog).getByTestId('damage-room'), '102');
    await waitFor(() => expect(within(within(dialog).getByTestId('damage-task')).getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(within(dialog).getByTestId('damage-task'), 'task-102');
    await userEvent.selectOptions(within(dialog).getByTestId('damage-issue'), 'issue-9');
    await userEvent.type(within(dialog).getByTestId('damage-quantity'), '1');
    await userEvent.type(within(dialog).getByTestId('damage-reason'), 'Ố nước rò');
    await userEvent.click(within(dialog).getByTestId('damage-save'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ roomNumber: '102', taskId: 'task-102', issueId: 'issue-9' });
  });

  it('chooses and orders the items of the room-cleaning form — codes shown to the manager — and saves the list in one request', async () => {
    const saved: unknown[] = [];
    const choice = (id: string, warehouse: string, code: string, label: string, cleaningOrder: number | null) => ({
      id,
      warehouse,
      warehouseLabel: warehouse === 'LINEN' ? 'Kho đồ vải' : 'Kho đồ dùng khác / Đồ tiêu hao (Amenities)',
      code,
      label,
      unit: 'cái',
      available: 5,
      cleaningOrder,
    });
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'GET /api/housekeeping/inventory/cleaning-items': () => ({
          status: 200,
          body: { branchId: 1, items: [choice('towel', 'LINEN', '3.001', 'Khăn tắm', 1), choice('king', 'LINEN', '3.002', 'Ga giường King', null), choice('water', 'AMENITY', '4.001', 'Nước suối', null)] },
        }),
        'PUT /api/housekeeping/inventory/cleaning-items': (init) => {
          saved.push(JSON.parse(String(init.body)));
          return { status: 200, body: { branchId: 1, items: [] } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-manage-open'));
    // The old form mapping is gone.
    expect(screen.queryByTestId('inventory-mapping-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inventory-from-catalog')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('inventory-cleaning-open'));
    const dialog = await screen.findByRole('dialog', { name: 'Mặt hàng dùng khi dọn phòng' });
    const chosen = await within(dialog).findByTestId('cleaning-items-chosen');
    expect(chosen).toHaveTextContent('3.001Khăn tắm');
    // Water joins, then goes first.
    await userEvent.click(within(dialog).getByTestId('cleaning-pick-water'));
    await userEvent.click(within(dialog).getByTestId('cleaning-up-water'));
    expect(within(within(dialog).getByTestId('cleaning-items-chosen')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Nước suối'),
      expect.stringContaining('Khăn tắm'),
    ]);
    await userEvent.click(within(dialog).getByTestId('cleaning-items-save'));
    await waitFor(() => expect(saved).toEqual([{ itemIds: ['water', 'towel'] }]));
  });

  it('classifies an item of the former equipment warehouse into one of the four', async () => {
    const patched: unknown[] = [];
    const mop = item('mop', { warehouse: 'EQUIPMENT', name: 'Máy hút bụi', label: 'Máy hút bụi', code: null, unclassified: true, balances: { AVAILABLE: 2, ISSUED: 0, DAMAGED: 0 } });
    installApiMock(
      shell(MANAGER, {
        'GET /api/housekeeping/inventory/items?warehouse=EQUIPMENT': () => ({ status: 200, body: { items: [mop] } }),
        'GET /api/housekeeping/inventory/receipts?warehouse=EQUIPMENT': () => ({ status: 200, body: { receipts: [] } }),
        'PATCH /api/housekeeping/inventory/items/mop': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { item: { ...mop, warehouse: 'CHEMICAL_TOOLS', code: '1.001', unclassified: false } } };
        },
      }),
    );
    renderApp('/app/hk/store/equipment');
    expect(await screen.findByText('Chờ phân loại')).toBeInTheDocument();
    // No receipts into it: its items wait to be classified.
    expect(screen.queryByTestId('inventory-receive-open')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('inventory-more-mop'));
    await userEvent.click(await screen.findByTestId('inventory-classify-mop'));
    const dialog = await screen.findByRole('dialog', { name: 'Phân loại Máy hút bụi' });
    expect(within(dialog).getByTestId('inventory-classify-save')).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId('inventory-classify-CHEMICAL_TOOLS'));
    await userEvent.click(within(dialog).getByTestId('inventory-classify-save'));
    await waitFor(() => expect(patched).toEqual([{ warehouse: 'CHEMICAL_TOOLS' }]));
    expect(await screen.findByText(/mã 1\.001/)).toBeInTheDocument();
  });

  it('asks for the opening count of items never set up — once, as one counted document', async () => {
    const posted: Record<string, unknown>[] = [];
    const fresh = item('fresh', { opened: false, balances: { AVAILABLE: 0, DAMAGED: 0 } });
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [fresh, KING] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'POST /api/housekeeping/inventory/counts': (init) => {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          return { status: 201, body: { duplicate: false, count: { id: 'c1', opening: true, lines: body.lines } } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    const banner = await screen.findByTestId('inventory-unopened');
    expect(banner).toHaveTextContent('1 mặt hàng chưa khai báo tồn đầu kỳ');
    expect(within(screen.getByTestId('inventory-items')).getByText('Chưa khai báo tồn đầu kỳ')).toBeInTheDocument();
    await userEvent.click(within(banner).getByTestId('inventory-opening-open'));
    const dialog = await screen.findByRole('dialog');
    // Only the item never set up is offered; damaged is not an opening state.
    expect(within(dialog).queryByTestId('opening-king-AVAILABLE')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('opening-fresh-DAMAGED')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('opening-save')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('opening-fresh-AVAILABLE'), '20');
    await userEvent.click(within(dialog).getByTestId('opening-save'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      warehouse: 'LINEN',
      opening: true,
      requestId: expect.any(String),
      lines: [
        { itemId: 'fresh', state: 'AVAILABLE', systemQuantity: 0, countedQuantity: 20 },
      ],
    });
    expect(await screen.findByText('Đã khai báo tồn đầu kỳ cho 1 mặt hàng.')).toBeInTheDocument();
  });
});

describe('"Thêm mặt hàng" — several at once', () => {
  it('asks the names only — the codes are the server’s — removes a row, and saves them all in ONE request', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [TOWEL] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
        'POST /api/housekeeping/inventory/items/batch': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { items: [item('k'), item('q')] } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-manage-open'));
    await userEvent.click(await screen.findByTestId('inventory-item-open'));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm mặt hàng — Kho đồ vải' });
    const save = within(dialog).getByTestId('inventory-items-save');
    expect(save).toBeDisabled();
    // Only a name per row: no code, unit, size or note to type.
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    await userEvent.type(within(dialog).getByTestId('inventory-new-name-0'), 'Ga giường King');
    for (const [i, name] of [[1, 'Ga giường Queen'], [2, 'Ga giường Twin']] as const) {
      await userEvent.click(within(dialog).getByTestId('inventory-new-add'));
      await userEvent.type(within(dialog).getByTestId(`inventory-new-name-${i}`), name);
    }
    await userEvent.click(within(dialog).getByTestId('inventory-new-remove-2'));
    expect(save).toHaveTextContent('Lưu 2 mặt hàng');
    await userEvent.click(save);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ warehouse: 'LINEN', items: [{ name: 'Ga giường King' }, { name: 'Ga giường Queen' }] });
  });
});

describe('the Admin’s shared catalog and receipts for several branches', () => {
  const ADMIN_ROUTES = (extra: Record<string, Handler> = {}) =>
    shell(ADMIN_USER, {
      'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH2] } }),
      'GET /api/housekeeping/inventory/items?warehouse=LINEN&branchId=1': () => ({ status: 200, body: { items: [{ ...TOWEL, scope: 'SYSTEM' }] } }),
      'GET /api/housekeeping/inventory/items?warehouse=LINEN&branchId=2': () => ({
        status: 200,
        body: { items: [{ ...TOWEL, id: 'towel-2', branch: BRANCH2, scope: 'SYSTEM' }, item('local-2', { branch: BRANCH2, name: 'Khăn riêng', label: 'Khăn riêng', code: '3.004', scope: 'BRANCH' })] },
      }),
      ...extra,
    });

  it('adds shared items by name alone — "Danh mục dùng chung toàn hệ thống", for all eight branches, with no stock', async () => {
    const posted: unknown[] = [];
    installApiMock(
      ADMIN_ROUTES({
        'POST /api/housekeeping/inventory/items/batch': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { items: [item('s1', { scope: 'SYSTEM', name: 'Khăn tắm' })] } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    // No branch to choose first: the catalog is the system's.
    await userEvent.click(await screen.findByTestId('inventory-shared-open'));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm mặt hàng dùng chung — Kho đồ vải' });
    expect(within(dialog).getByTestId('inventory-new-scope')).toHaveTextContent('Danh mục dùng chung toàn hệ thống');
    expect(within(dialog).getByTestId('inventory-new-scope')).toHaveTextContent('Tạo mặt hàng không tạo tồn kho');
    await userEvent.type(within(dialog).getByTestId('inventory-new-name-0'), 'Khăn tắm');
    await userEvent.click(within(dialog).getByTestId('inventory-items-save'));
    await waitFor(() => expect(posted).toEqual([{ warehouse: 'LINEN', items: [{ name: 'Khăn tắm' }] }]));
  });

  it('receives for chosen branches, each with its own quantities — never one figure copied to all', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      ADMIN_ROUTES({
        'POST /api/housekeeping/inventory/receipts/multi': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { receipts: [{ id: 'r1' }, { id: 'r2' }], duplicate: false } };
        },
      }),
    );
    renderApp('/app/hk/store/linens');
    await userEvent.click(await screen.findByTestId('inventory-multi-receipt-open'));
    const dialog = await screen.findByRole('dialog', { name: /Nhập kho cho các chi nhánh/ });
    expect(within(dialog).getByTestId('multi-receipt-save')).toBeDisabled();
    await userEvent.click(await within(dialog).findByTestId('multi-receipt-branch-1'));
    await userEvent.click(within(dialog).getByTestId('multi-receipt-branch-2'));
    // Each branch lists its own items — CN2's own one only under CN2.
    expect(await within(dialog).findByTestId('multi-receipt-qty-2-local-2')).toBeInTheDocument();
    expect(within(within(dialog).getByTestId('multi-receipt-lines-1')).queryByText('Khăn riêng')).not.toBeInTheDocument();
    await userEvent.type(await within(dialog).findByTestId('multi-receipt-qty-1-towel'), '5');
    await userEvent.type(within(dialog).getByTestId('multi-receipt-qty-2-towel-2'), '3');
    await userEvent.click(within(dialog).getByTestId('multi-receipt-save'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      warehouse: 'LINEN',
      requestId: expect.any(String),
      branches: [
        { branchId: 1, lines: [{ itemId: 'towel', quantity: 5 }] },
        { branchId: 2, lines: [{ itemId: 'towel-2', quantity: 3 }] },
      ],
    });
    expect(await screen.findByText('Đã nhập kho cho 2 chi nhánh.')).toBeInTheDocument();
  });

  it('marks shared and branch items, and gives the manager no "Xóa" on a shared one', async () => {
    installApiMock(
      shell(MANAGER, {
        [LINEN_ITEMS]: () => ({ status: 200, body: { items: [{ ...TOWEL, scope: 'SYSTEM' }, item('mine', { name: 'Khăn riêng', label: 'Khăn riêng', code: '3.004', scope: 'BRANCH' })] } }),
        [RECEIPTS]: () => ({ status: 200, body: { receipts: [] } }),
      }),
    );
    renderApp('/app/hk/store/linens');
    expect(within(await screen.findByTestId('inventory-item-towel')).getByText('Dùng chung')).toBeInTheDocument();
    expect(within(screen.getByTestId('inventory-item-mine')).getByText('Riêng chi nhánh')).toBeInTheDocument();
    // The manager adds its branch's own.
    await userEvent.click(screen.getByTestId('inventory-manage-open'));
    await userEvent.click(await screen.findByTestId('inventory-item-open'));
    expect(within(await screen.findByRole('dialog')).getByTestId('inventory-new-scope')).toHaveTextContent('Mặt hàng riêng chi nhánh');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByTestId('inventory-more-towel'));
    expect(await screen.findByTestId('inventory-edit-towel')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-remove-towel')).not.toBeInTheDocument();
  });
});
