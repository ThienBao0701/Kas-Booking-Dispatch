/**
 * "THU TIỀN THANH TOÁN" — the cash sheet, in the browser.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The rows are on the page the moment they are added — not behind a modal,
 *      and not on a second screen.
 *   2. "Tiền cuối ca" HAS NO INPUT. It is rendered from the server's figure, and
 *      nothing in this component adds the numbers up itself.
 *   3. An amount leaves the browser as an INTEGER, however it was displayed.
 *   4. "Xóa" asks for a reason and voids. A voided row stays visible, marked,
 *      and drops out of the totals.
 *   5. "Sửa" edits in place with "Lưu" and "Hủy sửa", and sends only what the
 *      server accepts — one method and one amount, never three amounts.
 *   6. "Tiền đầu ca" that was never counted reads "Chưa kiểm đếm", not 0 ₫.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion', address: '05 Trương Định', branchNumber: 1 };

const SESSION = {
  id: 's1',
  branchId: 1,
  shiftType: 'A',
  shiftName: 'Ca A',
  shiftWindow: '06:00 – 14:00',
  receptionistName: 'Nguyễn Văn A',
  startedAt: '2026-09-18T23:00:00.000Z',
  nominalEndAt: '2026-09-19T07:00:00.000Z',
  graceEndAt: '2026-09-19T07:10:00.000Z',
  closedAt: null,
  promptDue: false,
};

const OPTIONS = {
  categories: [
    { code: 'PAYMENT', label: 'Theo dõi thanh toán' },
    { code: 'GUEST_REQUEST', label: 'Vấn đề khách yêu cầu' },
    { code: 'FACILITY_ISSUE', label: 'Sự cố vật chất đang xử lý' },
    { code: 'CUSTOMER_COMPLAINT', label: 'Vấn đề về chất lượng và dịch vụ' },
    { code: 'ROOM_SERVICE', label: 'Dịch vụ phòng, KPI' },
  ],
  paymentMethods: [
    { code: 'CASH', label: 'Thu tiền mặt' },
    { code: 'TRANSFER', label: 'Chuyển khoản' },
    { code: 'CARD', label: 'Cà thẻ' },
  ],
  roomServiceTypes: [],
  paymentSources: ['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia'],
};

const EMPTY_COUNTS = {
  PAYMENT: 0,
  GUEST_REQUEST: 0,
  FACILITY_ISSUE: 0,
  CUSTOMER_COMPLAINT: 0,
  ROOM_SERVICE: 0,
};

function cash(over: Record<string, unknown> = {}) {
  return {
    openingCash: 7570000,
    cashCollected: 4400000,
    transferCollected: 240000,
    cardCollected: 500000,
    receivable: 0,
    cashExpense: 100000,
    endingCash: 11870000,
    paymentCount: 5,
    voidedCount: 0,
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}, detail: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    category: 'PAYMENT',
    categoryLabel: 'Theo dõi thanh toán',
    branchId: 1,
    branch: BRANCH,
    shiftSessionId: 's1',
    shiftType: 'A',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    createdBy: { id: 2, fullName: 'Lễ tân Một' },
    createdByName: 'Nguyễn Văn A',
    createdAt: '2026-09-19T01:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z',
    summary: 'Khách A · Thu tiền mặt 300.000 ₫',
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    payment: {
      ezCode: 'EZ123',
      source: 'Booking',
      guestName: 'Khách A',
      roomNumber: '101',
      method: 'CASH',
      methodLabel: 'Thu tiền mặt',
      amount: 300000,
      receivable: 0,
      expense: 0,
      note: 'Đêm đầu',
      cash: 300000,
      transfer: 0,
      card: 0,
      ...detail,
    },
    guestRequest: null,
    facility: null,
    complaint: null,
    roomService: null,
    audits: [],
    ...over,
  };
}

function shellRoutes(
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: SESSION } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reception/reports/options': () => ({ status: 200, body: OPTIONS }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({
      status: 200,
      body: { reports: [payment()], counts: { ...EMPTY_COUNTS, PAYMENT: 1 } },
    }),
    'GET /api/reception/shifts/cash': () => ({ status: 200, body: { cash: cash() } }),
    'GET /api/issues?pageSize=100&outstanding=true': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
    }),
    ...extra,
  };
}

/**
 * The ledger is one of five categories behind the overview's "Tổng" menu, and
 * its entry form is a dialog behind "+ Thêm giao dịch" — so a payment test walks
 * the same steps a cashier does.
 */
async function openPayment() {
  renderApp('/app/reports');
  await userEvent.click(await screen.findByTestId('report-total'));
  await userEvent.click(await screen.findByTestId('category-PAYMENT'));
}

async function openPaymentForm() {
  await openPayment();
  await userEvent.click(await screen.findByTestId('category-add'));
}

/** A shift whose drawer was never counted. */
const UNCOUNTED = {
  'GET /api/reception/shifts/cash': () => ({
    status: 200,
    body: { cash: cash({ openingCash: null, endingCash: null }) },
  }),
};

describe('the sheet', () => {
  it('shows the rows on the page, not behind a modal', async () => {
    installApiMock(shellRoutes());
    await openPayment();

    const table = await screen.findByTestId('payment-table');
    const row = within(table).getByTestId('payment-row-p1');
    expect(within(row).getByText('EZ123')).toBeInTheDocument();
    expect(within(row).getByText('Booking')).toBeInTheDocument();
    expect(within(row).getByText('Khách A')).toBeInTheDocument();
    expect(within(row).getByText('300.000 ₫')).toBeInTheDocument();
    // Staff, room and note are not the desk's columns any more — the data stays
    // on the record (the Admin shows it), it is just not in this table.
    expect(within(row).queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
    expect(within(row).queryByText('101')).not.toBeInTheDocument();
    expect(within(row).queryByText('Đêm đầu')).not.toBeInTheDocument();
  });

  it('shows the specified columns', async () => {
    installApiMock(shellRoutes());
    await openPayment();

    const table = await screen.findByTestId('payment-table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Nguồn',
      'Tiền mặt',
      'Cà thẻ',
      'Công nợ',
      'Chi',
      'Thao tác',
    ]);
    // ONE action column, holding both row actions.
    const row = within(table).getByTestId('payment-row-p1');
    const cells = within(row).getAllByRole('cell');
    const actions = cells[cells.length - 1]!;
    expect(within(actions).getByTestId('payment-edit-p1')).toBeInTheDocument();
    expect(within(actions).getByTestId('payment-void-p1')).toBeInTheDocument();
    expect(cells).toHaveLength(headers.length);
  });

  it('shows a card payment under "Cà thẻ" and a debt under "Công nợ"', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              payment({}, { method: 'CARD', methodLabel: 'Cà thẻ', amount: 500000, cash: 0, card: 500000, receivable: 200000 }),
            ],
            counts: { ...EMPTY_COUNTS, PAYMENT: 1 },
          },
        }),
      }),
    );
    await openPayment();

    const row = await screen.findByTestId('payment-row-p1');
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    // STT, Tên khách, Mã EZ, Nguồn, Tiền mặt, Cà thẻ, Công nợ, Chi, Thao tác.
    expect(cells.slice(4, 8)).toEqual(['—', '500.000 ₫', '200.000 ₫', '—']);
  });

  it('says so plainly when the shift has no transactions', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    await openPayment();
    expect(await screen.findByTestId('payment-empty')).toBeInTheDocument();
  });
});

describe('tiền đầu ca and tiền cuối ca', () => {
  it('renders the server’s figures and offers NO input for the ending one', async () => {
    installApiMock(shellRoutes());
    await openPayment();

    const totals = await screen.findByTestId('cash-summary-strip');
    expect(within(totals).getByTestId('ending-cash')).toHaveTextContent('11.870.000 ₫');
    expect(within(totals).getByText('7.570.000 ₫')).toBeInTheDocument();
    expect(within(totals).getByText('4.400.000 ₫')).toBeInTheDocument();

    // There is no field anywhere that could set an ending figure.
    expect(screen.queryByLabelText(/Tiền cuối ca/)).not.toBeInTheDocument();
    const inputs = within(totals).queryAllByRole('textbox');
    expect(inputs).toHaveLength(0);
  });

  it('distinguishes an uncounted drawer from an empty one', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ openingCash: null, endingCash: null }) },
        }),
      }),
    );
    await openPayment();

    // Waited on the TOTALS, which only render once the figures have arrived.
    // `opening-cash-value` reads "Chưa kiểm đếm" during loading too, so
    // asserting on it first would pass against an empty response.
    const totals = await screen.findByTestId('cash-summary-strip');
    expect(within(totals).getByTestId('ending-cash')).toHaveTextContent('Chưa xác định');
    expect(screen.getByTestId('opening-cash-value')).toHaveTextContent('Chưa kiểm đếm');
  });

  it('sends the opening count as an integer', async () => {
    const put: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ openingCash: null, endingCash: null }) },
        }),
        'PUT /api/reception/shifts/cash': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { cash: cash() } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('opening-cash-edit'));
    const input = await screen.findByTestId('opening-cash-input');
    await userEvent.type(input, '7570000');
    // Grouped for the operator…
    expect(input).toHaveValue('7.570.000');
    await userEvent.click(screen.getByTestId('opening-cash-save'));

    // …and an integer on the wire.
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ openingCash: 7570000 });
  });

  it('states the formula on screen', async () => {
    installApiMock(shellRoutes());
    await openPayment();
    const totals = await screen.findByTestId('cash-summary-strip');
    expect(totals).toHaveTextContent('Tiền đầu ca + Thu tiền mặt − Chi tiền mặt');
    expect(totals).toHaveTextContent('Chuyển khoản và cà thẻ không làm thay đổi tiền mặt');
  });
});

describe('an uncounted drawer cannot be saved as a counted zero', () => {
  /*
    Pressing "Lưu" on an untouched field used to send `openingCash: 0`, which is
    a valid count — after which "chưa kiểm đếm" is gone for good and the shift,
    the PDF and the XLSX print a confident "Tiền cuối ca" equal to the takings
    alone. There is no request that restores null.
  */
  it('disables Lưu while the field is empty', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ openingCash: null, endingCash: null }) },
        }),
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('opening-cash-edit'));
    expect(await screen.findByTestId('opening-cash-save')).toBeDisabled();

    await userEvent.type(screen.getByTestId('opening-cash-input'), '0');
    // A drawer TYPED as zero is a real count, and is allowed.
    expect(screen.getByTestId('opening-cash-save')).toBeEnabled();
  });

  it('sends nothing when the field is left empty', async () => {
    const put: unknown[] = [];
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ openingCash: null, endingCash: null }) },
        }),
        'PUT /api/reception/shifts/cash': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { cash: cash() } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('opening-cash-edit'));
    await userEvent.click(await screen.findByTestId('opening-cash-save'));
    expect(put).toHaveLength(0);
  });
});

describe('the sheet and its totals describe the SAME shift', () => {
  it('asks only for the open shift’s records', async () => {
    const urls: string[] = [];
    const fetchMock = installApiMock(shellRoutes());
    await openPayment();
    await screen.findByTestId('payment-table');

    for (const call of fetchMock.mock.calls) urls.push(String(call[0]));
    const reportReads = urls.filter((u) => u.includes('/api/reception/reports?'));
    expect(reportReads.length).toBeGreaterThan(0);
    /*
      Every read names the session. An unscoped read returns the branch's last
      500 rows across every shift and day, which would list last night's cash
      under a table whose totals cover only the current session.
    */
    for (const url of reportReads) expect(url).toContain('shiftSessionId=s1');
  });
});

describe('adding a transaction', () => {
  it('sends integers and clears the form', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: payment() } };
        },
      }),
    );
    await openPaymentForm();

    await userEvent.type(await screen.findByTestId('payment-ez'), 'EZ999');
    await userEvent.type(screen.getByTestId('payment-guest'), 'Khách B');
    await userEvent.selectOptions(screen.getByTestId('payment-method'), 'TRANSFER');
    await userEvent.type(screen.getByTestId('payment-amount'), '3150000');
    await userEvent.type(screen.getByTestId('payment-expense'), '100000');
    await userEvent.click(screen.getByTestId('payment-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0] as { payment: Record<string, unknown> };
    expect(body.payment.method).toBe('TRANSFER');
    expect(body.payment.amount).toBe(3150000);
    expect(body.payment.expense).toBe(100000);
    expect(body.payment.ezCode).toBe('EZ999');

    /*
      The dialog closes itself. It used to be a permanent form that blanked its
      own fields; now saving returns the cashier to the ledger, which is the
      thing they wanted to see the transaction land in.
    */
    await waitFor(() => expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument());
    expect(await screen.findByTestId('payment-table')).toBeInTheDocument();
  });

  it('will not submit without an amount', async () => {
    installApiMock(shellRoutes());
    await openPaymentForm();
    expect(await screen.findByTestId('payment-add')).toBeDisabled();

    await userEvent.type(screen.getByTestId('payment-amount'), '1000');
    expect(screen.getByTestId('payment-add')).toBeEnabled();
  });

  it('does not blank the form while the journal is still loading', async () => {
    installApiMock(shellRoutes());
    await openPaymentForm();

    // Typed IMMEDIATELY, before the shift-scoped journal query has resolved —
    // the moment at which the page used to unmount and take the text with it.
    const ez = await screen.findByTestId('payment-ez');
    await userEvent.type(ez, 'EZ777');
    await screen.findByTestId('payment-table');
    expect(screen.getByTestId('payment-ez')).toHaveValue('EZ777');
  });

  it('never asks who is entering it', async () => {
    installApiMock(shellRoutes());
    await openPaymentForm();
    const form = await screen.findByTestId('payment-form');
    expect(within(form).queryByLabelText(/Nhân viên/)).not.toBeInTheDocument();
  });
});

describe('correcting a row', () => {
  it('edits in place, with Lưu and Hủy sửa', async () => {
    const patched: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        'PATCH /api/reception/reports/p1': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: payment({}, { amount: 3000000, cash: 3000000 }) } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('payment-edit-p1'));
    const amount = await screen.findByTestId('payment-edit-amount-p1');
    expect(amount).toHaveValue('300.000');

    await userEvent.clear(amount);
    await userEvent.type(amount, '3000000');
    await userEvent.click(screen.getByTestId('payment-save-p1'));

    await waitFor(() => expect(patched).toHaveLength(1));
    const body = patched[0] as { payment: Record<string, unknown> };
    expect(body.payment.amount).toBe(3000000);
    // ONE method and ONE amount — never three amount columns, which would let a
    // row claim to be both cash and card.
    expect(body.payment.method).toBe('CASH');
    expect(body.payment).not.toHaveProperty('cash');
    expect(body.payment).not.toHaveProperty('transfer');
  });

  it('abandons the edit on Hủy sửa', async () => {
    installApiMock(shellRoutes());
    await openPayment();

    await userEvent.click(await screen.findByTestId('payment-edit-p1'));
    await userEvent.click(await screen.findByTestId('payment-cancel-p1'));
    expect(await screen.findByTestId('payment-row-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-edit-amount-p1')).not.toBeInTheDocument();
  });

  it('marks a row that has been corrected', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              payment({
                audits: [
                  {
                    id: 'a1',
                    action: 'EDIT',
                    field: 'amount',
                    oldValue: '3000000',
                    newValue: '300000',
                    reason: null,
                    actor: { id: 2, name: 'Nguyễn Văn A' },
                    shiftType: 'A',
                    createdAt: '2026-09-19T01:30:00.000Z',
                  },
                ],
              }),
            ],
            counts: { ...EMPTY_COUNTS, PAYMENT: 1 },
          },
        }),
      }),
    );
    await openPayment();
    expect(await screen.findByTestId('payment-edited-p1')).toHaveTextContent('Đã sửa');
  });
});

describe('voiding a row', () => {
  it('asks for a reason and posts a void, not a delete', async () => {
    const posted: Record<string, unknown>[] = [];
    const methods: string[] = [];
    const fetchMock = installApiMock(
      shellRoutes({
        'POST /api/reception/reports/p1/void': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: payment({ voided: true }) } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('payment-void-p1'));
    await userEvent.type(await screen.findByTestId('void-reason'), 'Nhập nhầm khách');
    await userEvent.click(screen.getByTestId('void-confirm'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ reason: 'Nhập nhầm khách' });

    // Nothing in this flow issued a DELETE.
    for (const call of fetchMock.mock.calls) {
      methods.push(String((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
    }
    expect(methods).not.toContain('DELETE');
  });

  it('keeps a voided row on screen, marked, with no actions', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [payment({ voided: true, voidReason: 'Nhập nhầm khách' })],
            counts: { ...EMPTY_COUNTS, PAYMENT: 1 },
          },
        }),
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ cashCollected: 0, endingCash: 7470000, voidedCount: 1 }) },
        }),
      }),
    );
    await openPayment();

    const row = await screen.findByTestId('payment-row-p1');
    expect(row).toHaveTextContent('Đã hủy: Nhập nhầm khách');
    expect(within(row).queryByTestId('payment-edit-p1')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('payment-void-p1')).not.toBeInTheDocument();

    // And the totals say it was excluded rather than silently dropping it.
    expect(await screen.findByTestId('voided-note')).toHaveTextContent('1 bản ghi đã hủy');
    expect(screen.getByTestId('ending-cash')).toHaveTextContent('7.470.000 ₫');
  });
});

/**
 * "CHƯA NHẬP TIỀN ĐẦU CA" — A REMINDER, NOT A GATE.
 *
 * The formula is unchanged and the page stays usable: an uncounted drawer only
 * means "Tiền cuối ca" reads "Chưa xác định" until the count is entered.
 */
describe('the opening-cash reminder', () => {
  it('appears when the drawer was never counted, with the exact wording', async () => {
    installApiMock(shellRoutes(UNCOUNTED));
    await openPayment();

    const warning = await screen.findByTestId('opening-cash-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveTextContent('Chưa nhập tiền đầu ca');
    expect(warning).toHaveTextContent('Tiền đầu ca chưa được thiết lập cho ca hiện tại.');
    expect(within(warning).getByTestId('opening-cash-warning-enter')).toHaveTextContent('Nhập tiền đầu ca');
  });

  it('is absent once the drawer has been counted — including a counted zero', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ openingCash: 0, endingCash: 4300000 }) },
        }),
      }),
    );
    await openPayment();

    await screen.findByTestId('cash-summary-strip');
    expect(screen.queryByTestId('opening-cash-warning')).not.toBeInTheDocument();
  });

  it('"Nhập tiền đầu ca" opens the same editor, and saving sends the count', async () => {
    const put: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        ...UNCOUNTED,
        'PUT /api/reception/shifts/cash': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { cash: cash() } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('opening-cash-warning-enter'));
    // The reminder steps aside while the count is being entered.
    expect(screen.queryByTestId('opening-cash-warning')).not.toBeInTheDocument();
    await userEvent.type(await screen.findByTestId('opening-cash-input'), '2000000');
    await userEvent.click(screen.getByTestId('opening-cash-save'));

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ openingCash: 2000000 });
  });

  it('does not block recording a transaction', async () => {
    const posted: unknown[] = [];
    installApiMock(
      shellRoutes({
        ...UNCOUNTED,
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: payment() } };
        },
      }),
    );
    await openPayment();
    await screen.findByTestId('opening-cash-warning');

    await userEvent.click(screen.getByTestId('category-add'));
    await userEvent.type(await screen.findByTestId('payment-amount'), '150000');
    await userEvent.click(screen.getByTestId('payment-add'));
    await waitFor(() => expect(posted).toHaveLength(1));
  });
});

describe('"Nguồn" is a controlled select', () => {
  it('offers exactly the five channels, and sends the one chosen', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: payment() } };
        },
      }),
    );
    await openPaymentForm();

    const source = await screen.findByTestId('payment-source');
    expect(source.tagName).toBe('SELECT');
    const options = within(source)
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((t) => !t?.startsWith('—'));
    expect(options).toEqual(['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia']);

    await userEvent.selectOptions(source, 'Agoda');
    await userEvent.type(screen.getByTestId('payment-amount'), '100000');
    await userEvent.click(screen.getByTestId('payment-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'PAYMENT',
      payment: { source: 'Agoda', method: 'CASH', amount: 100000, receivable: 0, expense: 0 },
    });
  });

  it('keeps an older free-text source on a correction instead of rewriting it', async () => {
    const patched: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [payment({}, { source: 'agoda.com' })], counts: { ...EMPTY_COUNTS, PAYMENT: 1 } },
        }),
        'PATCH /api/reception/reports/p1': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: payment() } };
        },
      }),
    );
    await openPayment();

    await userEvent.click(await screen.findByTestId('payment-edit-p1'));
    const source = await screen.findByTestId('payment-edit-source-p1');
    expect(source).toHaveValue('agoda.com');
    expect(within(source).getByRole('option', { name: 'agoda.com (dữ liệu cũ)' })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('payment-save-p1'));
    await waitFor(() => expect(patched).toHaveLength(1));
    const body = patched[0] as { payment: Record<string, unknown> };
    expect(body.payment.source).toBe('agoda.com');
    // Legacy fields are not part of a correction any more.
    expect(body.payment).not.toHaveProperty('roomNumber');
    expect(body.payment).not.toHaveProperty('note');
  });
});

describe('the summary strip shows the drawer only', () => {
  it('drops Thu CK, Cà thẻ and Công nợ — and the ending cash is still the server’s', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: { cash: cash({ transferCollected: 240000, cardCollected: 500000, receivable: 333000 }) },
        }),
      }),
    );
    await openPayment();

    const strip = await screen.findByTestId('cash-summary-strip');
    for (const label of ['Tiền đầu ca', 'Số giao dịch', 'Thu tiền mặt', 'Chi', 'Tiền cuối ca']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
    for (const gone of ['Thu CK', 'Cà thẻ', 'Công nợ']) {
      expect(within(strip).queryByText(gone)).not.toBeInTheDocument();
    }
    for (const hidden of ['240.000 ₫', '500.000 ₫', '333.000 ₫']) {
      expect(within(strip).queryByText(hidden)).not.toBeInTheDocument();
    }
    // Tiền đầu ca + Thu tiền mặt − Chi, exactly as the server sent it.
    expect(within(strip).getByTestId('ending-cash')).toHaveTextContent('11.870.000 ₫');
  });
});

describe('the "Thêm giao dịch" dialog', () => {
  it('is the wide dialog, laid out as the specified rows', async () => {
    installApiMock(shellRoutes());
    await openPaymentForm();

    const dialog = await screen.findByRole('dialog');
    // 760–900px: max-w-4xl is 896px.
    expect(dialog.className).toMatch(/\bmax-w-4xl\b/);

    // Row 1: Mã EZ | Nguồn | Tên khách.
    const who = within(dialog).getByTestId('payment-row-who');
    const inWho = ['payment-ez', 'payment-source', 'payment-guest'];
    for (const id of inWho) expect(within(who).getByTestId(id)).toBeInTheDocument();
    expect(who.className).toMatch(/\bsm:grid-cols-3\b/);

    // Row 2: Phương thức | Số tiền | Công nợ | Chi tiền.
    const money = within(dialog).getByTestId('payment-row-money');
    const inMoney = ['payment-method', 'payment-amount', 'payment-receivable', 'payment-expense'];
    for (const id of inMoney) expect(within(money).getByTestId(id)).toBeInTheDocument();
    expect(money.className).toMatch(/\bmd:grid-cols-4\b/);

    // No room and no note any more.
    expect(within(dialog).queryByTestId('payment-room')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('payment-note')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Ghi chú')).not.toBeInTheDocument();

    // Footer: Hủy, then Thêm.
    const cancel = within(dialog).getByTestId('payment-cancel');
    const add = within(dialog).getByTestId('payment-add');
    expect(cancel).toHaveTextContent('Hủy');
    expect(add).toHaveTextContent('Thêm');
    expect(cancel.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('carries no helper sentences under the money fields', async () => {
    installApiMock(shellRoutes());
    await openPaymentForm();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/Không cộng vào tiền mặt/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Luôn là tiền mặt chi ra/)).not.toBeInTheDocument();
  });

  it('Hủy closes it without sending anything', async () => {
    const fetchMock = installApiMock(shellRoutes());
    await openPaymentForm();

    await userEvent.type(await screen.findByTestId('payment-amount'), '500000');
    await userEvent.click(screen.getByTestId('payment-cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('opens from the empty ledger too', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    await openPayment();

    const empty = await screen.findByTestId('payment-empty');
    await userEvent.click(within(empty).getByTestId('payment-empty-add'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('payment-form')).toBeInTheDocument();
  });
});
