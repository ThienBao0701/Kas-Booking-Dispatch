/**
 * "GIAO NHẬN HÀNG HÓA CỦA KHÁCH SẠN" — the reception category, "Hoàn thành vấn đề",
 * and the two departments' read-only view.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The form asks Bộ phận (three departments), Tên hàng hóa and Số lượng — a
 *      NUMBER: it will not submit a blank, zero, fraction or text quantity.
 *   2. Submitting posts one record and offers no status to fill in: it is stored
 *      as "Đã hoàn thành".
 *   3. The overview and the category screen show STT · Bộ phận · Tên hàng hóa ·
 *      Số lượng · Trạng thái, read from the branch-wide active list.
 *   4. "Hoàn thành vấn đề" holds a dedicated "Giao nhận hàng hóa của khách sạn"
 *      table read from the ARCHIVED side of the server's split.
 *   5. Technical and Housekeeping see the same rows, read-only, with no form and
 *      no action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  HOUSEKEEPING_USER,
  RECEPTIONIST_USER,
  TECHNICAL_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPTIONS = {
  categories: [
    { code: 'PAYMENT', label: 'Theo dõi thanh toán' },
    { code: 'GUEST_REQUEST', label: 'Vấn đề khách yêu cầu' },
    { code: 'FACILITY_ISSUE', label: 'Sự cố vật chất đang xử lý' },
    { code: 'CUSTOMER_COMPLAINT', label: 'Vấn đề về chất lượng và dịch vụ' },
    { code: 'ROOM_SERVICE', label: 'Dịch vụ phòng, KPI' },
    { code: 'HOTEL_DELIVERY', label: 'Giao nhận hàng hóa' },
  ],
  paymentMethods: [{ code: 'CASH', label: 'Tiền mặt' }],
  roomServiceTypes: [],
  paymentSources: ['Booking'],
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

function delivery(id: string, over: Record<string, unknown> = {}, archived = false) {
  return {
    id,
    category: 'HOTEL_DELIVERY',
    categoryLabel: 'Giao nhận hàng hóa',
    branchId: 1,
    branch: { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 },
    shiftSessionId: 's1',
    shiftType: 'A',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    shiftDate: '2026-09-19',
    shiftReceptionistName: 'Nguyễn Văn A',
    shiftClosed: false,
    createdBy: { id: 2, fullName: 'Lễ tân Một' },
    createdByName: 'Nguyễn Văn A',
    createdAt: '2026-09-19T01:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z',
    summary: 'Buồng phòng · Khăn tắm · SL 24',
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    payment: null,
    guestRequest: null,
    facility: null,
    complaint: null,
    roomService: null,
    delivery: {
      department: 'HOUSEKEEPING',
      departmentLabel: 'Buồng phòng',
      itemName: 'Khăn tắm',
      quantity: 24,
      note: null,
      status: 'COMPLETED',
      statusLabel: 'Đã hoàn thành',
      completedAt: '2026-09-19T01:00:00.000Z',
      archived,
      title: 'Giao nhận hàng hóa của khách sạn',
      ...((over.delivery as Record<string, unknown> | undefined) ?? {}),
    },
    audits: [],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'delivery')),
  };
}

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function receptionRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
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
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: SESSION } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reception/reports/options': () => ({ status: 200, body: OPTIONS }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({ status: 200, body: { reports: [], counts: EMPTY_COUNTS } }),
    'GET /api/reception/shifts/cash': () => ({
      status: 200,
      body: {
        cash: {
          openingCash: null,
          cashCollected: 0,
          transferCollected: 0,
          cardCollected: 0,
          receivable: 0,
          cashExpense: 0,
          endingCash: null,
          paymentCount: 0,
          voidedCount: 0,
        },
      },
    }),
    'GET /api/issues?pageSize=100&outstanding=true': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 } },
    }),
    'GET /api/hotel-deliveries?scope=active': () => ({
      status: 200,
      body: { scope: 'active', deliveries: [delivery('d1'), delivery('d2', { delivery: { itemName: 'Bóng đèn', department: 'TECHNICAL', departmentLabel: 'Kỹ thuật', quantity: 5 } })] },
    }),
    'GET /api/hotel-deliveries?scope=archived': () => ({
      status: 200,
      body: { scope: 'archived', deliveries: [delivery('d9', { delivery: { itemName: 'Ga giường', quantity: 8 } }, true)] },
    }),
    ...extra,
  };
}

async function openMenu() {
  await userEvent.click(await screen.findByTestId('report-total'));
  return screen.findByTestId('category-menu');
}

async function openDeliveryCategory() {
  await userEvent.click(within(await openMenu()).getByTestId('category-HOTEL_DELIVERY'));
  return screen.findByTestId('category-view');
}

describe('the sixth category, in the reception journal', () => {
  it('is on the overview as its own section, after the five, under its full name', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');

    const overview = await screen.findByTestId('report-overview');
    const section = await within(overview).findByTestId('delivery-table');
    expect(within(section).getAllByRole('heading')[0]).toHaveTextContent('Giao nhận hàng hóa của khách sạn');
    const rooms = within(overview).getByTestId('room-service-overview');
    expect(rooms.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The section's own numeral, VI, like the official report.
    expect(within(section).getByText('VI')).toBeInTheDocument();
  });

  it('lists STT · Bộ phận · Tên hàng hóa · Số lượng · Trạng thái, from the active list', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');
    await openDeliveryCategory();

    const table = await screen.findByTestId('delivery-table');
    expect(await within(table).findByText('Khăn tắm')).toBeInTheDocument();
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '')
      .filter((h) => h !== '');
    expect(headers.slice(0, 5)).toEqual(['STT', 'Bộ phận', 'Tên hàng hóa', 'Số lượng', 'Trạng thái']);

    const row = within(table).getByTestId('row-d1');
    expect(within(row).getByText('Buồng phòng')).toBeInTheDocument();
    expect(within(row).getByText('24')).toBeInTheDocument();
    expect(within(row).getByText('Đã hoàn thành')).toBeInTheDocument();
    expect(within(table).getByTestId('row-d2')).toHaveTextContent('Kỹ thuật');
  });
});

describe('the entry form', () => {
  async function openForm() {
    await openDeliveryCategory();
    await userEvent.click(await screen.findByTestId('category-add'));
    return screen.findByTestId('delivery-form');
  }

  it('asks for the department, the item and a numeric quantity — and states the default status', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');
    const form = await openForm();

    const department = within(form).getByTestId('delivery-department');
    expect(within(department).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '— Chọn bộ phận —',
      'Lễ tân',
      'Buồng phòng',
      'Kỹ thuật',
    ]);
    const quantity = within(form).getByTestId('delivery-quantity');
    expect(quantity).toHaveAttribute('type', 'number');
    expect(quantity).toHaveAttribute('min', '1');
    expect(within(form).getByTestId('delivery-item')).toBeInTheDocument();
    expect(within(form).getByTestId('delivery-status-hint')).toHaveTextContent('Đã hoàn thành');
    // There is nothing to choose for the status.
    expect(within(form).queryByLabelText('Trạng thái')).not.toBeInTheDocument();
  });

  it.each([
    ['blank', ''],
    ['zero', '0'],
    ['a fraction', '1.5'],
    ['a negative', '-2'],
  ])('will not submit %s as a quantity', async (_label, quantity) => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');
    const form = await openForm();

    await userEvent.selectOptions(within(form).getByTestId('delivery-department'), 'HOUSEKEEPING');
    await userEvent.type(within(form).getByTestId('delivery-item'), 'Khăn');
    if (quantity) await userEvent.type(within(form).getByTestId('delivery-quantity'), quantity);
    expect(within(form).getByTestId('delivery-form-add')).toBeDisabled();
  });

  it('will not submit without a department or an item', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');
    const form = await openForm();

    await userEvent.type(within(form).getByTestId('delivery-quantity'), '3');
    expect(within(form).getByTestId('delivery-form-add')).toBeDisabled();
    await userEvent.selectOptions(within(form).getByTestId('delivery-department'), 'RECEPTION');
    expect(within(form).getByTestId('delivery-form-add')).toBeDisabled();
    await userEvent.type(within(form).getByTestId('delivery-item'), 'Bút');
    expect(within(form).getByTestId('delivery-form-add')).toBeEnabled();
  });

  it('posts the record with the quantity as a number, and closes', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock(
      receptionRoutes({
        'POST /api/reception/reports': (init) => {
          posted.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: delivery('d-new') } };
        },
      }),
    );
    renderApp('/app/reports');
    const form = await openForm();

    await userEvent.selectOptions(within(form).getByTestId('delivery-department'), 'TECHNICAL');
    await userEvent.type(within(form).getByTestId('delivery-item'), '  Bóng đèn LED  ');
    await userEvent.type(within(form).getByTestId('delivery-quantity'), '12');
    await userEvent.type(within(form).getByTestId('delivery-note'), 'Giao tầng 3');
    await userEvent.click(within(form).getByTestId('delivery-form-add'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      category: 'HOTEL_DELIVERY',
      delivery: { department: 'TECHNICAL', itemName: 'Bóng đèn LED', quantity: 12, note: 'Giao tầng 3' },
    });
    await waitFor(() => expect(screen.queryByTestId('delivery-form')).not.toBeInTheDocument());
  });
});

describe('correcting a delivery', () => {
  it('edits department, item and quantity through the shared record dialog', async () => {
    const patched: Record<string, unknown>[] = [];
    installApiMock(
      receptionRoutes({
        'PATCH /api/reception/reports/d1': (init) => {
          patched.push(JSON.parse(String(init.body)));
          return { status: 200, body: { report: delivery('d1') } };
        },
      }),
    );
    renderApp('/app/reports');
    await openDeliveryCategory();

    await userEvent.click(await screen.findByTestId('edit-d1'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('record-edit-department')).toHaveValue('HOUSEKEEPING');
    await userEvent.selectOptions(within(dialog).getByTestId('record-edit-department'), 'RECEPTION');
    const quantity = within(dialog).getByTestId('record-edit-quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '30');
    await userEvent.click(within(dialog).getByTestId('record-edit-save'));

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ delivery: { department: 'RECEPTION', itemName: 'Khăn tắm', quantity: 30 } });
  });
});

describe('"Hoàn thành vấn đề"', () => {
  it('is the last item of the menu, and opens a dedicated delivery table from the archived list', async () => {
    const seen: string[] = [];
    installApiMock(
      receptionRoutes({
        'GET /api/hotel-deliveries?scope=archived': () => {
          seen.push('archived');
          return {
            status: 200,
            body: { scope: 'archived', deliveries: [delivery('d9', { delivery: { itemName: 'Ga giường', quantity: 8 } }, true)] },
          };
        },
      }),
    );
    renderApp('/app/reports');

    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items[items.length - 1]).toHaveTextContent('Hoàn thành vấn đề');

    await userEvent.click(within(menu).getByTestId('category-COMPLETED'));
    const view = await screen.findByTestId('completed-issues');
    expect(screen.getByTestId('category-view')).toContainElement(view);
    expect(within(screen.getByTestId('category-view')).getByRole('heading', { level: 2, name: 'Hoàn thành vấn đề' })).toBeInTheDocument();

    const table = await within(view).findByTestId('completed-delivery-table');
    expect(within(table).getAllByRole('heading')[0]).toHaveTextContent('Giao nhận hàng hóa của khách sạn');
    expect(await within(table).findByText('Ga giường')).toBeInTheDocument();
    // The archive is read-only, and holds only what the server put on that side.
    expect(within(table).queryByText('Khăn tắm')).not.toBeInTheDocument();
    expect(within(table).queryByTestId('edit-d9')).not.toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(0);
    // The 12 comes from the server.
    expect(view).toHaveTextContent('12 giờ');
  });

  it('marks itself in the menu, and "Tổng" goes back to the overview', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/reports');
    await userEvent.click(within(await openMenu()).getByTestId('category-COMPLETED'));
    await screen.findByTestId('completed-issues');

    const menu = await openMenu();
    const checked = within(menu).getAllByRole('menuitemradio').filter((i) => i.getAttribute('aria-checked') === 'true');
    expect(checked.map((i) => i.textContent)).toEqual(['Hoàn thành vấn đề']);
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByTestId('report-total-overview'));
    expect(await screen.findByTestId('report-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('completed-issues')).not.toBeInTheDocument();
  });
});

describe('what Technical and Housekeeping see', () => {
  function departmentRoutes(user: unknown, seen: string[]): Record<string, Handler> {
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
      'GET /api/hotel-deliveries?scope=active': () => {
        seen.push('active');
        return { status: 200, body: { scope: 'active', deliveries: [delivery('t1', { delivery: { itemName: 'Ống nước', department: 'TECHNICAL', departmentLabel: 'Kỹ thuật', quantity: 4 } })] } };
      },
      'GET /api/hotel-deliveries?scope=archived': () => {
        seen.push('archived');
        return { status: 200, body: { scope: 'archived', deliveries: [] } };
      },
    };
  }

  it('shows Technical the deliveries the server scoped to it — read-only, active and archived', async () => {
    const seen: string[] = [];
    installApiMock(departmentRoutes(TECHNICAL_USER, seen));
    renderApp('/app/deliveries');

    const active = await screen.findByTestId('department-delivery-active');
    expect(await within(active).findByText('Ống nước')).toBeInTheDocument();
    expect(screen.getByTestId('department-delivery-archived')).toBeInTheDocument();
    expect(within(active).queryByRole('button', { name: /Sửa|Hủy/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-add')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Giao nhận hàng hóa' })).toBeInTheDocument();
    expect(seen).toEqual(expect.arrayContaining(['active', 'archived']));
  });

  it('shows Housekeeping the same page, in its own menu', async () => {
    installApiMock(departmentRoutes(HOUSEKEEPING_USER, []));
    renderApp('/app/deliveries');
    expect(await screen.findByTestId('department-delivery-active')).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Kiểm tra phòng', 'Giao nhận hàng hóa']);
  });

  it('refuses the page to Reception — it has the journal instead', async () => {
    installApiMock(receptionRoutes());
    renderApp('/app/deliveries');
    expect(await screen.findByText('Không có quyền truy cập')).toBeInTheDocument();
  });
});
