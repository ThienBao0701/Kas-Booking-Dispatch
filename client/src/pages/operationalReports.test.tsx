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
 *      needs, six grouped tables on its screen, and two figures on the
 *      overview — revenue, and the reviews the desk itself counted
 *      (Tripadvisor + Google), which never add to revenue.
 *   6. "Sự cố cơ sở vật chất đang xử lý" is a MONITOR: no "chọn sự cố" dropdown, no
 *      entry form — it shows the branch's live incidents and their status.
 *   7. Editing and voiding live in the category table, are audited and never
 *      delete a record.
 *   8. There is no "Nhật ký ca hiện tại" on any Reception reporting screen any
 *      more — each category's table is the record; the data itself is untouched.
 *   9. OVERVIEW = COMPACT, DETAIL = COMPLETE. II, III and IV are read across
 *      shifts; the overview shows their summary columns only.
 *  10. "Hoàn thành vấn đề" lists II, III and IV completed 12 hours or more
 *      after receipt — compact, read-only, for Reception only, and filtered on
 *      the SERVER by the days the records were received (default: last 7 days).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import { withLifecycle } from '../test/issueFixtures';
import { formatDateTime, hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

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
    { code: 'FACILITY_ISSUE', label: 'Sự cố cơ sở vật chất đang xử lý' },
    { code: 'CUSTOMER_COMPLAINT', label: 'Vấn đề về chất lượng và dịch vụ' },
    { code: 'ROOM_SERVICE', label: 'Dịch vụ phòng, KPI' },
    { code: 'HOTEL_DELIVERY', label: 'Giao nhận hàng hóa' },
  ],
  paymentMethods: [
    { code: 'CASH', label: 'Tiền mặt' },
    { code: 'TRANSFER', label: 'Chuyển khoản' },
    { code: 'CARD', label: 'Cà thẻ' },
    { code: 'DEBT', label: 'Công nợ' },
  ],
  roomServiceTypes: [
    { code: 'ROOM_SALE', label: 'Bán phòng' },
    { code: 'UPGRADE', label: 'Upgrade' },
    { code: 'SMOKING', label: 'Hút thuốc' },
    { code: 'LAUNDRY', label: 'Giặt ủi' },
    { code: 'OTHER', label: 'Dịch vụ khác' },
    { code: 'REVIEW', label: 'Review' },
  ],
  paymentSources: ['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia', 'Walking', 'Khác'],
  deliveryDepartments: [
    { code: 'RECEPTION', label: 'Lễ tân' },
    { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
    { code: 'TECHNICAL', label: 'Kỹ thuật' },
  ],
  deliveryTitle: 'Giao nhận hàng hóa của khách sạn',
  deliveryArchiveHours: 12,
};

const EMPTY_COUNTS = {
  PAYMENT: 0,
  GUEST_REQUEST: 0,
  FACILITY_ISSUE: 0,
  CUSTOMER_COMPLAINT: 0,
  ROOM_SERVICE: 0,
  HOTEL_DELIVERY: 0,
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
    delivery: null,
    audits: [],
    ...over,
  };
}

type Handler = (init: RequestInit) => { status: number; body?: unknown };

/**
 * II AND IV ARE READ ACROSS SHIFTS, from `/reception/reports/active`. Unless a
 * test sets that route itself, it answers with the II and IV rows the shift
 * journal holds — on the server those rows are part of the active set too, so
 * the two stay consistent without every test restating its rows twice.
 */
function shellRoutes(user: unknown, extra: Record<string, Handler> = {}) {
  const routes = baseRoutes(user, extra);
  const journal = routes['GET /api/reception/reports?shiftSessionId=s1'];
  if (!extra['GET /api/reception/reports/active'] && journal) {
    routes['GET /api/reception/reports/active'] = (init) => {
      const res = journal(init);
      const rows = ((res.body as { reports?: { category: string }[] } | undefined)?.reports ?? []).filter(
        (r) => r.category === 'GUEST_REQUEST' || r.category === 'CUSTOMER_COMPLAINT',
      );
      return { status: res.status, body: { reports: rows, archiveAfterHours: 12 } };
    };
  }
  return routes;
}

function baseRoutes(user: unknown, extra: Record<string, Handler>): Record<string, Handler> {
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
    // The deliveries are branch-wide (not the shift's journal), so they are their own read.
    'GET /api/hotel-deliveries?scope=active': () => ({ status: 200, body: { scope: 'active', deliveries: [] } }),
    'GET /api/hotel-deliveries?scope=archived': () => ({ status: 200, body: { scope: 'archived', deliveries: [] } }),
    // The exact URL `issuesApi.list` builds: `query()` keeps insertion order,
    // and `outstanding` is appended after the rest.
    'GET /api/issues?scope=active&pageSize=100': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
    }),
    ...extra,
  };
}

const FIVE_TITLES = [
  'Theo dõi thanh toán',
  'Vấn đề khách yêu cầu thực hiện (Request)',
  'Sự cố cơ sở vật chất đang xử lý',
  'Vấn đề về chất lượng và dịch vụ',
  'Dịch vụ phòng, KPI',
];

/**
 * The six categories — what "Tổng" offers. "Hoàn thành vấn đề" is a page of its
 * own on the reception menu, not an item here.
 */
const MENU_TITLES = [...FIVE_TITLES, 'Giao nhận hàng hóa của khách sạn'];

/** "Tổng" — the menu of the categories. */
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

  it('lists the real records in each section’s compact summary columns', async () => {
    const doneRequest = requestRow(
      { id: 'g2' },
      { guestName: 'Khách Xong', completed: true, completedAt: '2026-09-19T02:00:00.000Z', resolution: 'Đã trả balo' },
    );
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [requestRow(), doneRequest, report()],
            counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 2, CUSTOMER_COMPLAINT: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const requests = within(overview).getByTestId('guest-request-table');
    expect(await within(requests).findByText('Khách ký gửi')).toBeInTheDocument();
    // OVERVIEW = COMPACT: no times, no handling, no controls.
    expect(headersOf(requests)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Nội dung', 'Trạng thái']);
    expect(within(within(requests).getByTestId('row-g1')).getByText('EZ305')).toBeInTheDocument();
    expect(within(within(requests).getByTestId('row-g1')).getByText('Gửi balo đen, 14h lấy')).toBeInTheDocument();
    // The status is the words and nothing beneath them.
    expect(within(within(requests).getByTestId('row-g1')).getByText('Đã tiếp nhận')).toBeInTheDocument();
    const done = within(requests).getByTestId('row-g2');
    expect(within(done).getByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(done).queryByText('Đã trả balo')).not.toBeInTheDocument();
    expect(within(done).queryByText(formatDateTime('2026-09-19T02:00:00.000Z'))).not.toBeInTheDocument();

    const quality = within(overview).getByTestId('service-quality-table');
    expect(within(quality).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
    expect(headersOf(quality)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Mô tả', 'Trạng thái']);
    expect(within(quality).getByText('Đã tiếp nhận')).toBeInTheDocument();
    // The overview reads: no "Hoàn thành", no "Sửa", no "Hủy".
    expect(within(quality).queryByTestId('complete-r1')).not.toBeInTheDocument();
    expect(within(quality).queryByTestId('edit-r1')).not.toBeInTheDocument();
    expect(within(requests).queryByTestId('complete-g1')).not.toBeInTheDocument();
    expect(within(requests).queryByTestId('edit-g1')).not.toBeInTheDocument();
  });

  /**
   * II AND IV ARE THE BRANCH'S, NOT THE SHIFT'S: an unfinished request from the
   * last shift is on this shift's overview, read from the active set — and a
   * withdrawn row is not on the overview at all.
   */
  it('shows requests and service-quality reports across shifts, without withdrawn rows', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports/active': () => ({
          status: 200,
          body: {
            reports: [
              requestRow({ id: 'g-prev', shiftSessionId: 's0', shiftName: 'Ca C' }, { guestName: 'Khách ca trước' }),
              requestRow({ id: 'g-void', voided: true, voidReason: 'nhầm' }, { guestName: 'Khách đã hủy' }),
              report({ id: 'q-prev', shiftSessionId: 's0', shiftName: 'Ca C' }),
            ],
            archiveAfterHours: 12,
          },
        }),
      }),
    );
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const requests = within(overview).getByTestId('guest-request-table');
    expect(await within(requests).findByText('Khách ca trước')).toBeInTheDocument();
    expect(within(requests).queryByText('Khách đã hủy')).not.toBeInTheDocument();
    expect(within(within(overview).getByTestId('service-quality-table')).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
  });

  /**
   * THE CATEGORY SCREENS READ THE SAME ACTIVE SET: a request the last shift
   * left unfinished is on this shift's "Vấn đề khách yêu cầu thực hiện" screen
   * to be completed — and a row this shift withdrew stays there, struck through.
   */
  it('lists the last shift’s unfinished records on the category screens, where they can be completed', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports/active': () => ({
          status: 200,
          body: {
            reports: [
              requestRow({ id: 'g-prev', shiftSessionId: 's0', shiftName: 'Ca C' }, { guestName: 'Khách ca trước' }),
              requestRow({ id: 'g-void', voided: true, voidReason: 'Trùng' }, { guestName: 'Khách đã hủy' }),
              report({ id: 'q-prev', shiftSessionId: 's0', shiftName: 'Ca C' }),
            ],
            totals: { GUEST_REQUEST: 2, CUSTOMER_COMPLAINT: 1 },
            archiveAfterHours: 12,
          },
        }),
      }),
    );
    renderApp('/app/reports?category=GUEST_REQUEST');

    const requests = await screen.findByTestId('guest-request-table');
    expect(await within(requests).findByText('Khách ca trước')).toBeInTheDocument();
    expect(within(within(requests).getByTestId('row-g-prev')).getByTestId('complete-g-prev')).toBeInTheDocument();
    // Withdrawn by this shift: still on its screen, struck through, with nothing left to press.
    const withdrawn = within(requests).getByTestId('row-g-void');
    expect(withdrawn).toHaveTextContent('Khách đã hủy');
    expect(within(withdrawn).queryByTestId('complete-g-void')).not.toBeInTheDocument();
    expect(screen.queryByTestId('list-more')).not.toBeInTheDocument();

    await openCategory('CUSTOMER_COMPLAINT');
    const quality = await screen.findByTestId('service-quality-table');
    expect(within(quality).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
    expect(within(quality).getByTestId('complete-q-prev')).toBeInTheDocument();
  });

  it('says so when the server returned only the newest page of the active records', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports/active': () => ({
          status: 200,
          body: { reports: [requestRow()], totals: { GUEST_REQUEST: 612, CUSTOMER_COMPLAINT: 0 }, archiveAfterHours: 12 },
        }),
        'GET /api/issues?scope=active&pageSize=100': () => ({
          status: 200,
          body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
        }),
      }),
    );
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    await within(overview).findByText('Khách ký gửi');
    const notes = within(overview).getAllByTestId('list-more');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Đang hiển thị 1 bản ghi gần nhất trên tổng số 612.');

    await openCategory('GUEST_REQUEST');
    expect(await screen.findByTestId('list-more')).toHaveTextContent('tổng số 612');
  });

  it('reduces "Dịch vụ phòng, KPI" to its two figures, from the real rows', async () => {
    const review = report({
      id: 'rv1',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({
        serviceType: 'REVIEW',
        serviceTypeLabel: 'Review',
        roomClass: null,
        nights: null,
        price: 0,
        tripadvisorCount: 3,
        googleCount: 2,
        countsAsRevenue: false,
      }),
    });
    const withdrawnReview = report({
      id: 'rv2',
      category: 'ROOM_SERVICE',
      complaint: null,
      voided: true,
      voidReason: 'nhầm',
      roomService: roomService({
        serviceType: 'REVIEW',
        serviceTypeLabel: 'Review',
        roomClass: null,
        nights: null,
        price: 0,
        tripadvisorCount: 7,
        googleCount: 7,
        countsAsRevenue: false,
      }),
    });
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
          body: { reports: [sale, laundry, voided, review, withdrawnReview], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 5 } },
        }),
      }),
    );
    renderApp('/app/reports');

    const section = await screen.findByTestId('room-service-overview');
    // Real rows, voided excluded: 800.000 + 150.000 — a review is never money.
    expect(await within(section).findByText('950.000 ₫')).toBeInTheDocument();
    expect(within(section).getByText('Tổng doanh thu')).toBeInTheDocument();
    expect(within(section).getByText('Tổng đánh giá (review)')).toBeInTheDocument();
    // The desk's own counts: Tripadvisor 3 + Google 2; the withdrawn review counts for nothing.
    expect(within(section).getByTestId('room-service-review')).toHaveTextContent('5');
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
  it('offers the six categories, in the specified order and exact wording', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    expect(await menuLabels()).toEqual(MENU_TITLES);
  });

  it('never shows a separate KPI category', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    // "KPI" appears ONLY as part of the room-service label, never alone.
    const labels = await menuLabels();
    expect(labels).toHaveLength(6);
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
    // Up from the first wraps to the last: "Giao nhận hàng hóa của khách sạn".
    expect(items[5]).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument());
    expect(screen.getByTestId('report-total')).toHaveFocus();
  });

  it('shows no form while choosing', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const menu = await openTotalMenu();
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(6);
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

  it('lays the table out in exactly the seven columns, with "Sửa" beside the handling and no "Hủy"', async () => {
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
    // No action column: "Sửa" sits with the handling, as in the request table.
    expect(within(table).queryByText('Thao tác')).not.toBeInTheDocument();
    const handling = within(within(table).getByTestId('row-r1')).getAllByRole('cell')[headersOf(table).indexOf('Hướng xử lý (nếu có)') + 1]!;
    expect(within(handling).getByTestId('edit-r1')).toHaveTextContent('Sửa');
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

  /**
   * "SỬA" CORRECTS WHAT THE DESK TYPED — Tên khách, Mã EZ and Mô tả — and
   * nothing else: the times, the completion and its handling stay exactly as
   * recorded. It is offered after completion too.
   */
  it('edits Tên khách, Mã EZ and Mô tả only — even after completion — and sends nothing else', async () => {
    let updated = false;
    const posted: unknown[] = [];
    const completedAt = '2026-09-19T03:00:00.000Z';
    const done = complaint({ completed: true, completedAt, completedByName: 'Nguyễn Văn A', resolution: 'Đổi phòng' });
    const before = report({ complaint: done });
    const after = report({ complaint: { ...done, guestName: 'Trần Thị Bích', description: 'Phòng ồn cả đêm' } });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [updated ? after : before], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
        'PATCH /api/reception/reports/r1': (init) => {
          posted.push(JSON.parse(String(init.body)));
          updated = true;
          return { status: 200, body: { report: after } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    const table = await screen.findByTestId('service-quality-table');
    await userEvent.click(await within(table).findByTestId('edit-r1'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('record-edit-guestName')).toBeInTheDocument();
    expect(within(dialog).getByTestId('record-edit-ezCode')).toBeInTheDocument();
    expect(within(dialog).getByTestId('record-edit-description')).toBeInTheDocument();
    // Nothing that belongs to the server or to the completion.
    expect(within(dialog).queryByTestId('record-edit-resolution')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('record-edit-completedAt')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('record-edit-createdAt')).not.toBeInTheDocument();

    await userEvent.clear(within(dialog).getByTestId('record-edit-guestName'));
    await userEvent.type(within(dialog).getByTestId('record-edit-guestName'), 'Trần Thị Bích');
    await userEvent.clear(within(dialog).getByTestId('record-edit-description'));
    await userEvent.type(within(dialog).getByTestId('record-edit-description'), 'Phòng ồn cả đêm');
    await userEvent.click(within(dialog).getByTestId('record-edit-save'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      complaint: { guestName: 'Trần Thị Bích', ezCode: 'EZ202', description: 'Phòng ồn cả đêm' },
    });
    expect(await within(table).findByText('Phòng ồn cả đêm')).toBeInTheDocument();
    // The completion is still the one the server recorded.
    expect(within(table).getByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(table).getByText(formatDateTime(completedAt))).toBeInTheDocument();
    expect(within(table).getByText('Đổi phòng')).toBeInTheDocument();
  });
});

describe('dịch vụ phòng, KPI', () => {
  /** Category → "+ Thêm dịch vụ" → the unified form. */
  async function openAddService() {
    await openCategory('ROOM_SERVICE');
    await userEvent.click(await screen.findByTestId('category-add'));
    return screen.findByTestId('room-service-form');
  }

  it('offers the six services in one "Chọn dịch vụ" select — not six buttons', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    await screen.findByTestId('category-view');
    expect(screen.queryByTestId('room-service-types')).not.toBeInTheDocument();
    for (const t of ['ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER', 'REVIEW']) {
      expect(screen.queryByTestId(`room-service-type-${t}`)).not.toBeInTheDocument();
    }

    await userEvent.click(screen.getByTestId('category-add'));
    const select = await screen.findByLabelText('Chọn dịch vụ');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((o) => o.textContent)
      .filter((t) => !t?.startsWith('—'));
    expect(options).toEqual(['Bán phòng', 'Upgrade', 'Hút thuốc', 'Giặt ủi', 'Dịch vụ khác', 'Review']);
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

  it('gives Bán phòng two equal columns and Upgrade three, and takes Số đêm as a whole number', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    const form = await openAddService();
    const select = within(form).getByTestId('room-service-type');

    await userEvent.selectOptions(select, 'ROOM_SALE');
    const saleRow = within(form).getByTestId('room-service-conditional');
    expect(saleRow.className).toMatch(/\bsm:grid-cols-2\b/);
    expect(saleRow.className).not.toMatch(/\bsm:grid-cols-3\b/);
    const nights = within(form).getByTestId('room-service-nights');
    expect(nights).toHaveAttribute('type', 'number');
    expect(nights).toHaveAttribute('inputmode', 'numeric');
    expect(nights).toHaveAttribute('min', '1');
    await userEvent.type(nights, '12');
    expect(nights).toHaveValue(12);

    await userEvent.selectOptions(select, 'UPGRADE');
    expect(within(form).getByTestId('room-service-conditional').className).toMatch(/\bsm:grid-cols-3\b/);
    expect(within(form).getByTestId('room-service-nights')).toHaveAttribute('type', 'number');
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

  it('lays out six tables, one per service, each with only its own rows and columns', async () => {
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
    const tables = ['ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER', 'REVIEW'].map((t) =>
      within(groups).getByTestId(`room-service-table-${t}`),
    );
    // In the fixed order, each under its own heading.
    tables.forEach((table, i) => {
      expect(within(table).getAllByRole('heading')[0]).toHaveTextContent(
        ['Bán phòng', 'Upgrade', 'Hút thuốc', 'Giặt ủi', 'Dịch vụ khác', 'Review'][i]!,
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
      'Tổng giá tiền',
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
      'Tổng giá tiền',
      'Ghi chú',
      'Thời gian',
      'Thao tác',
    ]);

    expect(within(laundryTable).getByText('Khách Giặt Ủi')).toBeInTheDocument();
    expect(headersOf(laundryTable)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Tổng giá tiền', 'Ghi chú', 'Thời gian', 'Thao tác']);

    // An empty service says so in one line rather than disappearing.
    expect(within(smokingTable).getByTestId('room-service-table-SMOKING-empty')).toBeInTheDocument();
    // The old per-subtype summary block is gone from the reception screen.
    expect(screen.queryByTestId('room-service-summary')).not.toBeInTheDocument();
  });

  /** A review is a COUNT the desk records — not a sale, and never a price. */
  function reviewRow(over: Record<string, unknown> = {}, counts: Record<string, unknown> = {}) {
    return report({
      id: 'rv1',
      category: 'ROOM_SERVICE',
      complaint: null,
      createdAt: '2026-09-19T03:15:00.000Z',
      roomService: roomService({
        serviceType: 'REVIEW',
        serviceTypeLabel: 'Review',
        guestName: 'Guest A',
        ezCode: 'QA-REVIEW-01',
        roomClass: null,
        nights: null,
        price: 0,
        note: null,
        tripadvisorCount: 3,
        googleCount: 2,
        countsAsRevenue: false,
        ...counts,
      }),
      ...over,
    });
  }

  it('records a Review as its two counts — no price and no note — and needs at least one review', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: reviewRow() } };
        },
      }),
    );
    renderApp('/app/reports');
    const form = await openAddService();

    await userEvent.selectOptions(within(form).getByTestId('room-service-type'), 'REVIEW');
    expect(within(form).getByTestId('room-service-review-counts')).toBeInTheDocument();
    expect(within(form).queryByTestId('room-service-price')).not.toBeInTheDocument();
    expect(within(form).queryByTestId('room-service-note')).not.toBeInTheDocument();
    expect(within(form).queryByTestId('room-service-class')).not.toBeInTheDocument();

    const add = within(form).getByTestId('room-service-form-add');
    await userEvent.type(within(form).getByTestId('room-service-guest'), 'Guest A');
    await userEvent.type(within(form).getByTestId('room-service-ez'), 'QA-REVIEW-01');
    // No review counted yet: nothing to record.
    expect(add).toBeDisabled();
    await userEvent.type(within(form).getByTestId('room-service-tripadvisor'), '3');
    await userEvent.type(within(form).getByTestId('room-service-google'), '2');
    expect(add).toBeEnabled();
    await userEvent.click(add);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'ROOM_SERVICE',
      roomService: {
        serviceType: 'REVIEW',
        guestName: 'Guest A',
        ezCode: 'QA-REVIEW-01',
        tripadvisorCount: 3,
        googleCount: 2,
      },
    });
  });

  it('keeps each count to whole, non-negative digits — a minus sign never reaches it', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    const form = await openAddService();

    await userEvent.selectOptions(within(form).getByTestId('room-service-type'), 'REVIEW');
    const tripadvisor = within(form).getByTestId('room-service-tripadvisor');
    await userEvent.type(tripadvisor, '-3');
    expect(tripadvisor).toHaveValue(3);
    // Zero and zero is no review at all.
    await userEvent.clear(tripadvisor);
    await userEvent.type(tripadvisor, '0');
    await userEvent.type(within(form).getByTestId('room-service-google'), '0');
    await userEvent.type(within(form).getByTestId('room-service-guest'), 'Guest A');
    expect(within(form).getByTestId('room-service-form-add')).toBeDisabled();
  });

  it('gives Review its own table — Tripadvisor and Google where the others have a price — footed in reviews', async () => {
    const sale = report({
      id: 'rs-sale',
      category: 'ROOM_SERVICE',
      complaint: null,
      roomService: roomService({ guestName: 'Khách Bán Phòng', price: 850000 }),
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [
              sale,
              reviewRow(),
              reviewRow({ id: 'rv2' }, { guestName: 'Guest B', ezCode: 'QA-REVIEW-02', tripadvisorCount: 1, googleCount: 0 }),
              reviewRow({ id: 'rv3', voided: true, voidReason: 'nhầm' }, { guestName: 'Guest C', tripadvisorCount: 9, googleCount: 9 }),
            ],
            counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 4 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    const table = await screen.findByTestId('room-service-table-REVIEW');
    expect(await within(table).findByText('Guest A')).toBeInTheDocument();
    expect(headersOf(table)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Tripadvisor', 'Google', 'Thời gian', 'Thao tác']);
    const row = within(table).getByTestId('row-rv1');
    expect(within(row).getByText('QA-REVIEW-01')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText(formatDateTime('2026-09-19T03:15:00.000Z'))).toBeInTheDocument();
    expect(within(row).queryByText(/₫/)).not.toBeInTheDocument();
    // 3 + 2 + 1 + 0; the withdrawn review counts for nothing.
    expect(within(table).getByTestId('room-service-total-REVIEW')).toHaveTextContent('6 review');
    // The sale's total is untouched by any review.
    expect(within(screen.getByTestId('room-service-table-ROOM_SALE')).getByTestId('room-service-total-ROOM_SALE')).toHaveTextContent('850.000 ₫');
  });

  it('will not save a correction that leaves a Review with no review at all', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [reviewRow()], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    const table = await screen.findByTestId('room-service-table-REVIEW');
    await userEvent.click(await within(table).findByTestId('edit-rv1'));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByTestId('record-edit-save');
    const tripadvisor = within(dialog).getByTestId('record-edit-tripadvisorCount');
    const google = within(dialog).getByTestId('record-edit-googleCount');

    await userEvent.clear(tripadvisor);
    await userEvent.type(tripadvisor, '0');
    // Google still holds 2 reviews: a valid correction.
    expect(save).toBeEnabled();
    await userEvent.clear(google);
    await userEvent.type(google, '0');
    expect(save).toBeDisabled();
    await userEvent.type(google, '1');
    expect(save).toBeEnabled();
  });

  it('keeps the overview’s revenue and review total apart as reviews are added, sold and withdrawn', async () => {
    let rows: Record<string, unknown>[] = [reviewRow()];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: rows, counts: { ...EMPTY_COUNTS, ROOM_SERVICE: rows.length } },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/app/reports');

    const section = await screen.findByTestId('room-service-overview');
    const review = within(section).getByTestId('room-service-review');
    await waitFor(() => expect(review).toHaveTextContent('5'));
    expect(within(section).getByText('0 ₫')).toBeInTheDocument();

    // Another review, and a paid service: the revenue moves, the review total moves separately.
    rows = [
      ...rows,
      reviewRow({ id: 'rv2' }, { guestName: 'Guest B', tripadvisorCount: 1, googleCount: 1 }),
      report({ id: 'rs-paid', category: 'ROOM_SERVICE', complaint: null, roomService: roomService({ serviceType: 'LAUNDRY', serviceTypeLabel: 'Giặt ủi', roomClass: null, nights: null, price: 150000 }) }),
    ];
    await user.click(screen.getByRole('button', { name: 'Làm mới' }));
    await waitFor(() => expect(review).toHaveTextContent('7'));
    expect(await within(section).findByText('150.000 ₫')).toBeInTheDocument();

    // The first review withdrawn: the review total falls; the revenue does not.
    rows = rows.map((r) => (r.id === 'rv1' ? { ...r, voided: true, voidReason: 'nhầm' } : r));
    await user.click(screen.getByRole('button', { name: 'Làm mới' }));
    await waitFor(() => expect(review).toHaveTextContent('2'));
    expect(within(section).getByText('150.000 ₫')).toBeInTheDocument();
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

describe('sự cố cơ sở vật chất đang xử lý', () => {
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
        'GET /api/issues?scope=active&pageSize=100': () => ({
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
            ].map(withLifecycle),
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
    // NEW + already attempted reads as "Cần sửa lại", not plain "NEW".
    expect(within(board).getByText('Cần sửa lại')).toBeInTheDocument();
  });

  it('offers ONE action on a row — "Sửa vấn đề" — and none of the technician’s', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
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
            ].map(withLifecycle),
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không mát')).toBeInTheDocument();
    expect(within(board).queryByText('Người báo')).not.toBeInTheDocument();
    expect(within(board).queryByTestId('facility-log-i1')).not.toBeInTheDocument();
    // The one thing reception does to an incident: correct what the report says.
    expect(within(board).getByText('Thao tác')).toBeInTheDocument();
    expect(within(board).getByTestId('edit-issue-i1')).toHaveTextContent('Sửa vấn đề');
    // Working the job — taking it, finishing it, giving it up — is Technical's alone.
    for (const name of [/Tiếp nhận/, /Hoàn thành/, /Không sửa được/, /Nhật ký/]) {
      expect(within(board).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // Everything else in the table body is the row expander.
    expect(
      within(board)
        .queryAllByRole('button')
        .filter((b) => !['row-toggle-i1', 'edit-issue-i1'].includes(b.dataset.testid ?? '')),
    ).toHaveLength(0);
  });

  /**
   * FINISHED WITHIN 12 HOURS OF ITS REPORT, IT STAYS ON THE BOARD — because the
   * server's active set includes it, not because the page merges anything in.
   */
  it('keeps an incident on the board after it is fixed, with its completion time', async () => {
    const completedIssue = withLifecycle({
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
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
          status: 200,
          body: { issues: [completedIssue], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Vòi sen rò nước')).toBeInTheDocument();
    expect(within(board).getByText('Đã hoàn thành')).toBeInTheDocument();
    // Inspection is dormant: no verdict is shown, and none is invented.
    expect(within(board).queryByTestId('issue-inspection')).not.toBeInTheDocument();
    // "Lần sửa" is not a reception column any more; the attempts are one click down.
    const headers = within(board).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(headers).not.toContain('Lần sửa');
    const row = within(board).getByText('Vòi sen rò nước').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
    const cellAt = (header: string) => cells[headers.indexOf(header)];
    // A finished incident is a closed record: nothing left to correct.
    expect(within(row).queryByText('Sửa vấn đề')).not.toBeInTheDocument();
    expect(cellAt('Thời gian hoàn thành')).toBe(formatDateTime('2026-09-19T04:30:00.000Z'));
    // "Người sửa" comes from the attempt, not from who reported it.
    expect(cellAt('Người sửa')).toContain('Bảo');
  });

  it('keeps the repair history one click down at every width, now that "Lần sửa" is gone', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
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
            ].map(withLifecycle),
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
          },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    const cell = (await screen.findByTestId('row-toggle-i1')).closest('td');
    // Not `md:hidden`: on a desktop the expander is the ONLY way to the history.
    expect(cell!.className).not.toMatch(/\bmd:hidden\b/);
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
    const NEW_ISSUE = withLifecycle({
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
    });
    const fetchMock = installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
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
                categoryLabel: 'Sự cố cơ sở vật chất đang xử lý',
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
    expect(within(dialog).getByLabelText('Khu vực')).toHaveValue('ROOM');
    await userEvent.type(within(dialog).getByText('Số phòng').querySelector('input')!, '301');
    await userEvent.type(within(dialog).getByLabelText('Sự cố'), 'Máy lạnh không lạnh');
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

  it('lays the incidents out in exactly the nine specified columns, the last one the action, in order', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
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
            ].map(withLifecycle),
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
      'Khu vực',
      'Sự cố',
      'Nguyên nhân',
      'Thời gian báo cáo',
      'Người sửa',
      'Thời gian hoàn thành',
      'Trạng thái',
      'Thao tác',
    ]);
    // The reporter is no longer shown to reception.
    expect(within(board).queryByText('Nguyễn Văn A')).not.toBeInTheDocument();
  });

  /** Two finished attempts: Lần 1 failed inspection, Lần 2 passed. */
  function twiceRepaired(over: Record<string, unknown> = {}) {
    const attempt = {
      id: 'a1',
      attemptNumber: 1,
      technicianName: 'Bảo',
      technicianPhone: '0369852177',
      acceptedByName: 'Bảo',
      acceptedAt: '2026-09-19T03:30:00.000Z',
      outcome: 'COMPLETED',
      outcomeAt: '2026-09-19T04:10:00.000Z',
      reason: null,
      cause: 'Thiếu gas',
      result: 'Đã nạp gas',
      inspection: { result: 'FAILED', resultLabel: 'Không đạt', inspectedByName: 'Hùng', inspectedAt: '2026-09-19T04:40:00.000Z', note: 'Vẫn chưa lạnh' },
      durationSeconds: 2400,
      durationLabel: '40 phút',
    };
    return withLifecycle({
      id: 'i-pass',
      locationLabel: 'Phòng · Phòng 305',
      description: 'Máy lạnh không lạnh',
      category: null,
      status: 'COMPLETED',
      needsRework: false,
      reportedCause: null,
      technicianName: 'Minh',
      technicianPhone: '0911222333',
      completedAt: '2026-09-19T06:00:00.000Z',
      createdAt: '2026-09-19T02:00:00.000Z',
      updatedAt: '2026-09-19T06:20:00.000Z',
      attempts: [
        attempt,
        {
          ...attempt,
          id: 'a2',
          attemptNumber: 2,
          technicianName: 'Minh',
          technicianPhone: '0911222333',
          acceptedByName: 'Minh',
          acceptedAt: '2026-09-19T05:20:00.000Z',
          outcomeAt: '2026-09-19T06:00:00.000Z',
          cause: 'Rò rỉ ống đồng',
          result: 'Đã hàn ống',
          inspection: { result: 'PASSED', resultLabel: 'Đạt', inspectedByName: 'Hùng', inspectedAt: '2026-09-19T06:20:00.000Z', note: null },
        },
      ],
      ...over,
    });
  }

  async function facilityRowCells(issue: unknown) {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
          status: 200,
          body: { issues: [issue], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
        }),
      }),
    );
    renderApp('/app/reports?category=FACILITY_ISSUE');

    const board = await screen.findByTestId('facility-board');
    const row = (await within(board).findByText('Máy lạnh không lạnh')).closest('tr')!;
    const headers = within(board).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
    return (header: string) => cells[headers.indexOf(header)];
  }

  /**
   * WHILE INSPECTION IS DORMANT the status is the operational one — the
   * technician's "Hoàn thành" — and "Người sửa" and "Nguyên nhân" come from the
   * repair itself. A verdict recorded earlier is kept, not shown.
   */
  it('shows the status, the repairer and the cause — and no inspection while it is dormant', async () => {
    const cellAt = await facilityRowCells(twiceRepaired());
    expect(cellAt('Trạng thái')).toContain('Đã hoàn thành');
    expect(cellAt('Trạng thái')).not.toContain('Nghiệm thu');
    expect(cellAt('Người sửa')).toContain('Minh');
    expect(cellAt('Nguyên nhân')).toBe('Rò rỉ ống đồng');
    // "Lần sửa" is not a reception column: the attempts are one click down.
    expect(cellAt('Lần sửa')).toBeUndefined();
    expect(cellAt('Thời gian hoàn thành')).toBe(formatDateTime('2026-09-19T06:00:00.000Z'));
  });

  /**
   * With inspection switched on, "the technician finished" and "the repair
   * passed" are two events, and the desk has to be able to tell them apart —
   * so the inspection sits beneath the status.
   */
  it('with inspection switched on, shows the inspection beneath the status', async () => {
    const cellAt = await facilityRowCells(twiceRepaired({ inspectionEnabled: true }));
    expect(cellAt('Trạng thái')).toContain('Đã hoàn thành');
    expect(cellAt('Trạng thái')).toContain('Nghiệm thu: Đạt');
    expect(cellAt('Người sửa')).toContain('Minh');
  });

  /** OVERVIEW = COMPACT: the five facts, and nothing to open. */
  it('reduces the overview’s incident section to STT, Khu vực, Sự cố, Nguyên nhân and Trạng thái', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
          status: 200,
          body: { issues: [twiceRepaired()], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const board = within(overview).getByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không lạnh')).toBeInTheDocument();
    expect(headersOf(board)).toEqual(['STT', 'Khu vực', 'Sự cố', 'Nguyên nhân', 'Trạng thái']);
    for (const detailOnly of ['Lần sửa', 'Người sửa', 'Thời gian báo cáo', 'Thời gian hoàn thành']) {
      expect(within(board).queryByRole('columnheader', { name: detailOnly })).not.toBeInTheDocument();
    }
    expect(within(board).getByText('Rò rỉ ống đồng')).toBeInTheDocument();
    expect(within(board).getByText('Đã hoàn thành')).toBeInTheDocument();
    // No repairer, no times, no attempts — and nothing to open into them.
    expect(within(board).queryByText('Minh')).not.toBeInTheDocument();
    // On a phone only, "Nguyên nhân" folds into the row's expander — which holds
    // that column and nothing else.
    const toggle = within(board).getByTestId('row-toggle-i-pass');
    expect(toggle.closest('td')!.className).toMatch(/\bmd:hidden\b/);
    await userEvent.click(toggle);
    expect(within(board).queryByTestId('issue-timeline')).not.toBeInTheDocument();
    expect(within(board).queryByTestId('issue-lifecycle')).not.toBeInTheDocument();
  });

  it('says so when the board shows only the newest 100 incidents', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/issues?scope=active&pageSize=100': () => ({
          status: 200,
          body: {
            issues: [
              withLifecycle({
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
              }),
            ],
            pagination: { page: 1, pageSize: 100, total: 140, totalPages: 2 },
          },
        }),
      }),
    );
    renderApp('/app/reports?category=FACILITY_ISSUE');

    await screen.findByText('Máy lạnh không mát');
    expect(screen.getByTestId('list-more')).toHaveTextContent('Đang hiển thị 1 bản ghi gần nhất trên tổng số 140.');
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

describe('no "Nhật ký ca hiện tại" on Reception', () => {
  const noJournal = () => {
    expect(screen.queryByText(/Nhật ký ca hiện tại/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('journal-list')).not.toBeInTheDocument();
  };

  it('is on neither the overview nor any category screen, and each category keeps its own table', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [requestRow(), report()], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await screen.findByTestId('report-overview');
    noJournal();
    for (const [code, table] of [
      ['PAYMENT', 'payment-table-section'],
      ['GUEST_REQUEST', 'guest-request-table'],
      ['FACILITY_ISSUE', 'facility-board'],
      ['CUSTOMER_COMPLAINT', 'service-quality-table'],
      ['ROOM_SERVICE', 'room-service-groups'],
    ] as const) {
      await openCategory(code);
      expect(await screen.findByTestId(table)).toBeInTheDocument();
      noJournal();
    }
  });
});

describe('hoàn thành vấn đề — the 12-hour completion archive', () => {
  /** The page's own default: the last 7 days, ending today (HCM). */
  const TODAY = hcmToday();
  const WEEK_FROM = daysBefore(TODAY, 6);
  const archiveUrl = (from: string, to: string) => `GET /api/reception/reports/archive?from=${from}&to=${to}`;
  const issuesUrl = (from: string, to: string) => `GET /api/issues?scope=archive&from=${from}&to=${to}&pageSize=100`;

  const doneRequest = () =>
    requestRow(
      { id: 'g-old', createdAt: '2026-09-18T01:00:00.000Z' },
      { guestName: 'Khách Cũ', completed: true, completedAt: '2026-09-18T02:00:00.000Z', resolution: 'Đã trả balo' },
    );
  const doneComplaint = () =>
    report({
      id: 'q-old',
      createdAt: '2026-09-18T01:30:00.000Z',
      complaint: complaint({ guestName: 'Khách Phàn Nàn', completed: true, completedAt: '2026-09-18T03:00:00.000Z', resolution: 'Đổi phòng' }),
    });
  const doneIssue = () =>
    withLifecycle({
      id: 'i-old',
      locationLabel: 'Phòng · Phòng 404',
      description: 'Bóng đèn cháy',
      category: null,
      status: 'COMPLETED',
      needsRework: false,
      reportedCause: 'Hết tuổi thọ',
      technicianName: 'Bảo',
      technicianPhone: '0909000111',
      completedAt: '2026-09-18T04:00:00.000Z',
      createdAt: '2026-09-18T01:00:00.000Z',
      updatedAt: '2026-09-18T04:00:00.000Z',
      attempts: [],
    });

  const deliveriesUrl = (from: string, to: string) =>
    `GET /api/hotel-deliveries?scope=archived&from=${from}&to=${to}`;
  const noDeliveries = (from: string, to: string) => ({
    [deliveriesUrl(from, to)]: () => ({ status: 200, body: { scope: 'archived', deliveries: [], total: 0 } }),
  });

  function archiveRoutes(
    totals = { GUEST_REQUEST: 1, CUSTOMER_COMPLAINT: 1 },
    user: unknown = RECEPTIONIST_USER,
    from = WEEK_FROM,
    to = TODAY,
  ) {
    return shellRoutes(user, {
      ...noDeliveries(from, to),
      [archiveUrl(from, to)]: () => ({
        status: 200,
        body: { reports: [doneRequest(), doneComplaint()], totals, range: { from, to }, archiveAfterHours: 12 },
      }),
      [issuesUrl(from, to)]: () => ({
        status: 200,
        body: { issues: [doneIssue()], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
      }),
    });
  }

  const emptyArchive = (from: string, to: string) => ({
    ...noDeliveries(from, to),
    [archiveUrl(from, to)]: () => ({
      status: 200,
      body: { reports: [], totals: { GUEST_REQUEST: 0, CUSTOMER_COMPLAINT: 0 }, range: { from, to }, archiveAfterHours: 12 },
    }),
    [issuesUrl(from, to)]: () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
    }),
  });

  const requested = (fetchMock: ReturnType<typeof installApiMock>, key: string) =>
    fetchMock.mock.calls.some(([url, init]) => `${((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${String(url)}` === key);

  it('is on the reception menu, beside "Báo cáo vấn đề"', async () => {
    installApiMock(archiveRoutes());
    renderApp('/app/reports');

    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Hoàn thành vấn đề' }));
    expect(await screen.findByTestId('completed-issues')).toBeInTheDocument();
    expect(screen.getByText('Vấn đề đã hoàn thành, từ 12 giờ trở lên kể từ lúc lễ tân tiếp nhận.')).toBeInTheDocument();
  });

  it('lists II, III and IV in their compact columns, each as "Đã hoàn thành" — and nothing to press', async () => {
    installApiMock(archiveRoutes());
    renderApp('/app/completed-issues');

    const page = await screen.findByTestId('completed-issues');
    const requests = within(page).getByTestId('guest-request-table');
    expect(await within(requests).findByText('Khách Cũ')).toBeInTheDocument();
    expect(headersOf(requests)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Nội dung', 'Trạng thái']);
    expect(within(requests).getByText('Đã hoàn thành')).toBeInTheDocument();

    const facility = within(page).getByTestId('completed-facility');
    expect(await within(facility).findByText('Bóng đèn cháy')).toBeInTheDocument();
    expect(headersOf(facility)).toEqual(['STT', 'Khu vực', 'Sự cố', 'Nguyên nhân', 'Trạng thái']);
    expect(within(facility).getByText('Đã hoàn thành')).toBeInTheDocument();

    const quality = within(page).getByTestId('service-quality-table');
    expect(within(quality).getByText('Khách Phàn Nàn')).toBeInTheDocument();
    expect(headersOf(quality)).toEqual(['STT', 'Tên khách', 'Mã EZ', 'Mô tả', 'Trạng thái']);
    expect(within(quality).getByText('Đã hoàn thành')).toBeInTheDocument();

    // A read-only list: nothing to press — the filter and "Làm mới" sit above it —
    // but, on a phone only, each row's expander for the column folded into it.
    for (const button of within(page).queryAllByRole('button')) {
      expect(button.dataset.testid).toMatch(/^row-toggle-/);
      expect(button.closest('td')!.className).toMatch(/\bmd:hidden\b/);
    }
    expect(within(page).queryByTestId('complete-g-old')).not.toBeInTheDocument();
    expect(within(page).queryByTestId('edit-q-old')).not.toBeInTheDocument();
    // Payments and room services are never part of it.
    expect(screen.queryByTestId('payment-overview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-service-overview')).not.toBeInTheDocument();
    expect(screen.queryByText('Đã trả balo')).not.toBeInTheDocument();
  });

  it('says so when a section shows only the newest of more', async () => {
    installApiMock(archiveRoutes({ GUEST_REQUEST: 250, CUSTOMER_COMPLAINT: 1 }));
    renderApp('/app/completed-issues');

    const page = await screen.findByTestId('completed-issues');
    await within(page).findByText('Khách Cũ');
    const notes = within(page).getAllByTestId('list-more');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Đang hiển thị 1 bản ghi gần nhất trên tổng số 250.');
  });

  it('asks the SERVER for the last 7 days by default, by the day received — and shows no journal', async () => {
    const fetchMock = installApiMock(archiveRoutes());
    renderApp('/app/completed-issues');

    await within(await screen.findByTestId('completed-issues')).findByText('Khách Cũ');
    expect(requested(fetchMock, archiveUrl(WEEK_FROM, TODAY))).toBe(true);
    expect(requested(fetchMock, issuesUrl(WEEK_FROM, TODAY))).toBe(true);
    expect(requested(fetchMock, deliveriesUrl(WEEK_FROM, TODAY))).toBe(true);
    // The range is the page's own, visible, and labelled as the day RECEIVED.
    const filters = screen.getByTestId('completed-filters');
    expect(within(filters).getByText('Ngày tiếp nhận')).toBeInTheDocument();
    expect(within(filters).getByTestId('completed-range-from')).toHaveValue(WEEK_FROM);
    expect(within(filters).getByTestId('completed-range-to')).toHaveValue(TODAY);
    expect(within(filters).getByTestId('completed-range-6')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Nhật ký ca hiện tại/)).not.toBeInTheDocument();
  });

  it('re-asks the server when a quick period or a typed range is chosen', async () => {
    const MONTH_FROM = daysBefore(TODAY, 29);
    const fetchMock = installApiMock({
      ...archiveRoutes(),
      ...emptyArchive(TODAY, TODAY),
      ...archiveRoutes(undefined, RECEPTIONIST_USER, MONTH_FROM, TODAY),
      ...emptyArchive('2026-09-01', '2026-09-02'),
    });
    renderApp('/app/completed-issues');
    await within(await screen.findByTestId('completed-issues')).findByText('Khách Cũ');

    await userEvent.click(screen.getByTestId('completed-range-0'));
    await waitFor(() => expect(requested(fetchMock, archiveUrl(TODAY, TODAY))).toBe(true));
    expect(requested(fetchMock, issuesUrl(TODAY, TODAY))).toBe(true);
    // A same-day range with nothing in it says so — about the range, not the system.
    expect(
      await within(screen.getByTestId('completed-issues')).findAllByText('Không có vấn đề hoàn thành trong khoảng thời gian này.'),
    ).toHaveLength(4);

    await userEvent.click(screen.getByTestId('completed-range-29'));
    await waitFor(() => expect(requested(fetchMock, archiveUrl(MONTH_FROM, TODAY))).toBe(true));
    expect(await within(screen.getByTestId('completed-issues')).findByText('Khách Cũ')).toBeInTheDocument();

    // A typed range: the start first (it carries the end along), then the end.
    const from = screen.getByTestId('completed-range-from');
    const to = screen.getByTestId('completed-range-to');
    fireEvent.change(from, { target: { value: '2026-09-01' } });
    fireEvent.change(to, { target: { value: '2026-09-02' } });
    await waitFor(() => expect(requested(fetchMock, archiveUrl('2026-09-01', '2026-09-02'))).toBe(true));
    expect(requested(fetchMock, issuesUrl('2026-09-01', '2026-09-02'))).toBe(true);
  });

  it('sends nothing for half a range, and says what is missing', async () => {
    const fetchMock = installApiMock(archiveRoutes());
    renderApp('/app/completed-issues');
    await within(await screen.findByTestId('completed-issues')).findByText('Khách Cũ');
    const before = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByTestId('completed-range-from'), { target: { value: '' } });
    expect(await screen.findByTestId('completed-range-invalid')).toHaveTextContent('Hãy chọn đủ ngày bắt đầu và ngày kết thúc.');
    expect(screen.queryByTestId('completed-issues')).not.toBeInTheDocument();
    const after = fetchMock.mock.calls.slice(before).map(([url]) => String(url));
    expect(
      after.some((u) => u.includes('/reception/reports/archive') || u.includes('scope=archive') || u.includes('/hotel-deliveries')),
    ).toBe(false);
  });

  it('is Reception’s alone: an Admin is refused, and nothing is read', async () => {
    const fetchMock = installApiMock(archiveRoutes(undefined, ADMIN_USER));
    renderApp('/app/completed-issues');

    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
    expect(screen.queryByTestId('completed-issues')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/reception/reports/archive'))).toBe(false);
  });
});
