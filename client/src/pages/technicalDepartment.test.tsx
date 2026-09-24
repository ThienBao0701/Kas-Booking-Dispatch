/**
 * The Hotel Technical Department screens, and the dynamic incident form.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The report form CHANGES WITH THE AREA — a room asks for a room number, a
 *      hallway asks for a floor, the lobby asks for a fixture, and none of them
 *      asks for the others.
 *   2. Bộ phận kỹ thuật has three queues, each a workflow state, and accepting
 *      one always names the technician doing the work.
 *   3. The Admin screen shows the same information and NO action buttons.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, TECHNICAL_USER, installApiMock, renderApp } from '../test/utils';
import { hcmToday } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion Boutique Hotel', address: '05 Trương Định' };

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    branchId: 1,
    branch: BRANCH,
    areaCategory: 'ROOM',
    roomNumber: '301',
    floorNumber: null,
    areaSubtype: null,
    locationDetail: null,
    locationLabel: 'Phòng · Phòng 301',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không lạnh',
    photoUrl: null,
    status: 'NEW',
    reportedBy: { id: 2, fullName: 'Lễ tân Một' },
    reportedByName: 'Lễ tân Một',
    acceptedBy: null,
    acceptedByName: null,
    acceptedAt: null,
    technicianName: null,
    technicianPhone: null,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    createdAt: '2026-09-17T02:00:00.000Z',
    updatedAt: '2026-09-17T02:00:00.000Z',
    // The server ALWAYS sends these; a fixture that omits them describes a
    // response the API cannot produce.
    shiftType: null,
    shiftReceptionistName: null,
    durationSeconds: null,
    durationLabel: null,
    attempts: [],
    cannotRepairCount: 0,
    needsRework: false,
    ...over,
  };
}

const listBody = (issues: unknown[]) => ({
  status: 200,
  body: { issues, pagination: { page: 1, pageSize: 100, total: issues.length, totalPages: 1 } },
});

const SUMMARY = {
  status: 200,
  body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
};
const BADGES = {
  status: 200,
  body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
};

/** A receptionist already checked in, so the shift gate never interrupts. */
const SHIFT_SESSION = {
  status: 200,
  body: {
    session: {
      id: 's1',
      branchId: 1,
      shiftType: 'A',
      shiftName: 'Ca A',
      shiftWindow: '06:00 – 14:00',
      receptionistName: 'Nguyễn Văn A',
      startedAt: '2026-09-16T23:00:00.000Z',
      nominalEndAt: '2026-09-17T07:00:00.000Z',
      graceEndAt: '2026-09-17T07:10:00.000Z',
      closedAt: null,
      promptDue: false,
    },
  },
};

/* -------------------------------------------------------------------------- */
/* The dynamic report form                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The report form lives in "Báo cáo vấn đề" → "Sự cố vật chất đang xử lý" now;
 * the old address still lands there.
 */
async function openReportForm() {
  const user = userEvent.setup();
  renderApp('/app/issues');
  await user.click(await screen.findByRole('button', { name: /Báo cáo sự cố/ }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

function receptionRoutes(onCreate?: (body: FormData) => void) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => SUMMARY,
    'GET /api/nav-badges': () => BADGES,
    'GET /api/reception/shifts/current': () => SHIFT_SESSION,
    'GET /api/issues?pageSize=100&outstanding=true': () => listBody([]),
    'GET /api/reception/reports/options': () => ({
      status: 200,
      body: { categories: [], paymentMethods: [], roomServiceTypes: [], guestRequestItems: [] },
    }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({ status: 200, body: { reports: [], counts: {} } }),
    'POST /api/issues': (init: RequestInit) => {
      onCreate?.(init.body as FormData);
      return { status: 201, body: { issue: issue() } };
    },
  };
}

describe('the incident form changes with the area', () => {
  it('PHÒNG asks for a room number and a fault type, and no floor', async () => {
    installApiMock(receptionRoutes());
    const { dialog } = await openReportForm();

    // ROOM is the initial area.
    expect(within(dialog).getByLabelText('Sự cố')).toHaveValue('ROOM');
    expect(within(dialog).getByText('Số phòng')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Loại sự cố')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số tầng')).not.toBeInTheDocument();
  });

  it('KHU VỰC SẢNH asks for a fixture, and NOT a room number', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'LOBBY');

    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Số tầng')).not.toBeInTheDocument();

    // Exactly the subtypes the specification lists.
    const select = within(dialog).getByLabelText('Loại sự cố');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['— Chọn —', 'Quầy lễ tân', 'Sofa', 'Nền nhà', 'Trần nhà', 'Bóng đèn', 'Đồng hồ', 'Khác']);
  });

  it('KHU VỰC HÀNH LANG asks for a floor, and no room or fault type', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'HALLWAY');

    expect(within(dialog).getByText('Số tầng')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Loại sự cố')).not.toBeInTheDocument();
  });

  it('KHU VỰC CẦU THANG asks for a floor', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'STAIRCASE');

    expect(within(dialog).getByText('Số tầng')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
  });

  it('offers every area the specification names', async () => {
    installApiMock(receptionRoutes());
    const { dialog } = await openReportForm();

    const options = within(within(dialog).getByLabelText('Sự cố'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Phòng',
      'Khu Vực Sảnh',
      'Khu Vực Hành Lang',
      'Khu Vực Cầu Thang',
      'Khu Vực Nhà Hàng',
      'Khu Vực Rooftop',
      'Các Khu Vực Còn Lại',
    ]);
  });
});

describe('the form will not submit an incomplete report', () => {
  it('needs a description, always', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    const send = within(dialog).getByRole('button', { name: 'Gửi báo cáo' });
    await user.type(within(dialog).getByText('Số phòng').querySelector('input')!, '301');
    expect(send).toBeDisabled();

    // Whitespace is not a description.
    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), '   ');
    expect(send).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Máy lạnh không lạnh');
    expect(send).toBeEnabled();
  });

  it('needs a room number for a room incident', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Máy lạnh không lạnh');
    // Description alone is not enough while the area asks for a room.
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText('Số phòng').querySelector('input')!, '301');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  it('needs a floor for a hallway incident', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'HALLWAY');
    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Đèn cháy');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText('Số tầng').querySelector('input')!, '3');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  it('needs a location detail for "Các Khu Vực Còn Lại"', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'OTHER_AREA');
    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Hỏng');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText(/Vị trí cụ thể/).querySelector('input')!, 'Kho tầng hầm');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  /** Only the fields the chosen area uses are sent. */
  it('sends the area and its own fields', async () => {
    let sent: FormData | null = null;
    installApiMock(receptionRoutes((b) => (sent = b)));
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Sự cố'), 'HALLWAY');
    await user.type(within(dialog).getByText('Số tầng').querySelector('input')!, '3');
    await user.type(within(dialog).getByLabelText('Mô tả sự cố'), 'Đèn hành lang cháy');
    await user.click(within(dialog).getByRole('button', { name: 'Gửi báo cáo' }));

    expect(sent).not.toBeNull();
    const form = sent as unknown as FormData;
    expect(form.get('areaCategory')).toBe('HALLWAY');
    expect(form.get('floorNumber')).toBe('3');
    expect(form.get('description')).toBe('Đèn hành lang cháy');
    // A hallway report carries neither of these.
    expect(form.get('roomNumber')).toBeNull();
    expect(form.get('category')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The Technical queues                                                       */
/* -------------------------------------------------------------------------- */

function technicalRoutes(
  over: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: TECHNICAL_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => SUMMARY,
    'GET /api/nav-badges': () => BADGES,
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/issues/counts': () => ({
      status: 200,
      body: { counts: { newCount: 2, inProgressCount: 1, completedCount: 5 } },
    }),
    'GET /api/issues?status=NEW&pageSize=100': () => listBody([issue()]),
    'GET /api/issues?status=IN_PROGRESS&pageSize=100': () =>
      listBody([issue({ id: 'i2', status: 'IN_PROGRESS', technicianName: 'Trần Văn B', technicianPhone: '0901234567', acceptedAt: '2026-09-17T03:00:00.000Z' })]),
    'GET /api/issues?status=COMPLETED&pageSize=100': () => listBody([]),
    ...over,
  };
}

describe('Bộ phận kỹ thuật works three queues', () => {
  it('shows the three workflow states with server-side counts', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');

    const tabNew = await screen.findByTestId('technical-tab-new');
    expect(tabNew).toHaveTextContent('Sự cố khách sạn');
    // The counts arrive from their own query, so the number is awaited.
    await waitFor(() => expect(tabNew).toHaveTextContent('2'));
    expect(screen.getByTestId('technical-tab-in-progress')).toHaveTextContent('Đang sửa');
    expect(screen.getByTestId('technical-tab-in-progress')).toHaveTextContent('1');
    expect(screen.getByTestId('technical-tab-completed')).toHaveTextContent('Đã hoàn thành');
    expect(screen.getByTestId('technical-tab-completed')).toHaveTextContent('5');
  });

  it('shows the incident with its branch, location and reporter', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');

    // Scoped to the queue: the branch name also appears in the branch filter.
    const queue = await screen.findByRole('list', { name: 'Sự cố khách sạn' });
    expect(within(queue).getByText('Phòng · Phòng 301')).toBeInTheDocument();
    expect(within(queue).getByText('05 Trương Định')).toBeInTheDocument();
    expect(within(queue).getByText(/Lễ tân Một/)).toBeInTheDocument();
  });

  /**
   * ACCEPTING NAMES THE PERSON DOING THE WORK. Both fields are required, so an
   * IN_PROGRESS incident can never fail to say who is fixing it.
   */
  it('requires a technician name and phone before accepting', async () => {
    let sent: unknown = null;
    installApiMock(
      technicalRoutes({
        'POST /api/issues/i1/accept': (init: RequestInit) => {
          sent = JSON.parse(String(init.body));
          return { status: 200, body: { issue: issue({ status: 'IN_PROGRESS' }) } };
        },
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/technical/new');

    await user.click(await screen.findByTestId('accept-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Tiếp nhận sự cố' });
    const confirm = within(dialog).getByTestId('accept-confirm');

    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByTestId('technician-name'), 'Trần Văn B');
    expect(confirm).toBeDisabled(); // a name but no phone
    await user.type(within(dialog).getByTestId('technician-phone'), '0901234567');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(sent).toEqual({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
  });

  it('shows the technician on an incident being worked, and offers completion', async () => {
    let completed = false;
    installApiMock(
      technicalRoutes({
        'POST /api/issues/i2/complete': () => {
          completed = true;
          return { status: 200, body: { issue: issue({ id: 'i2', status: 'COMPLETED' }) } };
        },
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    expect(await screen.findByText('Trần Văn B')).toBeInTheDocument();
    expect(screen.getByText('0901234567')).toBeInTheDocument();

    await user.click(screen.getByTestId('complete-i2'));
    expect(completed).toBe(true);
  });

  it('offers no completion on an incident nobody accepted', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');

    await screen.findByTestId('accept-i1');
    // NEW offers "Tiếp nhận" only — COMPLETED is reachable only from IN_PROGRESS.
    expect(screen.queryByTestId('complete-i1')).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* The Admin monitor                                                          */
/* -------------------------------------------------------------------------- */

describe('the Admin monitors and does not act', () => {
  const adminRoutes = {
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => SUMMARY,
    'GET /api/nav-badges': () => BADGES,
    'GET /api/admin/branches': () => ({ status: 200, body: { branches: [] } }),
    // The old address lands on the incident category: every branch, today.
    [`GET /api/issues?from=${hcmToday()}&to=${hcmToday()}&pageSize=100`]: () =>
      listBody([
        issue({
          status: 'IN_PROGRESS',
          technicianName: 'Trần Văn B',
          technicianPhone: '0901234567',
          acceptedAt: '2026-09-17T03:00:00.000Z',
        }),
      ]),
  };

  /**
   * THE BUTTONS ARE GONE, AND THAT IS THE POINT.
   *
   * An Admin used to press these, which recorded an administrator as having done
   * maintenance work. The API refuses them now; this asserts the UI agrees.
   */
  it('shows no accept or complete buttons', async () => {
    installApiMock(adminRoutes);
    renderApp('/app/issues');

    await screen.findByText('Trần Văn B');
    expect(screen.queryByRole('button', { name: 'Tiếp nhận' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hoàn thành/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đã xử lý' })).not.toBeInTheDocument();
  });

  it('shows the technician, the phone and the timestamps', async () => {
    installApiMock(adminRoutes);
    renderApp('/app/issues');

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Trần Văn B')).toBeInTheDocument();
    expect(within(table).getByText('0901234567')).toBeInTheDocument();
    expect(within(table).getByText('Lễ tân Một')).toBeInTheDocument();
    // The status is a badge, not an action.
    expect(within(table).getByText('Đang sửa')).toBeInTheDocument();
  });

  it('offers an incident report export over a date range', async () => {
    installApiMock(adminRoutes);
    const user = userEvent.setup();
    renderApp('/app/issues');

    await user.click(await screen.findByRole('button', { name: /Xuất báo cáo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Xuất báo cáo sự cố' });
    // The same one-control date range the dashboard and History use.
    expect(within(dialog).getByRole('group', { name: 'Khoảng thời gian' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('incident-export-confirm')).toBeEnabled();
  });
});
