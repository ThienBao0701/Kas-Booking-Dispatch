/**
 * "BUỒNG PHÒNG" — the three screens over one data set.
 *
 *   HOUSEKEEPING  records an inspection: person, room, the conditions found.
 *   RECEPTION     settles each issue on its own (amount · status · method/reason).
 *   ADMIN         reads and reports on all of it, and can void.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The form offers the six conditions, needs a person, a room and at least
 *      one condition, and needs a description for "Vấn đề khác".
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

describe('Bộ phận buồng phòng — the inspection form', () => {
  const routes = (extra: Record<string, Handler> = {}) =>
    shell(HOUSEKEEPING_USER, {
      'GET /api/housekeeping/issues': () => ({
        status: 200,
        body: { issues: [], total: 0, truncated: false, summary: null },
      }),
      ...extra,
    });

  it('lands on the inspection page, with its two menu entries', async () => {
    installApiMock(routes());
    renderApp('/app');
    expect(await screen.findByTestId('inspection-form')).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Kiểm tra phòng', 'Giao nhận hàng hóa']);
  });

  it('offers the six conditions, in the specified words', async () => {
    installApiMock(routes());
    renderApp('/app/inspections');
    const form = await screen.findByTestId('inspection-form');
    const labels = within(form)
      .getAllByRole('checkbox')
      .map((c) => c.closest('label')!.textContent);
    expect(labels).toEqual([
      'Hút thuốc',
      'Phòng có mùi',
      'Cơ sở vật chất hư hỏng',
      'Khách quên đồ',
      'Phòng có khách nhưng hệ thống không có',
      'Vấn đề khác',
    ]);
  });

  it('needs the person, the room and at least one condition — and a description for "Vấn đề khác"', async () => {
    installApiMock(routes());
    renderApp('/app/inspections');
    const save = await screen.findByTestId('inspection-save');
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByTestId('inspection-staff'), 'Chị Lan');
    await userEvent.type(screen.getByTestId('inspection-room'), '302');
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByTestId('inspection-type-OTHER'));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId('inspection-note-OTHER'), 'Rèm bị rách');
    expect(save).toBeEnabled();

    // Unticking the only condition leaves nothing to record.
    await userEvent.click(screen.getByTestId('inspection-type-OTHER'));
    expect(save).toBeDisabled();
  });

  it('saves one inspection with every ticked condition, then clears the room but keeps the person', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      routes({
        'POST /api/housekeeping/inspections': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { inspection: { id: 'in1', roomNumber: '302', issues: [roomIssue('a'), roomIssue('b')] } } };
        },
      }),
    );
    renderApp('/app/inspections');
    await userEvent.type(await screen.findByTestId('inspection-staff'), 'Chị Lan');
    await userEvent.type(screen.getByTestId('inspection-room'), ' 302 ');
    await userEvent.click(screen.getByTestId('inspection-type-SMOKING'));
    await userEvent.click(screen.getByTestId('inspection-type-LOST_ITEM'));
    await userEvent.type(screen.getByTestId('inspection-note-LOST_ITEM'), 'Áo khoác đen');
    await userEvent.click(screen.getByTestId('inspection-save'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      roomNumber: '302',
      staffName: 'Chị Lan',
      issues: [{ type: 'SMOKING' }, { type: 'LOST_ITEM', note: 'Áo khoác đen' }],
    });
    await waitFor(() => expect(screen.getByTestId('inspection-room')).toHaveValue(''));
    expect(screen.getByTestId('inspection-staff')).toHaveValue('Chị Lan');
    expect(screen.getByTestId('inspection-type-SMOKING')).not.toBeChecked();
    expect(await screen.findByText(/Đã lưu kiểm tra phòng 302 \(2 vấn đề\)/)).toBeInTheDocument();
  });

  it('shows the server’s refusal and keeps what was typed', async () => {
    installApiMock(
      routes({
        'POST /api/housekeeping/inspections': () => ({
          status: 422,
          body: { error: { code: 'VALIDATION_ERROR', message: 'Vui lòng nhập số phòng.' } },
        }),
      }),
    );
    renderApp('/app/inspections');
    await userEvent.type(await screen.findByTestId('inspection-staff'), 'Chị Lan');
    await userEvent.type(screen.getByTestId('inspection-room'), '302');
    await userEvent.click(screen.getByTestId('inspection-type-ODOR'));
    await userEvent.click(screen.getByTestId('inspection-save'));
    expect(await screen.findByText('Vui lòng nhập số phòng.')).toBeInTheDocument();
    expect(screen.getByTestId('inspection-room')).toHaveValue('302');
  });

  it('shows its history with the status of each issue — and never the money', async () => {
    installApiMock(
      routes({
        'GET /api/housekeeping/issues': () => ({
          status: 200,
          body: {
            issues: [roomIssue('a', { collectionStatus: 'COLLECTED', collectionStatusLabel: 'Đã thu', collection: null })],
            total: 1,
            truncated: false,
            summary: null,
          },
        }),
      }),
    );
    renderApp('/app/inspections');
    const table = await screen.findByTestId('room-issue-table');
    expect(await within(table).findByText('Hút thuốc')).toBeInTheDocument();
    expect(within(table).getByText('Đã thu')).toBeInTheDocument();
    expect(within(table).getByText('302')).toBeInTheDocument();
    expect(within(table).queryByText(/₫/)).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Thu tiền|Cập nhật/ })).not.toBeInTheDocument();
  });

  it('cannot open the reception or Admin screens', async () => {
    installApiMock(routes());
    renderApp('/app/room-collections');
    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
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
    expect(within(nav).getByRole('link', { name: 'Thu tiền buồng phòng' })).toBeInTheDocument();
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
    return { [`GET /api/housekeeping/issues?from=${from}&to=${today}`]: handler };
  }

  it('is in the Admin menu, with the branch picker built from the branch table', async () => {
    installApiMock(routes(anyIssuesRoute(list())));
    renderApp('/app/housekeeping');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: 'Buồng phòng' })).toBeInTheDocument();

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
    const table = await screen.findByTestId('room-issue-table');
    expect(await within(table).findByText('Hút thuốc')).toBeInTheDocument();
    expect(within(table).getByText('260 Lý Tự Trọng - Chi nhánh 02')).toBeInTheDocument();
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
