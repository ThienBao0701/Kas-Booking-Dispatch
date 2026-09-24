/**
 * "BÁO CÁO VẤN ĐỀ" — the reception journal, in the browser.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Exactly five categories, in the SPECIFIED order and EXACT wording:
 *      Theo dõi thanh toán · Vấn đề khách yêu cầu · Sự cố vật chất đang xử lý ·
 *      Vấn đề về chất lượng dịch vụ · Dịch vụ phòng, KPI.
 *   2. The branch, the shift and the employee are SHOWN and never asked for —
 *      no form on this page has a field that could change any of them.
 *   3. Every category with an entry form shows a PRIMARY RECORD TABLE directly
 *      under it, and a submitted record appears there immediately — not only in
 *      the shift journal.
 *   4. "Vấn đề về chất lượng dịch vụ" asks for three fields and nothing else:
 *      no priority, no severity, no status.
 *   5. "Dịch vụ phòng, KPI" asks only what the selected subtype needs, and its
 *      table follows the selected subtype.
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
    { code: 'CUSTOMER_COMPLAINT', label: 'Vấn đề về chất lượng dịch vụ' },
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
  guestRequestItems: ['Balo', 'Hành lý', 'Vật dụng khác'],
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

function report(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    category: 'CUSTOMER_COMPLAINT',
    categoryLabel: 'Vấn đề về chất lượng dịch vụ',
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
    summary: 'Trần Thị B · 202 · Phòng ồn suốt đêm',
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    payment: null,
    guestRequest: null,
    facility: null,
    complaint: { guestName: 'Trần Thị B', location: '202', description: 'Phòng ồn suốt đêm' },
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

/** The landing's one action — "+ Báo cáo vấn đề" — and the picker it opens. */
async function openPicker() {
  await userEvent.click(await screen.findByTestId('report-start'));
  return screen.findByTestId('category-menu');
}

/** Landing → picker → one category. */
async function openCategory(code: string) {
  const menu = await openPicker();
  await userEvent.click(within(menu).getByTestId(`category-${code}`));
}

/** The picker's five LABELS, in on-screen order. */
async function hubLabels() {
  const menu = await openPicker();
  return within(menu)
    .getAllByRole('button')
    .map((b) => within(b).getByTestId(/^category-label-/).textContent);
}

describe('the landing', () => {
  /**
   * ONE ACTION, NOTHING ELSE. The landing used to be five cards and before that
   * a payment form; now it is a clean page whose one action offers the five.
   */
  it('opens on a clean landing: no category, no form, no dialog', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const landing = await screen.findByTestId('report-landing');
    expect(within(landing).getByTestId('report-start')).toHaveTextContent('Báo cáo vấn đề');
    expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"+ Báo cáo vấn đề" offers the five categories in a dialog, and choosing one opens it', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const menu = await openPicker();
    expect(within(await screen.findByRole('dialog')).getByTestId('category-menu')).toBe(menu);
    await userEvent.click(within(menu).getByTestId('category-PAYMENT'));

    await waitFor(() => expect(screen.queryByTestId('category-menu')).not.toBeInTheDocument());
    expect(await screen.findByTestId('category-view')).toHaveTextContent('Theo dõi thanh toán');
  });

  /** The old "Sự cố khách sạn" / "Báo cáo sự cố" address lands on its category. */
  it('opens a deep-linked category directly', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports?category=FACILITY_ISSUE');

    expect(await screen.findByTestId('facility-board')).toBeInTheDocument();
    expect(screen.queryByTestId('report-landing')).not.toBeInTheDocument();
  });

  it('ignores a deep link to a category that does not exist', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports?category=KPI');

    expect(await screen.findByTestId('report-landing')).toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
  });
});

describe('the category picker', () => {
  it('offers exactly five, in the specified order and exact wording', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    expect(await hubLabels()).toEqual([
      'Theo dõi thanh toán',
      'Vấn đề khách yêu cầu',
      'Sự cố vật chất đang xử lý',
      'Vấn đề về chất lượng dịch vụ',
      'Dịch vụ phòng, KPI',
    ]);
  });

  it('never shows a separate KPI category', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    // "KPI" appears ONLY as part of the room-service label, never alone.
    const labels = await hubLabels();
    expect(labels).toHaveLength(5);
    expect(labels.filter((l) => l === 'KPI')).toHaveLength(0);
    expect(labels).toContain('Dịch vụ phòng, KPI');
  });

  /**
   * THE SCREEN OPENS ON THE HUB, NOT ON A FORM.
   *
   * It used to land straight on the payment form — one category's data entry
   * presented as the whole feature.
   */
  it('shows the five categories with no form on screen', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const menu = await openPicker();
    expect(within(menu).getAllByRole('button')).toHaveLength(5);
    for (const form of [
      'payment-form',
      'guest-request-form',
      'service-quality-form',
      'room-service-form',
    ]) {
      expect(screen.queryByTestId(form)).not.toBeInTheDocument();
    }
  });

  it('counts this shift’s records on each card', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [report(), report({ id: 'r2' })],
            counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 2 },
          },
        }),
      }),
    );
    renderApp('/app/reports');
    await openPicker();

    // Awaited on the VALUE: the card renders at 0 before the journal arrives.
    await waitFor(() =>
      expect(screen.getByTestId('category-count-CUSTOMER_COMPLAINT')).toHaveTextContent('2'),
    );
    expect(screen.getByTestId('category-count-PAYMENT')).toHaveTextContent('0');
  });

  it('goes back to the landing from a category', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    expect(await screen.findByTestId('category-view')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('category-back'));
    expect(await screen.findByTestId('report-landing')).toBeInTheDocument();
    expect(screen.queryByTestId('category-view')).not.toBeInTheDocument();
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
    await userEvent.type(screen.getByTestId('service-quality-location'), '202');
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
    await screen.findByTestId('report-landing');
    expect(screen.getByRole('link', { name: 'Báo cáo vấn đề' })).toHaveAttribute(
      'href',
      '/app/reports',
    );
  });
});

describe('the shift owns the record', () => {
  it('states the branch, the shift and the employee — and asks for none of them', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    const banner = await screen.findByTestId('journal-context');
    expect(within(banner).getByText('05 Trương Định')).toBeInTheDocument();
    // Awaited: the shift comes from its own request, which resolves after the
    // banner first renders with placeholders.
    expect(await within(banner).findByText('Ca A · 06:00 – 14:00')).toBeInTheDocument();
    expect(within(banner).getByText('Nguyễn Văn A')).toBeInTheDocument();

    // There is no field anywhere on this page that could change any of them.
    expect(screen.queryByLabelText(/Nhân viên/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Chi nhánh/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Ca/)).not.toBeInTheDocument();
  });
});

describe('vấn đề về chất lượng dịch vụ', () => {
  it('asks for three fields and nothing else', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    const form = await screen.findByTestId('service-quality-form');

    expect(within(form).getByTestId('service-quality-guest')).toBeInTheDocument();
    expect(within(form).getByTestId('service-quality-location')).toBeInTheDocument();
    expect(within(form).getByTestId('service-quality-description')).toBeInTheDocument();

    // No priority, no severity, no status — deliberately absent.
    for (const absent of [/ưu tiên/i, /mức độ/i, /nghiêm trọng/i, /trạng thái/i]) {
      expect(within(form).queryByText(absent)).not.toBeInTheDocument();
    }
    // Three inputs plus the textarea, and no select at all.
    expect(within(form).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('sends exactly the three fields, and the record appears in its own table immediately', async () => {
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
    await userEvent.type(screen.getByTestId('service-quality-location'), '202');
    await userEvent.type(screen.getByTestId('service-quality-description'), 'Phòng ồn suốt đêm');
    await userEvent.click(screen.getByTestId('service-quality-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Trần Thị B', location: '202', description: 'Phòng ồn suốt đêm' },
    });

    // In the CATEGORY TABLE directly under the form — not only the journal.
    const table = await screen.findByTestId('service-quality-table');
    expect(within(table).getByText('Trần Thị B')).toBeInTheDocument();
    expect(within(table).getByText('Phòng ồn suốt đêm')).toBeInTheDocument();
  });

  it('will not submit until all three are filled in', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    await userEvent.click(await screen.findByTestId('category-add'));
    expect(screen.getByTestId('service-quality-form-add')).toBeDisabled();

    await userEvent.type(screen.getByTestId('service-quality-guest'), 'A');
    await userEvent.type(screen.getByTestId('service-quality-location'), '101');
    expect(screen.getByTestId('service-quality-form-add')).toBeDisabled();

    await userEvent.type(screen.getByTestId('service-quality-description'), 'x');
    expect(screen.getByTestId('service-quality-form-add')).toBeEnabled();
  });

  it('shows an empty state before anything is recorded', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('CUSTOMER_COMPLAINT');
    expect(await screen.findByTestId('service-quality-table-empty')).toBeInTheDocument();
  });
});

describe('dịch vụ phòng, KPI', () => {
  it('offers all five subtypes', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    const types = await screen.findByTestId('room-service-types');
    expect(within(types).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Bán phòng',
      'Upgrade',
      'Hút thuốc',
      'Giặt ủi',
      'Dịch vụ khác',
    ]);
  });

  it('asks only for the fields the chosen subtype needs', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('ROOM_SERVICE');
    await userEvent.click(await screen.findByTestId('category-add'));

    // Bán phòng: loại phòng and SĐT, no upgrade pair.
    expect(await screen.findByTestId('room-service-class')).toBeInTheDocument();
    expect(screen.getByTestId('room-service-phone')).toBeInTheDocument();
    expect(screen.queryByTestId('room-service-from')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('room-service-type-UPGRADE'));
    expect(screen.getByTestId('room-service-from')).toBeInTheDocument();
    expect(screen.getByTestId('room-service-to')).toBeInTheDocument();
    expect(screen.queryByTestId('room-service-class')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('room-service-type-OTHER'));
    expect(screen.getByTestId('room-service-name')).toBeInTheDocument();
    expect(screen.getByTestId('room-service-room')).toBeInTheDocument();
  });

  it('sends the subtype’s own fields and a numeric price, and shows the row under its subtype’s table', async () => {
    let created = false;
    const posted: Record<string, unknown>[] = [];
    const created_row = report({
      id: 'rs1',
      category: 'ROOM_SERVICE',
      categoryLabel: 'Dịch vụ phòng, KPI',
      complaint: null,
      roomService: {
        serviceType: 'UPGRADE',
        serviceTypeLabel: 'Upgrade',
        guestName: 'Lê Upgrade',
        phone: null,
        roomNumber: null,
        roomClass: null,
        fromRoomClass: 'Standard',
        toRoomClass: 'Deluxe',
        serviceName: null,
        price: 300000,
        note: null,
      },
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          created = true;
          return { status: 201, body: { report: created_row } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: created
            ? { reports: [created_row], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('ROOM_SERVICE');
    // Choose WHICH subtype on the page, then open the dialog that adds one.
    await userEvent.click(screen.getByTestId('room-service-type-UPGRADE'));
    await userEvent.click(screen.getByTestId('category-add'));
    // The dialog names the subtype it is adding to.
    expect(await screen.findByRole('dialog')).toHaveTextContent('Thêm upgrade');
    await userEvent.type(screen.getByTestId('room-service-guest'), 'Lê Upgrade');
    await userEvent.type(screen.getByTestId('room-service-from'), 'Standard');
    await userEvent.type(screen.getByTestId('room-service-to'), 'Deluxe');
    await userEvent.type(screen.getByTestId('room-service-price'), '300000');
    await userEvent.click(screen.getByTestId('room-service-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0] as { roomService: Record<string, unknown> };
    expect(body.roomService.serviceType).toBe('UPGRADE');
    expect(body.roomService.fromRoomClass).toBe('Standard');
    expect(body.roomService.toRoomClass).toBe('Deluxe');
    // A NUMBER, not the "300.000" the operator saw.
    expect(body.roomService.price).toBe(300000);

    const table = await screen.findByTestId('room-service-table');
    expect(within(table).getByText('Lê Upgrade')).toBeInTheDocument();
    expect(within(table).getByText('Standard')).toBeInTheDocument();
    expect(within(table).getByText('Deluxe')).toBeInTheDocument();
  });

  it('shows the grouped amount while it is being typed', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('ROOM_SERVICE');
    await userEvent.click(await screen.findByTestId('category-add'));

    const price = await screen.findByTestId('room-service-price');
    await userEvent.type(price, '3150000');
    expect(price).toHaveValue('3.150.000');
  });

  it('the table follows the selected subtype, not every room-service row', async () => {
    const sale = report({
      id: 'rs-sale',
      category: 'ROOM_SERVICE',
      categoryLabel: 'Dịch vụ phòng, KPI',
      complaint: null,
      roomService: {
        serviceType: 'ROOM_SALE',
        serviceTypeLabel: 'Bán phòng',
        guestName: 'Khách Bán Phòng',
        phone: '0900000000',
        roomNumber: null,
        roomClass: 'Deluxe',
        fromRoomClass: null,
        toRoomClass: null,
        serviceName: null,
        price: 850000,
        note: null,
      },
    });
    const laundry = report({
      id: 'rs-laundry',
      category: 'ROOM_SERVICE',
      categoryLabel: 'Dịch vụ phòng, KPI',
      complaint: null,
      roomService: {
        serviceType: 'LAUNDRY',
        serviceTypeLabel: 'Giặt ủi',
        guestName: 'Khách Giặt Ủi',
        phone: null,
        roomNumber: '305',
        roomClass: null,
        fromRoomClass: null,
        toRoomClass: null,
        serviceName: null,
        price: 120000,
        note: null,
      },
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [sale, laundry], counts: { ...EMPTY_COUNTS, ROOM_SERVICE: 2 } },
        }),
      }),
    );
    renderApp('/app/reports');

    // ROOM_SALE is the default subtype selected on entry.
    await openCategory('ROOM_SERVICE');
    let table = await screen.findByTestId('room-service-table');
    expect(within(table).getByText('Khách Bán Phòng')).toBeInTheDocument();
    expect(within(table).queryByText('Khách Giặt Ủi')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('room-service-type-LAUNDRY'));
    table = await screen.findByTestId('room-service-table');
    expect(within(table).getByText('Khách Giặt Ủi')).toBeInTheDocument();
    expect(within(table).queryByText('Khách Bán Phòng')).not.toBeInTheDocument();

    // The totals ("KPI" half of the section) cover every subtype regardless of
    // which one is currently selected — arithmetic on the rows, not a fetch.
    const summary = screen.getByTestId('room-service-summary');
    expect(within(summary).getByTestId('service-total-ROOM_SALE')).toHaveTextContent('850.000');
    expect(within(summary).getByTestId('service-total-LAUNDRY')).toHaveTextContent('120.000');
    expect(screen.getByTestId('service-grand-total')).toHaveTextContent('970.000');
  });
});

describe('vấn đề khách yêu cầu', () => {
  it('suggests the three named items without closing the list', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('category-add'));
    const item = await screen.findByTestId('guest-request-item');

    await userEvent.click(screen.getByTestId('guest-request-suggest-Balo'));
    expect(item).toHaveValue('Balo');

    // Still free text: something not on the list can be typed.
    await userEvent.clear(item);
    await userEvent.type(item, 'Xe đạp');
    expect(item).toHaveValue('Xe đạp');
  });

  it('shows the primary table with the important fields, immediately', async () => {
    let created = false;
    const posted: unknown[] = [];
    const created_row = report({
      id: 'g1',
      category: 'GUEST_REQUEST',
      categoryLabel: 'Vấn đề khách yêu cầu',
      complaint: null,
      guestRequest: {
        itemType: 'Balo',
        guestName: 'Khách ký gửi',
        note: 'Balo đen',
        accepted: false,
        acceptedBy: null,
        acceptedByName: null,
        acceptedAt: null,
        acceptedShiftType: null,
        acceptedShiftName: null,
      },
    });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          created = true;
          return { status: 201, body: { report: created_row } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: created
            ? { reports: [created_row], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    await userEvent.click(await screen.findByTestId('category-add'));
    await userEvent.type(screen.getByTestId('guest-request-item'), 'Balo');
    await userEvent.type(screen.getByTestId('guest-request-guest'), 'Khách ký gửi');
    await userEvent.type(screen.getByTestId('guest-request-note'), 'Balo đen');
    await userEvent.click(screen.getByTestId('guest-request-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));

    const table = await screen.findByTestId('guest-request-table');
    expect(within(table).getByText('Balo')).toBeInTheDocument();
    expect(within(table).getByText('Khách ký gửi')).toBeInTheDocument();
    expect(within(table).getByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(within(table).getByText('Chờ tiếp nhận')).toBeInTheDocument();
  });

  it('offers "Tiếp nhận" on an unaccepted request, and not on an accepted one', async () => {
    const pending = report({
      id: 'g1',
      category: 'GUEST_REQUEST',
      categoryLabel: 'Vấn đề khách yêu cầu',
      complaint: null,
      summary: 'Balo · Khách ký gửi · chờ tiếp nhận',
      guestRequest: {
        itemType: 'Balo',
        guestName: 'Khách ký gửi',
        note: null,
        accepted: false,
        acceptedBy: null,
        acceptedByName: null,
        acceptedAt: null,
        acceptedShiftType: null,
        acceptedShiftName: null,
      },
    });

    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [pending], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    expect(within(table).getByTestId('accept-g1')).toBeInTheDocument();
  });

  it('accepting posts to the server and shows the receiver as a separate fact', async () => {
    let accepted = false;
    const posted: unknown[] = [];
    const base = {
      id: 'g2',
      category: 'GUEST_REQUEST',
      categoryLabel: 'Vấn đề khách yêu cầu',
      complaint: null,
      createdByName: 'Nguyễn A',
    };
    const before = report({
      ...base,
      guestRequest: {
        itemType: 'Balo',
        guestName: 'Khách ký gửi',
        note: null,
        accepted: false,
        acceptedBy: null,
        acceptedByName: null,
        acceptedAt: null,
        acceptedShiftType: null,
        acceptedShiftName: null,
      },
    });
    const after = report({
      ...base,
      guestRequest: {
        itemType: 'Balo',
        guestName: 'Khách ký gửi',
        note: null,
        accepted: true,
        acceptedBy: { id: 3, fullName: 'Lễ tân Hai' },
        acceptedByName: 'Nguyễn B',
        acceptedAt: '2026-09-19T07:02:00.000Z',
        acceptedShiftType: 'B',
        acceptedShiftName: 'Ca B',
      },
    });

    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [accepted ? after : before], counts: { ...EMPTY_COUNTS, GUEST_REQUEST: 1 } },
        }),
        'POST /api/reception/reports/g2/accept': () => {
          accepted = true;
          posted.push(true);
          return { status: 200, body: { report: after } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('GUEST_REQUEST');
    const table = await screen.findByTestId('guest-request-table');
    await userEvent.click(within(table).getByTestId('accept-g2'));

    await waitFor(() => expect(posted).toHaveLength(1));
    const updated = await screen.findByTestId('guest-request-table');
    expect(within(updated).getByText('Nguyễn A')).toBeInTheDocument();
    // "Nguyễn B · Ca B" is one node's direct text (receiver and their shift
    // are one fact, not two), so match it as a substring, not an exact string.
    expect(within(updated).getByText(/Nguyễn B/)).toHaveTextContent('Nguyễn B · Ca B');
    expect(within(updated).queryByTestId('accept-g2')).not.toBeInTheDocument();
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

  it('logging an incident into the shift journal never creates a second incident', async () => {
    let logged = false;
    const posted: Record<string, unknown>[] = [];
    const loggedRow = report({
      id: 'f1',
      category: 'FACILITY_ISSUE',
      categoryLabel: 'Sự cố vật chất đang xử lý',
      complaint: null,
      facility: { issueId: 'i1', issue: { id: 'i1' } },
    });
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
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          logged = true;
          return { status: 201, body: { report: loggedRow } };
        },
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: logged
            ? { reports: [loggedRow], counts: { ...EMPTY_COUNTS, FACILITY_ISSUE: 1 } }
            : { reports: [], counts: EMPTY_COUNTS },
        }),
      }),
    );
    renderApp('/app/reports');

    await openCategory('FACILITY_ISSUE');
    await userEvent.click(await screen.findByTestId('facility-log-i1'));

    await waitFor(() => expect(posted).toHaveLength(1));
    // No description, no area, no technician sent — only a reference.
    expect(posted[0]).toEqual({ category: 'FACILITY_ISSUE', facility: { issueId: 'i1' } });

    // The button reflects that this incident is now in this shift's journal —
    // never a second incident, only the reference.
    expect(await screen.findByText('Đã thêm')).toBeInTheDocument();
    expect(screen.queryByTestId('facility-log-i1')).not.toBeInTheDocument();
  });

  /**
   * RECEPTION'S EXPANDER STAYS ON THE PHONE.
   *
   * `DataTable` grew an opt-in `detailToggle: 'always'` for the Admin's reading
   * screen, where a row is a summary of a record with more to it at any width.
   * Reception did not opt in, and this asserts that from THIS side — a default
   * is only a promise until something checks it.
   */
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
   * the technical department then works. The new incident is on the board as
   * soon as the dialog closes.
   */
  it('reports a new fault through the existing issue form and API, and shows it', async () => {
    let created = false;
    const NEW_ISSUE = {
      id: 'i-new',
      locationLabel: 'Phòng · Phòng 301',
      description: 'Máy lạnh không lạnh',
      status: 'NEW',
      needsRework: false,
      technicianName: null,
      technicianPhone: null,
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

    // Posted to the ONE issue API, not a reception-specific one.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/issues' && (init as RequestInit).method === 'POST',
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/reception/reports' && (init as RequestInit)?.method === 'POST',
      ),
    ).toBe(false);

    // Closed, and the new incident is on the board.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const board = await screen.findByTestId('facility-board');
    expect(await within(board).findByText('Máy lạnh không lạnh')).toBeInTheDocument();
  });

  /** Sự cố | Khu vực | Trạng thái | Người báo | Thời gian | Kỹ thuật | Cập nhật, in that order. */
  it('lays the incidents out as a compact table with the specified columns', async () => {
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
    expect(within(board).getByText('Nguyễn Văn A')).toBeInTheDocument();
    const headers = within(board)
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '');
    const wanted = ['Sự cố', 'Khu vực', 'Trạng thái', 'Người báo', 'Thời gian', 'Kỹ thuật', 'Cập nhật'];
    expect(wanted.map((w) => headers.indexOf(w))).toEqual(
      [...wanted.map((w) => headers.indexOf(w))].sort((a, b) => a - b),
    );
    for (const w of wanted) expect(headers).toContain(w);
  });

  it('shows an empty state when nothing is outstanding', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/reports');
    await openCategory('FACILITY_ISSUE');
    expect(await screen.findByTestId('facility-board-empty')).toBeInTheDocument();
  });
});

describe('sửa và hủy bản ghi trong bảng chính', () => {
  it('edits in a dialog, keeping the change history', async () => {
    let updated = false;
    const posted: unknown[] = [];
    const before = report();
    const after = report({ complaint: { guestName: 'Trần Thị B', location: '202', description: 'Đã sửa mô tả' } });
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: {
            reports: [updated ? after : before],
            counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 },
          },
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
    await userEvent.click(within(table).getByTestId('edit-r1'));

    const dialog = await screen.findByTestId('record-edit-description');
    await userEvent.clear(dialog);
    await userEvent.type(dialog, 'Đã sửa mô tả');
    await userEvent.click(screen.getByTestId('record-edit-save'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(await screen.findByText('Đã sửa mô tả')).toBeInTheDocument();
  });

  it('voiding requires a reason and says plainly that nothing is deleted', async () => {
    const posted: unknown[] = [];
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/reports?shiftSessionId=s1': () => ({
          status: 200,
          body: { reports: [report()], counts: { ...EMPTY_COUNTS, CUSTOMER_COMPLAINT: 1 } },
        }),
        'POST /api/reception/reports/r1/void': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: report({ voided: true, voidReason: 'Nhập nhầm' }) } };
        },
      }),
    );
    renderApp('/app/reports');

    await openCategory('CUSTOMER_COMPLAINT');
    const table = await screen.findByTestId('service-quality-table');
    await userEvent.click(within(table).getByTestId('void-r1'));

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
