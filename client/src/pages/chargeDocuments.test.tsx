/**
 * Chứng từ, from the browser's side.
 *
 * The navigation and route assertions are about ACCESS: reception must not see
 * the menu and must not reach the page by typing the URL. They are not the
 * security boundary — the API is, and the server suite proves that — but a
 * receptionist who can open the screen at all is a bug worth failing on.
 *
 * The rest is about the card number: masked in the list, masked in the report,
 * and full only after the operator explicitly asks and the server answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  BOOKING_DEPARTMENT_USER,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = {
  id: 1,
  code: 'TRUONG_DINH_05',
  hotelName: 'Saigon Hotel',
  address: '05 Trương Định',
  branchNumber: 1,
};

const PAN = '4111111111111111';

function doc(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    branch: BRANCH,
    bookingId: null,
    guestName: 'NGUYEN VAN A',
    bookingCode: 'BK-EXT-001',
    amount: 1_500_000,
    cardLast4: '1111',
    cardMasked: '•••• 1111',
    cardExpiry: '12/28',
    checkIn: '2026-08-01',
    checkOut: '2026-08-03',
    reason: 'Khách không đến nhận phòng (no-show).',
    status: 'CHUA_XU_LY',
    chargedAt: null,
    createdBy: { id: 1, fullName: 'Quản trị viên' },
    updatedBy: null,
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-01T02:00:00.000Z',
    attachments: [],
    ...over,
  };
}

function mountApi(user: typeof ADMIN_USER, extra: Record<string, () => { status: number; body?: unknown }> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/charge-documents': () => ({ status: 200, body: { documents: [doc()] } }),
    ...extra,
  });
}

/* ================================================================== */
/* Navigation and access                                               */
/* ================================================================== */

describe('who can see Chứng từ', () => {
  it('shows the menu item to an Admin', async () => {
    mountApi(ADMIN_USER);
    renderApp('/app/dashboard');
    expect(await screen.findByRole('link', { name: /Chứng từ/ })).toBeInTheDocument();
  });

  it('shows it to Bộ phận đặt phòng', async () => {
    mountApi(BOOKING_DEPARTMENT_USER);
    renderApp('/app/charge-documents');
    expect(await screen.findByRole('link', { name: /Chứng từ/ })).toBeInTheDocument();
  });

  it('does NOT show it to a receptionist', async () => {
    mountApi(RECEPTIONIST_USER);
    renderApp('/app/new');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: /Chứng từ/ })).not.toBeInTheDocument();
  });

  it('refuses a receptionist who types the URL directly', async () => {
    mountApi(RECEPTIONIST_USER);
    renderApp('/app/charge-documents');
    // The page itself must not render; the API would refuse too.
    await waitFor(() => expect(screen.queryByTestId('charge-table')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Tạo chứng từ/ })).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* The list                                                            */
/* ================================================================== */

describe('the list', () => {
  it('shows the card masked, never a full number', async () => {
    mountApi(ADMIN_USER);
    renderApp('/app/charge-documents');

    const table = await screen.findByTestId('charge-table');
    // The shell renders before the rows arrive, so wait for the row itself.
    expect(await within(table).findByText('•••• 1111')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PAN);
  });

  it('sends every filter to the server rather than filtering locally', async () => {
    const fetchMock = mountApi(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/charge-documents');
    await screen.findByTestId('charge-table');

    await user.selectOptions(screen.getByLabelText('Trạng thái'), 'DA_BI_CHARGE');
    await user.type(screen.getByLabelText('Tên khách'), 'NGUYEN');
    await user.click(screen.getByRole('button', { name: /Tìm kiếm/ }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      const filtered = urls.find((u) => u.includes('status=DA_BI_CHARGE'));
      expect(filtered).toBeDefined();
      expect(filtered).toContain('guestName=NGUYEN');
    });
  });

  it('requires a reason before it will submit a new document', async () => {
    mountApi(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/charge-documents');
    await screen.findByTestId('charge-table');

    await user.click(screen.getByRole('button', { name: /Tạo chứng từ/ }));
    await user.selectOptions(screen.getByLabelText('Chi nhánh của chứng từ'), '1');
    await user.type(screen.getByLabelText('Tên khách của chứng từ'), 'A');
    await user.click(screen.getByRole('button', { name: 'Lưu chứng từ' }));

    expect(await screen.findByText('Vui lòng nhập lý do charge.')).toBeInTheDocument();
  });

  it('requires a branch', async () => {
    mountApi(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/charge-documents');
    await screen.findByTestId('charge-table');

    await user.click(screen.getByRole('button', { name: /Tạo chứng từ/ }));
    await user.click(screen.getByRole('button', { name: 'Lưu chứng từ' }));
    expect(await screen.findByText('Vui lòng chọn chi nhánh.')).toBeInTheDocument();
  });
});

/* ================================================================== */
/* The detail and the reveal                                           */
/* ================================================================== */

describe('the detail screen', () => {
  const detailApi = (over: Record<string, unknown> = {}) => ({
    'GET /api/charge-documents/c1': () => ({ status: 200, body: { document: doc(over) } }),
    'GET /api/charge-documents/c1/audit': () => ({ status: 200, body: { events: [] } }),
  });

  it('masks the card until it is revealed', async () => {
    mountApi(ADMIN_USER, detailApi());
    renderApp('/app/charge-documents/c1');

    expect(await screen.findByTestId('card-number')).toHaveTextContent('•••• 1111');
    expect(document.body.textContent).not.toContain(PAN);
  });

  it('shows the full number only after the server returns it', async () => {
    mountApi(ADMIN_USER, {
      ...detailApi(),
      'POST /api/charge-documents/c1/card': () => ({ status: 200, body: { cardNumber: PAN } }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');
    await screen.findByTestId('card-number');

    await user.click(screen.getByRole('button', { name: /Hiện số thẻ/ }));
    await waitFor(() => expect(screen.getByTestId('card-number')).toHaveTextContent(PAN));
  });

  it('never writes a revealed number into browser storage', async () => {
    // A revealed PAN lives in component state and nowhere else.
    mountApi(ADMIN_USER, {
      ...detailApi(),
      'POST /api/charge-documents/c1/card': () => ({ status: 200, body: { cardNumber: PAN } }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');
    await screen.findByTestId('card-number');
    await user.click(screen.getByRole('button', { name: /Hiện số thẻ/ }));
    await waitFor(() => expect(screen.getByTestId('card-number')).toHaveTextContent(PAN));

    expect(JSON.stringify(window.localStorage)).not.toContain(PAN);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(PAN);
    expect(window.location.href).not.toContain(PAN);
  });

  it('hides it again on request', async () => {
    mountApi(ADMIN_USER, {
      ...detailApi(),
      'POST /api/charge-documents/c1/card': () => ({ status: 200, body: { cardNumber: PAN } }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');
    await screen.findByTestId('card-number');

    await user.click(screen.getByRole('button', { name: /Hiện số thẻ/ }));
    await waitFor(() => expect(screen.getByTestId('card-number')).toHaveTextContent(PAN));
    await user.click(screen.getByRole('button', { name: /Ẩn số thẻ/ }));

    expect(screen.getByTestId('card-number')).toHaveTextContent('•••• 1111');
    expect(document.body.textContent).not.toContain(PAN);
  });

  it('shows the charge reason and the three upload slots', async () => {
    mountApi(ADMIN_USER, detailApi());
    renderApp('/app/charge-documents/c1');

    expect(await screen.findByText('Khách không đến nhận phòng (no-show).')).toBeInTheDocument();
    expect(screen.getByTestId('attachments-GUEST_IMAGE')).toBeInTheDocument();
    expect(screen.getByTestId('attachments-CHARGE_DOCUMENT')).toBeInTheDocument();
    expect(screen.getByTestId('attachments-CARD_IMAGE')).toBeInTheDocument();
  });

  it('accepts several files at once in a slot', async () => {
    mountApi(ADMIN_USER, detailApi());
    renderApp('/app/charge-documents/c1');
    await screen.findByTestId('attachments-GUEST_IMAGE');

    const input = within(screen.getByTestId('attachments-GUEST_IMAGE')).getByLabelText(
      'Tải lên Ảnh khách',
    );
    expect(input).toHaveAttribute('multiple');
  });

  it('says the charge date is only set once a charge succeeds', async () => {
    mountApi(ADMIN_USER, detailApi());
    renderApp('/app/charge-documents/c1');
    expect(await screen.findByText(/Ngày charge chỉ được ghi khi trạng thái/)).toBeInTheDocument();
  });
});

/* ================================================================== */
/* The monthly report                                                  */
/* ================================================================== */

describe('the monthly report', () => {
  /**
   * The page opens on the current month, so the mock has to answer that exact
   * URL — the fetch mock matches the query string too. Derived rather than
   * hard-coded so the suite does not start failing when the month rolls over.
   */
  const currentMonth = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const REPORT_KEY = `GET /api/charge-documents/report?month=${currentMonth}`;

  const report = {
    month: currentMonth,
    from: `${currentMonth}-01`,
    to: `${currentMonth}-28`,
    totals: {
      documentCount: 35,
      chargedCount: 27,
      chargedAmount: 54_250_000,
      failedCount: 5,
      failedAmount: 8_500_000,
      pendingCount: 3,
      pendingAmount: 1_200_000,
    },
    rows: [doc({ status: 'DA_BI_CHARGE', chargedAt: '2026-08-10T03:00:00.000Z' })],
  };

  it('shows the successful total as the headline, and it excludes the rest', async () => {
    mountApi(ADMIN_USER, {
      [REPORT_KEY]: () => ({ status: 200, body: { report } }),
    });
    renderApp('/app/charge-documents/report');

    const headline = await screen.findByTestId('charge-headline');
    expect(headline).toHaveTextContent('54.250.000');
    expect(headline).toHaveTextContent('27 khách');
    // The failed and pending amounts must not have been folded in.
    expect(headline).not.toHaveTextContent('62.750.000');
    expect(headline).toHaveTextContent(/Không bao gồm charge thất bại hoặc chưa xử lý/);
  });

  it('still reports the failed and pending figures separately', async () => {
    mountApi(ADMIN_USER, {
      [REPORT_KEY]: () => ({ status: 200, body: { report } }),
    });
    renderApp('/app/charge-documents/report');

    expect(await screen.findByTestId('stat-failed')).toHaveTextContent('8.500.000');
    expect(screen.getByTestId('stat-pending')).toHaveTextContent('1.200.000');
    expect(screen.getByTestId('stat-documents')).toHaveTextContent('35');
  });

  it('masks the card in the report table', async () => {
    mountApi(ADMIN_USER, {
      [REPORT_KEY]: () => ({ status: 200, body: { report } }),
    });
    renderApp('/app/charge-documents/report');

    const table = await screen.findByTestId('charge-report-table');
    expect(within(table).getByText('•••• 1111')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PAN);
  });

  it('offers an XLSX export for the selected month', async () => {
    mountApi(ADMIN_USER, {
      [REPORT_KEY]: () => ({ status: 200, body: { report } }),
    });
    renderApp('/app/charge-documents/report');

    const link = await screen.findByTestId('charge-export-link');
    expect(link).toHaveAttribute('href', expect.stringContaining('/report/export') as unknown as string);
  });
});
