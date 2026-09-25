/**
 * "BÁO CÁO VẤN ĐỀ" — the reception journal, in the browser.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Exactly five categories, in the SPECIFIED order and EXACT wording:
 *      Theo dõi thanh toán · Vấn đề khách yêu cầu thực hiện (Request) · Sự cố
 *      vật chất đang xử lý · Vấn đề về chất lượng và dịch vụ · Dịch vụ phòng,
 *      KPI — both in the "Tổng" menu and as the overview's five sections — and
 *      "Tổng" stays on every screen, beside the category's one action.
 *   2. The branch, the shift and the employee are never asked for — no form on
 *      this page has a field that could change any of them — and the overview
 *      no longer repeats them in a banner.
 *   3. Every category with an entry form shows a PRIMARY RECORD TABLE directly
 *      under it, and a submitted record appears there immediately — not only in
 *      the shift journal.
 *   4. Request and "Vấn đề về chất lượng và dịch vụ" ask for three fields each,
 *      start as "Đã tiếp nhận", and complete with an OPTIONAL handling text.
 *   5. "Dịch vụ phòng, KPI" is one form that asks only what the chosen service
 *      needs, five grouped tables on its screen, and two figures on the
 *      overview — with no invented review score.
 *   6. "Sự cố vật chất đang xử lý" is a MONITOR: no "chọn sự cố" dropdown, no
 *      entry form — it shows the branch's live incidents and their status.
 *   7. Editing and voiding live in the category table, are audited and never
 *      delete a record.
 *   8. "Nhật ký ca hiện tại" still exists, collapsed by default — secondary,
 *      not the primary presentation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import { formatDateTime } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion', address: '05 Trương Định', branchNumber: 1 };

function session(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

/** The exact five labels, in the exact order the server now sends them. */
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
  roomServiceTypes: [
    { code: 'ROOM_SALE', label: 'Bán phòng' },
    { code: 'UPGRADE', label: 'Upgrade' },
    { code: 'SMOKING', label: 'Hút thuốc' },
    { code: 'LAUNDRY', label: 'Giặt ủi' },
    { code: 'OTHER', label: 'Dịch vụ khác' },
  ],
  paymentSources: ['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia'],
};

const EMPTY_COUNTS = {
  PAYMENT: 0,
  GUEST_REQUEST: 0,
  FACILITY_ISSUE: 0,
  CUSTOMER_COMPLAINT: 0,
  ROOM_SERVICE: 0,
};

const EMPTY_CASH = {
  openingCash: null,
  cashCollected: 0,
  transferCollected: 0,
  cardCollected: 0,
  receivable: 0,
  cashExpense: 0,
  endingCash: null,
  paymentCount: 0,
  voidedCount: 0,
};

/** A service-quality report as the server now sends it: "Đã tiếp nhận" until completed. */
function complaint(over: Record<string, unknown> = {}) {
  return {
    guestName: 'Trần Thị B',
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
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    category: 'CUSTOMER_COMPLAINT',
    categoryLabel: 'Vấn đề về chất lượng và dịch vụ',
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
    summary: 'Trần Thị B · Phòng ồn suốt đêm',
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    payment: null,
    guestRequest: null,
    facility: null,
    complaint: complaint(),
    roomService: null,
    audits: [],
    ...over,
  };
}

function shellRoutes(
  user: unknown,
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
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
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session() } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reception/reports/options': () => ({ status: 200, body: OPTIONS }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({ status: 200, body: { reports: [], counts: EMPTY_COUNTS } }),
    'GET /api/reception/shifts/cash': () => ({ status: 200, body: { cash: EMPTY_CASH } }),
    // The exact URL `issuesApi.list` builds: `query()` keeps insertion order,
    // and `outstanding` is appended after the rest.
    'GET /api/issues?pageSize=100&outstanding=true': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
    }),
    ...extra,
  };
}

const FIVE_TITLES = [
  'Theo dõi thanh toán',
  'Vấn đề khách yêu cầu thực hiện (Request)',
  'Sự cố vật chất đang xử lý',
  'Vấn đề về chất lượng và dịch vụ',
  'Dịch vụ phòng, KPI',
];

/** "Tổng" — the menu of the five categories. */
async function openTotalMenu() {
  await userEvent.click(await screen.findByTestId('report-total'));
  return screen.findByTestId('category-menu');
}

/** Overview → "Tổng" → one category. */
async function openCategory(code: string) {
  const menu = await openTotalMenu();
  await userEvent.click(within(menu).getByTestId(`category-${code}`));
}

/** The menu's five LABELS, in on-screen order. */
async function menuLabels() {
  const menu = await openTotalMenu();
  return within(menu)
    .getAllByRole('menuitemradio')
    .map((b) => b.textContent);
}

/** A table's visible column headers, left to right, without the expander's empty one. */
function headersOf(table: HTMLElement) {
  return within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent ?? '')
    .filter((h) => h !== '');
}

function guestRequest(over: Record<string, unknown> = {}) {
  return {
    guestName: 'Khách ký gửi',
    ezCode: 'EZ305',
    content: 'Gửi balo đen, 14h lấy',
    note: 'Gửi balo đen, 14h lấy',
    itemType: null,
    roomNumber: null,
    completed: false,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    completedShiftType: null,
    completedShiftName: null,
    resolution: null,
    ...over,
  };
}

/** A room-service detail as the server now sends it — a "Bán phòng" by default. */
function roomService(over: Record<string, unknown> = {}) {
  return {
    serviceType: 'ROOM_SALE',
    serviceTypeLabel: 'Bán phòng',
    guestName: 'Khách Dịch Vụ',
    ezCode: 'EZ900',
    roomClass: 'Deluxe',
    fromRoomClass: null,
    toRoomClass: null,
    nights: 2,
    price: 800000,
    note: null,
    phone: null,
    roomNumber: null,
    serviceName: null,
    ...over,
  };
}

function requestRow(over: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  return report({
    id: 'g1',
    category: 'GUEST_REQUEST',
    categoryLabel: 'Vấn đề khách yêu cầu',
    complaint: null,
    summary: 'Gửi balo đen, 14h lấy · Khách ký gửi · đã tiếp nhận',
    guestRequest: guestRequest(request),
    ...over,
  });
}

describe('the overview', () => {
  it('opens on the overview: the new title, "Tổng", and no banner, form or dialog', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Theo dõi tình hình các vấn đề, thanh toán trong ca làm việc',
      }),
    ).toBeInTheDocument();
    expect(within(overview).getByText('TỔNG QUAN')).toBeInTheDocument();
    expect(screen.getByTestId('report-total')).toHaveTextContent('Tổng');
    expect(screen.getByRole('button', { name: 'Làm mới' })).toBeInTheDocument();

    // Gone: the old description, the branch/shift/employee banner and "+ Báo cáo vấn đề".
    expect(screen.queryByText(/Mỗi bản ghi tự động gắn chi nhánh/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('report-start')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Báo cáo vấn đề/ })).not.toBeInTheDocument();

    expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the five category sections, in the specified order, under their own names', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const sections = [
      'payment-overview',
      'guest-request-table',
      'facility-board',
      'service-quality-table',
      'room-service-overview',
    ].map((id) => within(overview).getByTestId(id));
    for (let i = 1; i < sections.length; i += 1) {
      expect(sections[i - 1]!.compareDocumentPosition(sections[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    sections.forEach((section, i) => {
      expect(within(section).getAllByRole('heading')[0]).toHaveTextContent(FIVE_TITLES[i]!);
    });
  });

  it('gives the payment section exactly its four drawer columns, from the server', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/cash': () => ({
          status: 200,
          body: {
            cash: {
              ...EMPTY_CASH,
              openingCash: 2000000,
              cashCollected: 5000000,
              transferCollected: 900000,
              cashExpense: 300000,
              endingCash: 6700000,
            },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    const payment = await screen.findByTestId('payment-overview');
    expect(await within(payment).findByText('6.700.000 ₫')).toBeInTheDocument();
    expect(headersOf(payment)).toEqual(['Tiền đầu ca', 'Tiền mặt thu trong ca', 'Chi', 'Tiền mặt cuối ca']);
    expect(within(payment).getByText('2.000.000 ₫')).toBeInTheDocument();
    expect(within(payment).getByText('5.000.000 ₫')).toBeInTheDocument();
    expect(within(payment).getByText('300.000 ₫')).toBeInTheDocument();
    // Transfers never reach the drawer, so they are not in this table at all.
    expect(within(payment).queryByText('900.000 ₫')).not.toBeInTheDocument();
  });

  it('says plainly when the opening cash has not been counted, instead of a zero', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const payment = await screen.findByTestId('payment-overview');
    expect(await within(payment).findByText('Chưa nhập')).toBeInTheDocument();
    expect(within(payment).getByText('Chưa xác định')).toBeInTheDocument();
  });

  it('lists this shift’s real records, with each summary table’s exact columns', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [requestRow(), report()],
            counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const requests = within(overview).getByTestId('guest-request-table');
    expect(await within(requests).findByText('Khách ký gửi')).toBeInTheDocument();
    expect(headersOf(requests)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Nội dung',
      'Thời gian tiếp nhận',
      'Thời gian hoàn thành',
      'Cách xử lý (nếu có)',
    ]);
    expect(within(requests).getByText('EZ305')).toBeInTheDocument();
    expect(within(requests).getByText('Gửi balo đen, 14h lấy')).toBeInTheDocument();

    const quality = within(overview).getByTestId('service-quality-table');
    expect(within(quality).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
    expect(headersOf(quality)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Mô tả',
      'Trạng thái',
      'Hướng xử lý (nếu có)',
      'Thời gian',
    ]);
    expect(within(quality).getByText('Đã tiếp nhận')).toBeInTheDocument();
    // The overview reads; it does not edit or void.
    expect(within(quality).queryByTestId('edit-r1')).not.toBeInTheDocument();
    expect(within(requests).queryByTestId('edit-g1')).not.toBeInTheDocument();
  });

  it('reduces "Dịch vụ phòng, KPI" to its two figures, from the real rows', async () => {
    const sale = report({
      id: 'rs1',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({ price: 800000 }),
    });
    const laundry = report({
      id: 'rs2',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({ serviceType: 'LAUNDRY', serviceTypeLabel: 'Giặt ủi', roomClass: null, nights: null, price: 150000 }),
    });
    const voided = report({
      id: 'rs3',
      category: 'ROOM_SERVICE',
      complaint: null,
      voided: true,
      voidReason: 'nhầm',
      roomService: roomService({ price: 999000 }),
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [sale, laundry, voided], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 3 } },
        }),
      }),
    );
    renderApp('/app/reports');

    const section = await screen.findByTestId('room-service-overview');
    // Real rows, voided excluded: 800.000 + 150.000.
    expect(await within(section).findByText('950.000 ₫')).toBeInTheDocument();
    expect(within(section).getByText('Tổng doanh thu')).toBeInTheDocument();
    expect(within(section).getByText('Tổng đánh giá (review)')).toBeInTheDocument();
    // No review source exists in KAS, and the line says so instead of inventing one.
    expect(within(section).getByTestId('room-service-review')).toHaveTextContent('Chưa có dữ liệu');
    // Nothing else: no subtype buttons, no tables, no per-subtype totals.
    expect(within(section).queryAllByRole('button')).toHaveLength(0);
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(within(section).queryByText('Tổng hợp dịch vụ trong ca')).not.toBeInTheDocument();
    expect(within(section).queryByText('Bán phòng')).not.toBeInTheDocument();
  });

  it('lays the header out as title / "Làm mới" / "Tổng ▾" — with no add action on the overview', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await screen.findByTestId('report-overview');
    const refreshRow = screen.getByTestId('report-header-refresh-row');
    const navRow = screen.getByTestId('report-header-nav-row');
    expect(within(refreshRow).getByRole('button', { name: 'Làm mới' })).toBeInTheDocument();
    expect(within(navRow).getByTestId('report-total')).toHaveTextContent('Tổng');
    // Two separate rows, "Làm mới" above "Tổng".
    expect(refreshRow.compareDocumentPosition(navRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(navRow).queryByRole('button', { name: 'Làm mới' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-add')).not.toBeInTheDocument();
  });

  it('keeps an empty section to one compact line', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    // Awaited as a whole: the journal loads after the shift does, and the same
    // node passes through "Đang tải…" on the way.
    await waitFor(() => {
      const empty = within(overview).getByTestId('guest-request-table-empty');
      expect(empty).toHaveTextContent('Chưa có yêu cầu nào');
      expect(empty).not.toHaveTextContent('bấm Thêm');
    });
  });

  /** The old "Sự cố khách sạn" / "Báo cáo sự cố" address lands on its category. */
  it('opens a deep-linked category directly', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports?category=FACILITY_ISSUE');

    expect(await screen.findByTestId('category-view')).toBeInTheDocument();
    expect(screen.getByTestId('facility-board')).toBeInTheDocument();
    expect(screen.queryByTestId('report-overview')).not.toBeInTheDocument();
  });

  it('ignores a deep link to a category that does not exist', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports?category=KPI');

    expect(await screen.findByTestId('report-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
  });
});

describe('the "Tổng" menu', () => {
  it('offers exactly five, in the specified order and exact wording', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    expect(await menuLabels()).toEqual(FIVE_TITLES);
  });

  it('never shows a separate KPI category', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    // "KPI" appears ONLY as part of the room-service label, never alone.
    const labels = await menuLabels();
    expect(labels).toHaveLength(5);
    expect(labels.filter((l) => l === 'KPI')).toHaveLength(0);
    expect(labels).toContain('Dịch vụ phòng, KPI');
  });

  it('is a menu button, not a dialog, and choosing an item opens that category', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const button = await screen.findByTestId('report-total');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    const menu = await openTotalMenu();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(within(menu).getByTestId('category-GUEST_REQUEST'));
    await waitFor(() => expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument());
    const view = await screen.findByTestId('category-view');
    expect(within(view).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Vấn đề khách yêu cầu thực hiện (Request)',
    );
  });

  it('moves with the arrow keys and closes on Escape, returning focus to "Tổng"', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const menu = await openTotalMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    await waitFor(() => expect(items[0]).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(items[4]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument());
    expect(screen.getByTestId('report-total')).toHaveFocus();
  });

  it('shows no form while choosing', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const menu = await openTotalMenu();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(5);
    for (const form of [
      'payment-form',
      'guest-request-form',
      'service-quality-form',
      'room-service-form',
    ]) {
      expect(screen.queryByTestId(form)).not.toBeInTheDocument();
    }
  });

  it('goes back to the overview through "Tổng" — there is no "Tất cả danh mục" link', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    expect(await screen.findByTestId('category-view')).toBeInTheDocument();
    expect(screen.queryByText('Tất cả danh mục')).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-back')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('report-total-overview'));
    expect(await screen.findByTestId('report-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
  });

  it('stays on every category, and switches straight to another without the overview', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const order = ['PAYMENT', 'GUEST_REQUEST', 'FACILITY_ISSUE', 'CUSTOMER_COMPLAINT', 'ROOM_SERVICE'];
    for (const [i, code] of order.entries()) {
      // From whatever category is open — never back through the overview.
      await openCategory(code);
      const view = await screen.findByTestId('category-view');
      expect(within(view).getByRole('heading', { level: 2 })).toHaveTextContent(FIVE_TITLES[i]!);
      expect(screen.queryByTestId('report-overview')).not.toBeInTheDocument();
      expect(screen.getByTestId('report-total')).toBeInTheDocument();

      // The open category is marked in the menu, and only that one.
      const menu = await openTotalMenu();
      const checked = within(menu)
        .getAllByRole('menuitemradio')
        .filter((item) => item.getAttribute('aria-checked') === 'true');
      expect(checked.map((item) => item.textContent)).toEqual([FIVE_TITLES[i]]);
      await userEvent.keyboard('{Escape}');
    }
  });

  it.each([
    ['PAYMENT', 'Thêm giao dịch'],
    ['GUEST_REQUEST', 'Thêm vấn đề'],
    ['FACILITY_ISSUE', 'Báo cáo sự cố'],
    ['CUSTOMER_COMPLAINT', 'Báo cáo vấn đề'],
    ['ROOM_SERVICE', 'Thêm dịch vụ'],
  ])('%s puts "Tổng" and "+ %s" on the same row, below "Làm mới"', async (code, label) => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory(code);
    await screen.findByTestId('category-view');
    const navRow = screen.getByTestId('report-header-nav-row');
    // "Tổng" first (left), the context action last (right).
    const controls = within(navRow).getAllByRole('button');
    expect(controls[0]).toHaveTextContent('Tổng');
    expect(controls[controls.length - 1]).toHaveTextContent(label);
    expect(within(navRow).getByTestId('category-add')).toHaveTextContent(label);
    expect(within(screen.getByTestId('report-header-refresh-row')).getByRole('button', { name: 'Làm mới' })).toBeInTheDocument();
  });
});

/**
 * LIST FIRST, FORM SECOND — the same shape in all five.
 *
 * Each category shows what is already recorded and ONE "+ …" action; the form
 * exists only inside the dialog that action opens.
 */
describe('list first, then "+ Thêm"', () => {
  it.each([
    ['PAYMENT', 'Thêm giao dịch', 'payment-form'],
    ['GUEST_REQUEST', 'Thêm vấn đề', 'guest-request-form'],
    ['CUSTOMER_COMPLAINT', 'Báo cáo vấn đề', 'service-quality-form'],
    ['ROOM_SERVICE', 'Thêm dịch vụ', 'room-service-form'],
  ])('%s shows its records first and opens its form only on demand', async (code, addLabel, form) => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory(code);
    await screen.findByTestId('category-view');
    // No form on the page…
    expect(screen.queryByTestId(form)).not.toBeInTheDocument();
    // …one primary action, named for what it adds…
    const add = screen.getByTestId('category-add');
    expect(add).toHaveTextContent(addLabel);
    // …and the form appears only inside the dialog it opens.
    await userEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId(form)).toBeInTheDocument();
  });

  it('closes the dialog on save and shows the new record in the table', async () => {
    let created = false;
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': () => {
          created = true;
          return { status: 201, body: { report: report() } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: created
            ? { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    await userEvent.type(await screen.findByTestId('service-quality-guest'), 'Trần Thị B');
    await userEvent.type(screen.getByTestId('service-quality-ez'), 'EZ202');
    await userEvent.type(screen.getByTestId('service-quality-description'), 'Phòng ồn suốt đêm');
    await userEvent.click(screen.getByTestId('service-quality-form-add'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const table = await screen.findByTestId('service-quality-table');
    expect(within(table).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('is reachable from the reception menu as "Báo cáo vấn đề"', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await screen.findByTestId('report-overview');
    expect(screen.getByRole('link', { name: 'Báo cáo vấn đề' })).toHaveAttribute(
      'href',
      '/app/reports',
    );
  });
});

describe('the shift owns the record', () => {
  it('neither repeats the branch, the shift and the employee nor asks for any of them', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    expect(screen.queryByTestId('journal-context')).not.toBeInTheDocument();
    expect(within(overview).queryByText('05 Trương Định')).not.toBeInTheDocument();

    // There is no field anywhere on this page that could change any of them.
    expect(screen.queryByLabelText(/Nhân viên/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Chi nhánh/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Ca/)).not.toBeInTheDocument();
  });
});

describe('vấn đề về chất lượng và dịch vụ', () => {
  it('asks for Tên khách, Mã EZ and Mô tả — and nothing else', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    const form = await screen.findByTestId('service-quality-form');

    expect(within(form).getByLabelText('Tên khách')).toBeInTheDocument();
    expect(within(form).getByLabelText('Mã EZ')).toBeInTheDocument();
    expect(within(form).getByLabelText('Mô tả')).toBeInTheDocument();
    // No room, no staff, no priority or status — deliberately absent.
    expect(within(form).queryByTestId('service-quality-location')).not.toBeInTheDocument();
    for (const absent of [/số phòng/i, /nhân viên/i, /ưu tiên/i, /mức độ/i, /trạng thái/i]) {
      expect(within(form).queryByText(absent)).not.toBeInTheDocument();
    }
    expect(within(form).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('sends exactly the three fields, and the record appears as "Đã tiếp nhận" at once', async () => {
    let created = false;
    const posted: unknown[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          created = true;
          return { status: 201, body: { report: report() } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: created
            ? { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    await userEvent.type(screen.getByTestId('service-quality-guest'), 'Trần Thị B');
    await userEvent.type(screen.getByTestId('service-quality-ez'), 'EZ202');
    await userEvent.type(screen.getByTestId('service-quality-description'), 'Phòng ồn suốt đêm');
    await userEvent.click(screen.getByTestId('service-quality-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Trần Thị B', ezCode: 'EZ202', description: 'Phòng ồn suốt đêm' },
    });

    const table = await screen.findByTestId('service-quality-table');
    expect(within(table).getByText('Trần Thị B')).toBeInTheDocument();
    expect(within(table).getByText('EZ202')).toBeInTheDocument();
    expect(within(table).getByText('Đã tiếp nhận')).toBeInTheDocument();
  });

  it('will not submit without a name and a description; Mã EZ is optional', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    expect(screen.getByTestId('service-quality-form-add')).toBeDisabled();

    await userEvent.type(screen.getByTestId('service-quality-guest'), 'A');
    expect(screen.getByTestId('service-quality-form-add')).toBeDisabled();

    await userEvent.type(screen.getByTestId('service-quality-description'), 'x');
    expect(screen.getByTestId('service-quality-form-add')).toBeEnabled();
  });

  it('lays the table out in exactly the seven columns, with no action column', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    const table = await screen.findByTestId('service-quality-table');
    await within(table).findByText('Trần Thị B');
    expect(headersOf(table)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Mô tả',
      'Trạng thái',
      'Hướng xử lý (nếu có)',
      'Thời gian',
    ]);
    expect(within(table).queryByText('Thao tác')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('edit-r1')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('void-r1')).not.toBeInTheDocument();
  });

  it.each([
    ['with no handling text', '', undefined],
    ['with a handling text', 'Đổi phòng cho khách', 'Đổi phòng cho khách'],
  ])('completes %s, from the status cell, and then reads "Đã hoàn thành"', async (_what, typed, sent) => {
    let completed = false;
    const bodies: unknown[] = [];
    const done = report({
      complaint: complaint({
        completed: true,
        completedByName: 'Nguyễn Văn A',
        completedShiftName: 'Ca A',
        completedAt: '2026-09-19T03:00:00.000Z',
        resolution: sent ?? null,
      }),
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports/r1/complete': (init) => {
          bodies.push(JSON.parse(String(init.body)));
          completed = true;
          return { status: 200, body: { report: done } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [completed ? done : report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    const table = await screen.findByTestId('service-quality-table');
    await userEvent.click(await within(table).findByTestId('complete-r1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Hướng xử lý (nếu có)')).toBeInTheDocument();
    // Optional: the button is enabled before anything is typed.
    expect(within(dialog).getByTestId('complete-confirm')).toBeEnabled();
    if (typed) await userEvent.type(within(dialog).getByTestId('complete-resolution'), typed);
    await userEvent.click(within(dialog).getByTestId('complete-confirm'));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // Only the handling — never a time, a person or a shift.
    expect(bodies[0]).toEqual(sent === undefined ? {} : { resolution: sent });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(table).findByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(table).queryByTestId('complete-r1')).not.toBeInTheDocument();
    if (sent) expect(within(table).getByText(sent)).toBeInTheDocument();
  });

  it('shows an empty state before anything is recorded', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('CUSTOMER_COMPLAINT');
    expect(await screen.findByTestId('service-quality-table-empty')).toBeInTheDocument();
  });
});

describe('dịch vụ phòng, KPI', () => {
  /** Category → "+ Thêm dịch vụ" → the unified form. */
  async function openAddService() {
    await openCategory('ROOM_SERVICE');
    await userEvent.click(await screen.findByTestId('category-add'));
    return screen.findByTestId('room-service-form');
  }

  it('offers the five services in one "Chọn dịch vụ" select — not five buttons', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    await screen.findByTestId('category-view');
    expect(screen.queryByTestId('room-service-types')).not.toBeInTheDocument();
    for (const t of ['ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER']) {
      expect(screen.queryByTestId(`room-service-type-${t}`)).not.toBeInTheDocument();
    }

    await userEvent.click(screen.getByTestId('category-add'));
    const select = await screen.findByLabelText('Chọn dịch vụ');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((t) => !t?.startsWith('—'));
    expect(options).toEqual(['Bán phòng', 'Upgrade', 'Hút thuốc', 'Giặt ủi', 'Dịch vụ khác']);
  });

  it('shows exactly the fields each service asks for', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    const form = await openAddService();
    const select = within(form).getByTestId('room-service-type');
    const visible = () =>
      ['room-service-guest', 'room-service-ez', 'room-service-class', 'room-service-from', 'room-service-to', 'room-service-nights', 'room-service-price', 'room-service-note']
        .filter((id) => within(form).queryByTestId(id) !== null);

    // Nothing to fill in until a service is chosen.
    expect(visible()).toEqual([]);

    await userEvent.selectOptions(select, 'ROOM_SALE');
    expect(visible()).toEqual([
      'room-service-guest',
      'room-service-ez',
      'room-service-class',
      'room-service-nights',
      'room-service-price',
      'room-service-note',
    ]);

    await userEvent.selectOptions(select, 'UPGRADE');
    expect(visible()).toEqual([
      'room-service-guest',
      'room-service-ez',
      'room-service-from',
      'room-service-to',
      'room-service-nights',
      'room-service-price',
      'room-service-note',
    ]);

    for (const simple of ['SMOKING', 'LAUNDRY', 'OTHER']) {
      await userEvent.selectOptions(select, simple);
      expect(visible(), simple).toEqual([
        'room-service-guest',
        'room-service-ez',
        'room-service-price',
        'room-service-note',
      ]);
    }
    // The legacy fields are gone from every service.
    for (const gone of ['room-service-phone', 'room-service-room', 'room-service-name']) {
      expect(within(form).queryByTestId(gone)).not.toBeInTheDocument();
    }
  });

  it('requires the chosen service’s own fields before it can be saved', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    const form = await openAddService();
    const add = within(form).getByTestId('room-service-form-add');
    expect(add).toBeDisabled();

    await userEvent.selectOptions(within(form).getByTestId('room-service-type'), 'ROOM_SALE');
    await userEvent.type(within(form).getByTestId('room-service-guest'), 'K');
    await userEvent.type(within(form).getByTestId('room-service-price'), '500000');
    expect(add).toBeDisabled();
    await userEvent.type(within(form).getByTestId('room-service-class'), 'Deluxe');
    expect(add).toBeDisabled();
    await userEvent.type(within(form).getByTestId('room-service-nights'), '2');
    expect(add).toBeEnabled();
  });

  it('sends only the chosen service’s fields — a hidden value is never submitted', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: report({ category: 'ROOM_SERVICE', complaint: null, roomService: roomService() }) } };
        },
      }),
    );
    renderApp('/app/reports');
    const form = await openAddService();
    const select = within(form).getByTestId('room-service-type');

    // Fill a sale's fields, then change to "Giặt ủi" and save that instead.
    await userEvent.selectOptions(select, 'ROOM_SALE');
    await userEvent.type(within(form).getByTestId('room-service-class'), 'Deluxe');
    await userEvent.type(within(form).getByTestId('room-service-nights'), '3');
    await userEvent.selectOptions(select, 'LAUNDRY');
    await userEvent.type(within(form).getByTestId('room-service-guest'), 'Khách Giặt');
    await userEvent.type(within(form).getByTestId('room-service-ez'), 'EZ55');
    await userEvent.type(within(form).getByTestId('room-service-price'), '120000');
    await userEvent.type(within(form).getByTestId('room-service-note'), '2 bộ');
    await userEvent.click(within(form).getByTestId('room-service-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'ROOM_SERVICE',
      roomService: { serviceType: 'LAUNDRY', guestName: 'Khách Giặt', ezCode: 'EZ55', price: 120000, note: '2 bộ' },
    });
  });

  it('sends an upgrade with its pair, its nights and a numeric price', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: report({ category: 'ROOM_SERVICE', complaint: null, roomService: roomService() }) } };
        },
      }),
    );
    renderApp('/app/reports');
    const form = await openAddService();
    await userEvent.selectOptions(within(form).getByTestId('room-service-type'), 'UPGRADE');
    await userEvent.type(within(form).getByTestId('room-service-guest'), 'Lê Upgrade');
    await userEvent.type(within(form).getByTestId('room-service-from'), 'Standard');
    await userEvent.type(within(form).getByTestId('room-service-to'), 'Deluxe');
    await userEvent.type(within(form).getByTestId('room-service-nights'), '2');
    await userEvent.type(within(form).getByTestId('room-service-price'), '300000');
    await userEvent.click(within(form).getByTestId('room-service-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'ROOM_SERVICE',
      roomService: {
        serviceType: 'UPGRADE',
        guestName: 'Lê Upgrade',
        fromRoomClass: 'Standard',
        toRoomClass: 'Deluxe',
        nights: 2,
        // A NUMBER, not the "300.000" the operator saw.
        price: 300000,
      },
    });
  });

  it('shows the grouped amount while it is being typed', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    const form = await openAddService();
    await userEvent.selectOptions(within(form).getByTestId('room-service-type'), 'SMOKING');

    const price = within(form).getByTestId('room-service-price');
    await userEvent.type(price, '3150000');
    expect(price).toHaveValue('3.150.000');
  });

  it('lays out five tables, one per service, each with only its own rows and columns', async () => {
    const sale = report({
      id: 'rs-sale',
      category: 'ROOM_SERVICE',
      complaint: null,
      createdAt: '2026-09-19T02:05:00.000Z',
      roomService: roomService({ guestName: 'Khách Bán Phòng', price: 850000 }),
    });
    const upgrade = report({
      id: 'rs-up',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({
        serviceType: 'UPGRADE',
        serviceTypeLabel: 'Upgrade',
        guestName: 'Khách Upgrade',
        roomClass: null,
        fromRoomClass: 'Standard',
        toRoomClass: 'Suite',
        nights: 1,
        price: 300000,
      }),
    });
    const laundry = report({
      id: 'rs-laundry',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({
        serviceType: 'LAUNDRY',
        serviceTypeLabel: 'Giặt ủi',
        guestName: 'Khách Giặt Ủi',
        roomClass: null,
        nights: null,
        price: 120000,
        note: '2 bộ',
      }),
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [sale, upgrade, laundry], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 3 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    const groups = await screen.findByTestId('room-service-groups');
    const tables = ['ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER'].map((t) =>
      within(groups).getByTestId(`room-service-table-${t}`),
    );
    // In the fixed order, each under its own heading.
    tables.forEach((table, i) => {
      expect(within(table).getAllByRole('heading')[0]).toHaveTextContent(
        ['Bán phòng', 'Upgrade', 'Hút thuốc', 'Giặt ủi', 'Dịch vụ khác'][i]!,
      );
    });
    const [saleTable, upgradeTable, smokingTable, laundryTable] = tables as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];

    expect(await within(saleTable).findByText('Khách Bán Phòng')).toBeInTheDocument();
    expect(within(saleTable).queryByText('Khách Giặt Ủi')).not.toBeInTheDocument();
    expect(headersOf(saleTable)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Hạng phòng',
      'Số đêm',
      'Giá tiền',
      'Ghi chú',
      'Thời gian',
      'Thao tác',
    ]);
    // The server's time, shown.
    expect(within(saleTable).getByText(formatDateTime('2026-09-19T02:05:00.000Z'))).toBeInTheDocument();

    expect(within(upgradeTable).getByText('Khách Upgrade')).toBeInTheDocument();
    expect(headersOf(upgradeTable)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Từ hạng phòng',
      'Tới hạng phòng',
      'Số đêm',
      'Giá tiền',
      'Ghi chú',
      'Thời gian',
      'Thao tác',
    ]);

    expect(within(laundryTable).getByText('Khách Giặt Ủi')).toBeInTheDocument();
    expect(headersOf(laundryTable)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Giá tiền', 'Ghi chú', 'Thời gian', 'Thao tác']);

    // An empty service says so in one line rather than disappearing.
    expect(within(smokingTable).getByTestId('room-service-table-SMOKING-empty')).toBeInTheDocument();
    // The old per-subtype summary block is gone from the reception screen.
    expect(screen.queryByTestId('room-service-summary')).not.toBeInTheDocument();
  });
});

describe('vấn đề khách yêu cầu thực hiện (Request)', () => {
  it('uses the full title on its own screen', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const view = await screen.findByTestId('category-view');
    expect(within(view).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Vấn đề khách yêu cầu thực hiện (Request)',
    );
  });

  it('asks only for Tên khách, Mã EZ and Nội dung', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('category-add'));
    const form = await screen.findByTestId('guest-request-form');

    expect(within(form).getByLabelText('Tên khách')).toBeInTheDocument();
    expect(within(form).getByLabelText('Mã EZ')).toBeInTheDocument();
    expect(within(form).getByLabelText('Nội dung')).toBeInTheDocument();
    expect(within(form).getAllByRole('textbox')).toHaveLength(3);
    // "Ký gửi" and "Số phòng" are gone, with their quick picks.
    for (const gone of ['guest-request-item', 'guest-request-room', 'guest-request-note', 'guest-request-suggest-Balo']) {
      expect(within(form).queryByTestId(gone)).not.toBeInTheDocument();
    }
    expect(within(form).queryByText(/Ký gửi|Số phòng/)).not.toBeInTheDocument();

    // Mã EZ is optional; a name and the content are not.
    const add = within(form).getByTestId('guest-request-form-add');
    await userEvent.type(within(form).getByTestId('guest-request-guest'), 'K');
    expect(add).toBeDisabled();
    await userEvent.type(within(form).getByTestId('guest-request-content'), 'Gửi hành lý');
    expect(add).toBeEnabled();
  });

  it('records a new request as "Đã tiếp nhận", with its Mã EZ, and shows it at once', async () => {
    let created = false;
    const posted: unknown[] = [];
    const createdRow = requestRow();
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          created = true;
          return { status: 201, body: { report: createdRow } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: created
            ? { reports: [createdRow], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('category-add'));
    await userEvent.type(screen.getByTestId('guest-request-guest'), 'Khách ký gửi');
    await userEvent.type(screen.getByTestId('guest-request-ez'), 'EZ305');
    await userEvent.type(screen.getByTestId('guest-request-content'), 'Gửi balo đen, 14h lấy');
    await userEvent.click(screen.getByTestId('guest-request-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'GUEST_REQUEST',
      guestRequest: { guestName: 'Khách ký gửi', ezCode: 'EZ305', note: 'Gửi balo đen, 14h lấy' },
    });

    const table = await screen.findByTestId('guest-request-table');
    expect(within(table).getByText('Gửi balo đen, 14h lấy')).toBeInTheDocument();
    expect(within(table).getByText('Khách ký gửi')).toBeInTheDocument();
    expect(within(table).getByText('EZ305')).toBeInTheDocument();
    expect(within(table).getByText('Đã tiếp nhận')).toBeInTheDocument();
    // No completion yet: nothing pretends to a completion time or a handling.
    expect(within(table).queryByText('Đã hoàn thành')).not.toBeInTheDocument();
    expect(within(table).getByTestId('complete-g1')).toBeInTheDocument();
  });

  it('shows exactly the seven columns, and no creator', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [requestRow()], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    expect(await within(table).findByText('Khách ký gửi')).toBeInTheDocument();
    expect(headersOf(table)).toEqual([
      'STT',
      'Tên khách',
      'Mã EZ',
      'Nội dung',
      'Thời gian tiếp nhận',
      'Thời gian hoàn thành',
      'Cách xử lý (nếu có)',
    ]);
    expect(within(table).queryByText('Người tạo')).not.toBeInTheDocument();
    expect(within(table).queryByText('Thao tác')).not.toBeInTheDocument();
    expect(within(table).queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
  });

  it('completes with "Cách xử lý (nếu có)" left empty, sending no handling', async () => {
    const posted: unknown[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [requestRow()], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
        'POST /api/reception/reports/g1/complete': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: requestRow() } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    await userEvent.click(await within(table).findByTestId('complete-g1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cách xử lý (nếu có)')).toBeInTheDocument();
    const confirm = within(dialog).getByTestId('complete-confirm');
    // Optional: nothing typed, and the button is still enabled.
    expect(confirm).toBeEnabled();
    // No time field: the server stamps the completion.
    expect(within(dialog).getByTestId('complete-resolution')).toHaveValue('');
    expect(within(dialog).queryByLabelText(/thời gian/i)).not.toBeInTheDocument();

    // Blank is the same as empty: no placeholder text is sent.
    await userEvent.type(within(dialog).getByTestId('complete-resolution'), '   ');
    await userEvent.click(confirm);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({});
  });

  it('completing sends only the handling, and the row then reads "Đã hoàn thành"', async () => {
    let completed = false;
    const posted: unknown[] = [];
    const before = requestRow();
    const after = requestRow(
      { summary: 'Gửi balo đen, 14h lấy · Khách ký gửi · đã hoàn thành' },
      {
        completed: true,
        completedBy: { id: 3, fullName: 'Lễ tân Hai' },
        completedByName: 'Nguyễn B',
        completedAt: '2026-09-19T07:02:00.000Z',
        completedShiftType: 'B',
        completedShiftName: 'Ca B',
        resolution: 'Đã trả balo cho khách',
      },
    );
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [completed ? after : before], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
        'POST /api/reception/reports/g1/complete': (init) => {
          posted.push(JSON.parse(String(init.body)));
          completed = true;
          return { status: 200, body: { report: after } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    await userEvent.click(await within(table).findByTestId('complete-g1'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('complete-resolution'), 'Đã trả balo cho khách');
    await userEvent.click(within(dialog).getByTestId('complete-confirm'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ resolution: 'Đã trả balo cho khách' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const updated = await screen.findByTestId('guest-request-table');
    expect(await within(updated).findByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(updated).getByText('Đã trả balo cho khách')).toBeInTheDocument();
    expect(within(updated).queryByText('Đã tiếp nhận')).not.toBeInTheDocument();
    expect(within(updated).queryByTestId('complete-g1')).not.toBeInTheDocument();
  });

  it('shows an empty state before any request is recorded', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('GUEST_REQUEST');
    expect(await screen.findByTestId('guest-request-table-empty')).toBeInTheDocument();
  });
});

describe('sự cố vật chất đang xử lý', () => {
  it('has no "chọn sự cố" dropdown and no entry form at all', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    await screen.findByTestId('facility-board');

    expect(screen.queryByTestId('facility-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('facility-issue')).not.toBeInTheDocument();
    expect(screen.queryByText(/chọn sự cố/i)).not.toBeInTheDocument();
    // No select of any kind on this category.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('shows the branch’s live incidents and their current status, immediately', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?pageSize=100&outstanding=true': () => ({
          status: 200,
          body: {
            issues: [
              {
                id: 'i1',
                locationLabel: 'Phòng · Phòng 101',
                description: 'Máy lạnh không mát',
                status: 'IN_PROGRESS',
                needsRework: false,
                technicianName: 'Bảo',
                technicianPhone: '0909000111',
                createdAt: '2026-09-19T02:00:00.000Z',
                updatedAt: '2026-09-19T02:30:00.000Z',
                attempts: [],
              },
              {
                id: 'i2',
                locationLabel: 'Khu Vực Sảnh · Sofa',
                description: 'Sofa rách',
                status: 'NEW',
                needsRework: true,
                technicianName: null,
                technicianPhone: null,
                createdAt: '2026-09-19T01:00:00.000Z',
                updatedAt: '2026-09-19T01:45:00.000Z',
                attempts: [
                  {
                    id: 'a1',
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
            ],
            pagination: { page: 1, pageSize: 100, total: 2, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');

    expect(within(board).getByText('Phòng · Phòng 101')).toBeInTheDocument();
    expect(within(board).getByText('Máy lạnh không mát')).toBeInTheDocument();
    expect(within(board).getByText('Đang sửa')).toBeInTheDocument();
    expect(within(board).getByText('Bảo')).toBeInTheDocument();

    expect(within(board).getByText('Khu Vực Sảnh · Sofa')).toBeInTheDocument();
    // NEW + already attempted reads as "Cần xử lý lại", not plain "NEW".
    expect(within(board).getByText('Cần xử lý lại')).toBeInTheDocument();
  });

  it('offers no action on a row: no "Thao tác" column and no per-row button', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?pageSize=100&outstanding=true': () => ({
          status: 200,
          body: {
            issues: [
              {
                id: 'i1',
                locationLabel: 'Phòng · Phòng 101',
                description: 'Máy lạnh không mát',
                status: 'NEW',
                needsRework: false,
                reportedByName: 'Nguyễn Văn A',
                technicianName: null,
                technicianPhone: null,
                completedAt: null,
                createdAt: '2026-09-19T02:00:00.000Z',
                updatedAt: '2026-09-19T02:00:00.000Z',
                attempts: [],
              },
            ],
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không mát')).toBeInTheDocument();
    expect(within(board).queryByText('Thao tác')).not.toBeInTheDocument();
    expect(within(board).queryByText('Người báo')).not.toBeInTheDocument();
    expect(within(board).queryByTestId('facility-log-i1')).not.toBeInTheDocument();
    // Only the phone-only row expander is a button in the table body.
    expect(within(board).queryAllByRole('button').filter((b) => b.dataset.testid !== 'row-toggle-i1')).toHaveLength(0);
  });

  it('keeps an incident this shift recorded on the board after it is fixed, with its completion time', async () => {
    const completedIssue = {
      id: 'i-done',
      locationLabel: 'Phòng · Phòng 202',
      description: 'Vòi sen rò nước',
      category: null,
      status: 'COMPLETED',
      needsRework: false,
      technicianName: 'Bảo',
      technicianPhone: '0909000111',
      completedAt: '2026-09-19T04:30:00.000Z',
      createdAt: '2026-09-19T02:00:00.000Z',
      updatedAt: '2026-09-19T04:30:00.000Z',
      attempts: [
        {
          id: 'a1',
          attemptNumber: 1,
          technicianName: 'Bảo',
          technicianPhone: '0909000111',
          acceptedByName: 'Bảo',
          acceptedAt: '2026-09-19T03:00:00.000Z',
          outcome: 'COMPLETED',
          outcomeAt: '2026-09-19T04:30:00.000Z',
          reason: null,
          durationSeconds: 5400,
          durationLabel: '1 giờ 30 phút',
        },
      ],
    };
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              report({
                id: 'f1',
                category: 'FACILITY_ISSUE',
                categoryLabel: 'Sự cố vật chất đang xử lý',
                complaint: null,
                facility: { issueId: 'i-done', issue: completedIssue },
              }),
            ],
            counts: { ...EMPTY_COUNTS, FACILITY_ISSUE: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Vòi sen rò nước')).toBeInTheDocument();
    expect(within(board).getByText('Đã hoàn thành')).toBeInTheDocument();
    // Read by column: "Lần sửa" is the attempts that exist, not a fabricated count.
    const headers = within(board).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const row = within(board).getByText('Vòi sen rò nước').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
    const cellAt = (header: string) => cells[headers.indexOf(header)];
    expect(cellAt('Lần sửa')).toBe('1');
    expect(cellAt('Thời gian hoàn thành')).toBe(formatDateTime('2026-09-19T04:30:00.000Z'));
    expect(cellAt('Kỹ thuật')).toContain('Bảo');
  });

  it('keeps its row expander mobile-only', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?pageSize=100&outstanding=true': () => ({
          status: 200,
          body: {
            issues: [
              {
                id: 'i1',
                locationLabel: 'Phòng · Phòng 101',
                description: 'Máy lạnh không mát',
                status: 'NEW',
                needsRework: false,
                technicianName: null,
                technicianPhone: null,
                createdAt: '2026-09-19T02:00:00.000Z',
                updatedAt: '2026-09-19T02:00:00.000Z',
                attempts: [],
              },
            ],
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const cell = (await screen.findByTestId('row-toggle-i1')).closest('td');
    expect(cell!.className).toMatch(/\bmd:hidden\b/);
  });

  /**
   * "+ Báo cáo sự cố" IS THE EXISTING ISSUE WORKFLOW, not a copy of it.
   *
   * It opens the same `NewIssueModal` the old standalone screen used, and it
   * posts to the same `/api/issues` — which is what creates the `HotelIssue`
   * the technical department then works. It then records that incident in this
   * shift's journal BY REFERENCE, which is what the removed per-row "Thêm vào
   * nhật ký ca" button used to do. The new incident is on the board as soon as
   * the dialog closes.
   */
  it('reports a new fault through the existing issue form and API, and records it in the shift journal', async () => {
    let created = false;
    const journal: Record<string, unknown>[] = [];
    const NEW_ISSUE = {
      id: 'i-new',
      locationLabel: 'Phòng · Phòng 301',
      description: 'Máy lạnh không lạnh',
      status: 'NEW',
      needsRework: false,
      technicianName: null,
      technicianPhone: null,
      completedAt: null,
      createdAt: '2026-09-19T03:00:00.000Z',
      updatedAt: '2026-09-19T03:00:00.000Z',
      attempts: [],
    };
    const fetchMock = installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?pageSize=100&outstanding=true': () => ({
          status: 200,
          body: {
            issues: created ? [NEW_ISSUE] : [],
            pagination: { page: 1, pageSize: 100, total: created ? 1 : 0, totalPages: 1 },
          },
        }),
        'POST /api/issues': () => {
          created = true;
          return { status: 201, body: { issue: NEW_ISSUE } };
        },
        'POST /api/reception/reports': (init) => {
          journal.push(JSON.parse(String(init.body)));
          return {
            status: 201,
            body: {
              report: report({
                id: 'f-new',
                category: 'FACILITY_ISSUE',
                categoryLabel: 'Sự cố vật chất đang xử lý',
                complaint: null,
                facility: { issueId: 'i-new', issue: NEW_ISSUE },
              }),
            },
          };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    expect(screen.getByTestId('category-add')).toHaveTextContent('Báo cáo sự cố');
    await userEvent.click(screen.getByTestId('category-add'));

    // The EXISTING dialog — its own title, its area-first field order.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Báo cáo sự cố mới');
    expect(within(dialog).getByLabelText('Sự cố')).toHaveValue('ROOM');
    await userEvent.type(within(dialog).getByText('Số phòng').querySelector('input')!, '301');
    await userEvent.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Máy lạnh không lạnh');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi báo cáo' }));

    // Posted to the ONE issue API, not a reception-specific one…
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/issues' && (init as RequestInit).method === 'POST',
        ),
      ).toBe(true),
    );
    // …and the journal receives only a REFERENCE: no description, no area, no technician.
    await waitFor(() => expect(journal).toHaveLength(1));
    expect(journal[0]).toEqual({ category: 'FACILITY_ISSUE', facility: { issueId: 'i-new' } });

    // Closed, and the new incident is on the board.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không lạnh')).toBeInTheDocument();
  });

  it('lays the incidents out in exactly the eight specified columns, in order', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?pageSize=100&outstanding=true': () => ({
          status: 200,
          body: {
            issues: [
              {
                id: 'i1',
                locationLabel: 'Phòng · Phòng 101',
                description: 'Máy lạnh không mát',
                status: 'NEW',
                needsRework: false,
                reportedByName: 'Nguyễn Văn A',
                technicianName: null,
                technicianPhone: null,
                completedAt: null,
                createdAt: '2026-09-19T02:00:00.000Z',
                updatedAt: '2026-09-19T02:00:00.000Z',
                attempts: [],
              },
            ],
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports?category=FACILITY_ISSUE');

    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không mát')).toBeInTheDocument();
    expect(headersOf(board)).toEqual([
      'STT',
      'Sự cố',
      'Khu vực',
      'Thời gian báo cáo',
      'Kỹ thuật',
      'Thời gian hoàn thành',
      'Lần sửa',
      'Trạng thái',
    ]);
    // The reporter is no longer shown to reception.
    expect(within(board).queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing is outstanding', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('FACILITY_ISSUE');
    expect(await screen.findByTestId('facility-board-empty')).toBeInTheDocument();
  });
});

describe('sửa và hủy bản ghi trong bảng chính', () => {
  it('edits a request in a dialog — Tên khách, Mã EZ and Nội dung only — keeping the change history', async () => {
    let updated = false;
    const posted: unknown[] = [];
    const before = requestRow();
    const after = requestRow({}, { note: 'Đã sửa nội dung', content: 'Đã sửa nội dung' });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [updated ? after : before],
            counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 },
          },
        }),
        'PATCH /api/reception/reports/g1': (init) => {
          posted.push(JSON.parse(String(init.body)));
          updated = true;
          return { status: 200, body: { report: after } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    await userEvent.click(await within(table).findByTestId('edit-g1'));

    // The correction offers the current fields and none of the legacy ones.
    expect(await screen.findByTestId('record-edit-guestName')).toBeInTheDocument();
    expect(screen.getByTestId('record-edit-ezCode')).toBeInTheDocument();
    expect(screen.queryByTestId('record-edit-itemType')).not.toBeInTheDocument();
    expect(screen.queryByTestId('record-edit-roomNumber')).not.toBeInTheDocument();

    const content = screen.getByTestId('record-edit-note');
    await userEvent.clear(content);
    await userEvent.type(content, 'Đã sửa nội dung');
    await userEvent.click(screen.getByTestId('record-edit-save'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      guestRequest: { guestName: 'Khách ký gửi', ezCode: 'EZ305', note: 'Đã sửa nội dung' },
    });
    expect(await screen.findByText('Đã sửa nội dung')).toBeInTheDocument();
  });

  it('voiding requires a reason and says plainly that nothing is deleted', async () => {
    const posted: unknown[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [requestRow()], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
        'POST /api/reception/reports/g1/void': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: requestRow({ voided: true, voidReason: 'Nhập nhầm' }) } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    await userEvent.click(await within(table).findByTestId('void-g1'));

    expect(await screen.findByText(/không xóa dữ liệu/i)).toBeInTheDocument();
    expect(screen.getByTestId('void-confirm')).toBeDisabled();

    await userEvent.type(screen.getByTestId('void-reason'), 'Nhập nhầm');
    await userEvent.click(screen.getByTestId('void-confirm'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ reason: 'Nhập nhầm' });
  });

  it('keeps a voided record on screen, marked, with no edit/void controls left', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              report({
                voided: true,
                voidedAt: '2026-09-19T02:00:00.000Z',
                voidedByName: 'Nguyễn Văn A',
                voidReason: 'Nhập nhầm khách',
              }),
            ],
            counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    const table = await screen.findByTestId('service-quality-table');
    expect(within(table).getByText(/Đã hủy: Nhập nhầm khách/)).toBeInTheDocument();
    expect(within(table).queryByTestId('edit-r1')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('void-r1')).not.toBeInTheDocument();
    // A withdrawn report cannot be completed either.
    expect(within(table).queryByTestId('complete-r1')).not.toBeInTheDocument();
  });
});

describe('nhật ký ca hiện tại — thứ yếu, không phải bảng chính', () => {
  it('is collapsed by default, and does not duplicate the primary table as the main view', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    // The primary table is open immediately.
    const table = await screen.findByTestId('service-quality-table');
    expect(within(table).getByText('Trần Thị B')).toBeInTheDocument();

    // The journal exists but starts closed — a native <details>, so a browser
    // hides its rows by default even though jsdom (no layout engine) keeps
    // them in the tree; the attribute is what the component controls.
    const section = screen.getByTestId('journal-section');
    expect(section).not.toHaveAttribute('open');
  });

  it('opens on request and shows the same record, across categories', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('journal-toggle'));
    expect(await screen.findByTestId('journal-row-r1')).toBeInTheDocument();
  });
});

describe('the correction history is visible to the person who made it', () => {
  it('shows old → new, who and when', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              report({
                audits: [
                  {
                    id: 'a1',
                    action: 'EDIT',
                    field: 'description',
                    oldValue: 'Phòng ồn',
                    newValue: 'Phòng ồn suốt đêm',
                    reason: 'Bổ sung chi tiết',
                    actor: { id: 2, name: 'Nguyễn Văn A' },
                    shiftType: 'A',
                    createdAt: '2026-09-19T01:30:00.000Z',
                  },
                ],
              }),
            ],
            counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('journal-toggle'));
    await userEvent.click(await screen.findByTestId('journal-row-r1'));
    const audits = await screen.findByTestId('record-audits-r1');
    expect(audits).toHaveTextContent('Phòng ồn → Phòng ồn suốt đêm');
    expect(audits).toHaveTextContent('Nguyễn Văn A');
    expect(audits).toHaveTextContent('Bổ sung chi tiết');
  });
});
