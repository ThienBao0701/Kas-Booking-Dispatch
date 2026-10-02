/**
 * The Hotel Technical Department screens, and the dynamic incident form.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The report form CHANGES WITH THE AREA — a room asks for a room number, a
 *      hallway asks for a floor, the lobby asks for a fixture, and none of them
 *      asks for the others.
 *   2. Bộ phận kỹ thuật has a queue per workflow stage and accepting one
 *      always names the technician doing the work. WHILE INSPECTION IS DORMANT
 *      (the default) "Hoàn thành" asks "Tình trạng vấn đề" — finished, or one
 *      stage of several — and there is no "Chờ nghiệm thu" queue; with
 *      inspection switched on, finishing records a result and sends the
 *      incident to "Chờ nghiệm thu".
 *   3. Quản lý kỹ thuật no longer has the temporary "Nghiệm thu" screen: an
 *      old queue link lands on its incident workspace.
 *   4. The Admin screen shows the same information and NO action buttons.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  RECEPTIONIST_USER,
  TECHNICAL_MANAGER_USER,
  TECHNICAL_USER,
  installApiMock,
  renderApp,
} from '../test/utils';
import { withLifecycle } from '../test/issueFixtures';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion Boutique Hotel', address: '05 Trương Định' };

function issue(over: Record<string, unknown> = {}) {
  return withLifecycle({
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
  });
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
 * The report form lives in "Báo cáo vấn đề" → "Sự cố cơ sở vật chất đang xử lý" now;
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
    'GET /api/issues?scope=active&pageSize=100': () => listBody([]),
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
    expect(within(dialog).getByLabelText('Khu vực')).toHaveValue('ROOM');
    expect(within(dialog).getByText('Số phòng')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Loại sự cố')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số tầng')).not.toBeInTheDocument();
  });

  it('KHU VỰC SẢNH asks for a fixture, and NOT a room number', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'LOBBY');

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

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'HALLWAY');

    expect(within(dialog).getByText('Số tầng')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Loại sự cố')).not.toBeInTheDocument();
  });

  it('KHU VỰC CẦU THANG asks for a floor', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'STAIRCASE');

    expect(within(dialog).getByText('Số tầng')).toBeInTheDocument();
    expect(within(dialog).queryByText('Số phòng')).not.toBeInTheDocument();
  });

  it('offers every area the specification names', async () => {
    installApiMock(receptionRoutes());
    const { dialog } = await openReportForm();

    const options = within(within(dialog).getByLabelText('Khu vực'))
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
    await user.type(within(dialog).getByLabelText('Sự cố'), '   ');
    expect(send).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Sự cố'), 'Máy lạnh không lạnh');
    expect(send).toBeEnabled();
  });

  it('needs a room number for a room incident', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.type(within(dialog).getByLabelText('Sự cố'), 'Máy lạnh không lạnh');
    // Description alone is not enough while the area asks for a room.
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText('Số phòng').querySelector('input')!, '301');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  it('needs a floor for a hallway incident', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'HALLWAY');
    await user.type(within(dialog).getByLabelText('Sự cố'), 'Đèn cháy');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText('Số tầng').querySelector('input')!, '3');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  it('needs a location detail for "Các Khu Vực Còn Lại"', async () => {
    installApiMock(receptionRoutes());
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'OTHER_AREA');
    await user.type(within(dialog).getByLabelText('Sự cố'), 'Hỏng');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeDisabled();

    await user.type(within(dialog).getByText(/Vị trí cụ thể/).querySelector('input')!, 'Kho tầng hầm');
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
  });

  /** Only the fields the chosen area uses are sent. */
  it('sends the area and its own fields', async () => {
    let sent: FormData | null = null;
    installApiMock(receptionRoutes((b) => (sent = b)));
    const { user, dialog } = await openReportForm();

    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'HALLWAY');
    await user.type(within(dialog).getByText('Số tầng').querySelector('input')!, '3');
    await user.type(within(dialog).getByLabelText('Sự cố'), 'Đèn hành lang cháy');
    await user.click(within(dialog).getByRole('button', { name: 'Gửi báo cáo' }));

    expect(sent).not.toBeNull();
    const form = sent as unknown as FormData;
    expect(form.get('areaCategory')).toBe('HALLWAY');
    expect(form.get('floorNumber')).toBe('3');
    expect(form.get('description')).toBe('Đèn hành lang cháy');
    // A hallway report carries neither of these.
    expect(form.get('roomNumber')).toBeNull();
    expect(form.get('category')).toBeNull();
    // No cause typed, none sent — it is optional.
    expect(form.get('cause')).toBeNull();
  });

  /** "Nguyên nhân" is optional, and sent when Reception already knows it. */
  it('sends the cause when one is given, and never requires it', async () => {
    let sent: FormData | null = null;
    installApiMock(receptionRoutes((b) => (sent = b)));
    const { user, dialog } = await openReportForm();

    await user.type(within(dialog).getByText('Số phòng').querySelector('input')!, '305');
    await user.type(within(dialog).getByLabelText('Sự cố'), 'Máy lạnh không lạnh');
    // Ready without a cause…
    expect(within(dialog).getByRole('button', { name: 'Gửi báo cáo' })).toBeEnabled();
    // …and the cause goes with the report when there is one.
    await user.type(within(dialog).getByLabelText('Nguyên nhân'), 'Thiếu gas');
    await user.click(within(dialog).getByRole('button', { name: 'Gửi báo cáo' }));

    const form = sent as unknown as FormData;
    expect(form.get('description')).toBe('Máy lạnh không lạnh');
    expect(form.get('cause')).toBe('Thiếu gas');
  });
});

describe('structured floors and the duplicate warning', () => {
  it('chooses a hallway floor from the branch’s floor catalog', async () => {
    installApiMock({
      ...receptionRoutes(),
      'GET /api/branches/1/rooms': () => ({ status: 200, body: { branchId: 1, rooms: ['301'], floors: ['1', '2', '3'] } }),
    });
    const { user, dialog } = await openReportForm();
    await user.selectOptions(within(dialog).getByLabelText('Khu vực'), 'HALLWAY');
    const floor = await within(dialog).findByTestId('issue-floor');
    expect(within(floor).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Chọn tầng —', 'Tầng 1', 'Tầng 2', 'Tầng 3']);
  });

  /**
   * "CÓ THỂ BỊ TRÙNG": a match on the structured key warns, with the match in
   * full; "Hủy / quay lại" sends nothing, "Vẫn gửi báo cáo" sends.
   */
  it('warns of a possible duplicate at "Gửi báo cáo", and sends only on "Vẫn gửi báo cáo"', async () => {
    let sent: FormData | null = null;
    const open = issue({
      id: 'dup1',
      reporterName: 'Lễ tân Hai',
      cause: 'Thiếu gas',
      assignmentStateLabel: 'Đang sửa',
      assignedTechnician: { id: 4, name: 'Kỹ thuật viên trực' },
      shiftType: 'A',
    });
    installApiMock({
      ...receptionRoutes((b) => (sent = b)),
      'GET /api/issues/similar?areaCategory=ROOM&roomNumber=305&category=AIR_CONDITIONER': () => ({
        status: 200,
        body: { open: [open], recent: [] },
      }),
    });
    const { user, dialog } = await openReportForm();
    await user.type(within(dialog).getByText('Số phòng').querySelector('input')!, '305');
    await user.type(within(dialog).getByLabelText('Sự cố'), 'Máy lạnh không lạnh');
    await user.click(within(dialog).getByTestId('issue-submit'));

    const warning = await within(dialog).findByTestId('similar-issues');
    expect(warning).toHaveTextContent('Vấn đề này có thể bị trùng với một vấn đề đã được báo cáo.');
    expect(warning).toHaveTextContent('Bạn chắc chắn muốn gửi báo cáo này chứ?');
    expect(warning).toHaveTextContent('Lễ tân Hai');
    expect(warning).toHaveTextContent('Thiếu gas');
    expect(warning).toHaveTextContent('Kỹ thuật viên trực');
    expect(warning).toHaveTextContent('Ca A');
    expect(sent).toBeNull();

    await user.click(within(dialog).getByTestId('duplicate-back'));
    expect(within(dialog).queryByTestId('similar-issues')).not.toBeInTheDocument();
    expect(sent).toBeNull();

    await user.click(within(dialog).getByTestId('issue-submit'));
    await user.click(await within(dialog).findByTestId('duplicate-send'));
    await waitFor(() => expect(sent).not.toBeNull());
  });
});

/* -------------------------------------------------------------------------- */
/* The Technical queues                                                       */
/* -------------------------------------------------------------------------- */

/** Given to TECHNICAL_USER (id 4) by the Admin — what "Được giao" lists. */
const MINE = {
  assignedTechnician: { id: 4, name: 'Kỹ thuật viên trực' },
  assignedAt: '2026-09-17T02:30:00.000Z',
  assignedByName: 'Quản trị viên',
  assignmentState: 'ASSIGNED',
  assignmentStateLabel: 'Đã giao kỹ thuật',
};

/**
 * The technical screens' API. `inspection` is the server's
 * TECHNICAL_INSPECTION_ENABLED — off unless a test switches it on.
 */
function technicalRoutes(
  over: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
  user: unknown = TECHNICAL_USER,
  inspection = false,
) {
  const at = (o: Record<string, unknown> = {}) => issue({ inspectionEnabled: inspection, ...o });
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => SUMMARY,
    'GET /api/nav-badges': () => BADGES,
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/issues/counts': () => ({
      status: 200,
      body: {
        counts: {
          newCount: 2,
          reworkCount: 3,
          inProgressCount: 1,
          // Dormant, the server has no such queue and counts nothing in it.
          awaitingInspectionCount: inspection ? 4 : 0,
          completedCount: 5,
          inspectionEnabled: inspection,
        },
      },
    }),
    'GET /api/issues?stage=WAITING&pageSize=100': () => listBody([at(MINE)]),
    'GET /api/issues?stage=REWORK&pageSize=100': () => listBody([]),
    'GET /api/issues?stage=IN_PROGRESS&pageSize=100': () =>
      listBody([at({ id: 'i2', status: 'IN_PROGRESS', technicianName: 'Trần Văn B', technicianPhone: '0901234567', acceptedAt: '2026-09-17T03:00:00.000Z', attempts: [ATTEMPT_OPEN] })]),
    'GET /api/issues?stage=AWAITING_INSPECTION&pageSize=100': () =>
      listBody(inspection ? [AWAITING({ inspectionEnabled: true })] : []),
    'GET /api/issues?stage=COMPLETED&pageSize=100': () => listBody([]),
    ...over,
  };
}

const ATTEMPT_OPEN = {
  id: 'a1',
  attemptNumber: 1,
  technicianName: 'Trần Văn B',
  technicianPhone: '0901234567',
  acceptedByName: 'Kỹ thuật viên trực',
  acceptedAt: '2026-09-17T03:00:00.000Z',
  outcome: null,
  outcomeAt: null,
  reason: null,
  durationSeconds: 600,
  durationLabel: '10 phút',
};

/** Finished by Bảo at 11:10, waiting for Quản lý kỹ thuật. */
function AWAITING(over: Record<string, unknown> = {}) {
  return issue({
    id: 'i3',
    status: 'AWAITING_INSPECTION',
    reportedCause: null,
    shiftReceptionistName: 'Đức',
    technicianName: 'Bảo',
    technicianPhone: '0369852177',
    acceptedAt: '2026-09-17T03:30:00.000Z',
    completedAt: '2026-09-17T04:10:00.000Z',
    durationLabel: '40 phút',
    attempts: [
      {
        ...ATTEMPT_OPEN,
        id: 'a3',
        technicianName: 'Bảo',
        technicianPhone: '0369852177',
        acceptedAt: '2026-09-17T03:30:00.000Z',
        outcome: 'COMPLETED',
        outcomeAt: '2026-09-17T04:10:00.000Z',
        cause: 'Thiếu gas',
        result: 'Đã nạp gas',
        durationLabel: '40 phút',
      },
    ],
    ...over,
  });
}

describe('Bộ phận kỹ thuật works the queues', () => {
  it('shows every workflow stage with server-side counts — and, dormant, no "Chờ nghiệm thu"', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');

    const tabNew = await screen.findByTestId('technical-tab-new');
    expect(tabNew).toHaveTextContent('Được giao');
    // The counts arrive from their own query, so the number is awaited.
    await waitFor(() => expect(tabNew).toHaveTextContent('2'));
    expect(screen.getByTestId('technical-tab-in-progress')).toHaveTextContent('Đang sửa');
    expect(screen.getByTestId('technical-tab-in-progress')).toHaveTextContent('1');
    expect(screen.getByTestId('technical-tab-completed')).toHaveTextContent('Đã hoàn thành');
    expect(screen.getByTestId('technical-tab-completed')).toHaveTextContent('5');
    // "Không sửa được" sends an incident back: its own queue.
    expect(screen.getByTestId('technical-tab-rework')).toHaveTextContent('Cần sửa lại');
    expect(screen.getByTestId('technical-tab-rework')).toHaveTextContent('3');
    // No inspection queue in the operational workflow — not as a tab, not in the menu.
    expect(screen.queryByTestId('technical-tab-awaiting-inspection')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Được giao',
      'Cần sửa lại',
      'Đang sửa',
      'Đã hoàn thành',
      'Lịch sử',
      'Thống kê',
    ]);
    expect(screen.queryByText(/nghiệm thu/i)).not.toBeInTheDocument();
  });

  it('with inspection switched on, shows the "Chờ nghiệm thu" queue and its count', async () => {
    installApiMock(technicalRoutes({}, TECHNICAL_USER, true));
    renderApp('/app/technical/new');

    const awaiting = await screen.findByTestId('technical-tab-awaiting-inspection');
    expect(awaiting).toHaveTextContent('Chờ nghiệm thu');
    await waitFor(() => expect(awaiting).toHaveTextContent('4'));
  });

  it('sends an old link to "Chờ nghiệm thu" to the first queue while inspection is dormant', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/awaiting-inspection');

    expect(await screen.findByRole('list', { name: 'Được giao' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chờ nghiệm thu' })).not.toBeInTheDocument();
  });

  it('shows the incident with its branch, location and reporter', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');

    // Scoped to the queue: the branch name also appears in the branch filter.
    const queue = await screen.findByRole('list', { name: 'Được giao' });
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

    // Prefilled with the signed-in technician's full name — editable for a colleague.
    const name = within(dialog).getByTestId('technician-name');
    expect(name).toHaveValue('Kỹ thuật viên trực');
    expect(confirm).toBeDisabled(); // a name but no phone
    await user.clear(name);
    await user.type(name, 'Trần Văn B');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByTestId('technician-phone'), '0901234567');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(sent).toEqual({ technicianName: 'Trần Văn B', technicianPhone: '0901234567' });
  });

  /**
   * DORMANT, "HOÀN THÀNH" ASKS "TÌNH TRẠNG VẤN ĐỀ". "Đã xử lý xong" finishes it —
   * what was done is optional — and the server stamps the time.
   */
  it('completes an incident through "Tình trạng vấn đề" → "Đã xử lý xong"', async () => {
    let sent: unknown = null;
    installApiMock(
      technicalRoutes({
        'POST /api/issues/i2/complete': (init: RequestInit) => {
          sent = JSON.parse(String(init.body));
          return { status: 200, body: { issue: issue({ id: 'i2', status: 'COMPLETED' }) } };
        },
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    const queue = await screen.findByRole('list', { name: 'Đang sửa' });
    expect(within(queue).getAllByText('Trần Văn B').length).toBeGreaterThan(0);
    expect(within(queue).getAllByText(/0901234567/).length).toBeGreaterThan(0);

    await user.click(screen.getByTestId('complete-i2'));
    const dialog = await screen.findByRole('dialog', { name: 'Tình trạng vấn đề' });
    expect(within(dialog).getByTestId('stage-confirm')).toBeDisabled();
    await user.click(within(dialog).getByTestId('stage-status-done'));
    await user.click(within(dialog).getByTestId('stage-confirm'));
    await waitFor(() => expect(sent).toEqual({}));
    expect(await screen.findByText('Đã hoàn thành sự cố.')).toBeInTheDocument();
  });

  /**
   * "ĐANG TRONG QUÁ TRÌNH THEO DÕI THÊM": both fields are required, the stage
   * is recorded and the incident stays "Đang sửa" — nothing is completed.
   */
  it('records one stage of several, and keeps the repair open', async () => {
    let staged: unknown = null;
    let completed = false;
    installApiMock(
      technicalRoutes({
        'POST /api/issues/i2/stage': (init: RequestInit) => {
          staged = JSON.parse(String(init.body));
          return { status: 200, body: { issue: issue({ id: 'i2', status: 'IN_PROGRESS' }) } };
        },
        'POST /api/issues/i2/complete': () => {
          completed = true;
          return { status: 200, body: { issue: issue({ id: 'i2', status: 'COMPLETED' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    await user.click(await screen.findByTestId('complete-i2'));
    const dialog = await screen.findByRole('dialog', { name: 'Tình trạng vấn đề' });
    await user.click(within(dialog).getByTestId('stage-status-follow'));
    const confirm = within(dialog).getByTestId('stage-confirm');
    await user.type(within(dialog).getByTestId('stage-work-done'), 'Đã thay tụ');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByTestId('stage-next-work'), 'Chờ linh kiện block');
    await user.click(confirm);
    await waitFor(() => expect(staged).toEqual({ workDone: 'Đã thay tụ', nextWork: 'Chờ linh kiện block' }));
    expect(completed).toBe(false);
    expect(await screen.findByText('Đã ghi nhận giai đoạn — sự cố vẫn đang sửa.')).toBeInTheDocument();
  });

  it('shows the stage timeline: finished stages, and the one under way', async () => {
    const stage = {
      id: 'st1',
      stageNumber: 1,
      technicianName: 'Trần Văn B',
      startedAt: '2026-09-17T03:00:00.000Z',
      completedAt: '2026-09-17T05:00:00.000Z',
      workDone: 'Đã thay tụ',
      nextWork: 'Chờ linh kiện block',
      final: false,
    };
    installApiMock(
      technicalRoutes({
        'GET /api/issues?stage=IN_PROGRESS&pageSize=100': () =>
          listBody([issue({ id: 'i2', status: 'IN_PROGRESS', attempts: [ATTEMPT_OPEN], stages: [stage], currentStageNumber: 2 })]),
      }),
    );
    renderApp('/app/technical/in-progress');

    const timeline = await screen.findByTestId('issue-stages');
    expect(within(timeline).getByTestId('issue-stage-1')).toHaveTextContent('Giai đoạn 1');
    expect(within(timeline).getByTestId('issue-stage-1')).toHaveTextContent('Đã thay tụ');
    expect(within(timeline).getByTestId('issue-stage-current')).toHaveTextContent('Giai đoạn 2');
    expect(within(timeline).getByTestId('issue-stage-current')).toHaveTextContent('Chờ linh kiện block');
  });

  /**
   * WITH INSPECTION ON, "HOÀN THÀNH" RECORDS WHAT WAS DONE. The result is
   * required — it is what the manager inspects — and the cause found during
   * the repair goes with it.
   */
  it('with inspection switched on, completes it with a result', async () => {
    let sent: unknown = null;
    installApiMock(
      technicalRoutes(
        {
          'POST /api/issues/i2/complete': (init: RequestInit) => {
            sent = JSON.parse(String(init.body));
            return { status: 200, body: { issue: issue({ id: 'i2', status: 'AWAITING_INSPECTION', inspectionEnabled: true }) } };
          },
        },
        TECHNICAL_USER,
        true,
      ),
    );

    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    const queue = await screen.findByRole('list', { name: 'Đang sửa' });
    expect(within(queue).getAllByText('Trần Văn B').length).toBeGreaterThan(0);
    expect(within(queue).getAllByText(/0901234567/).length).toBeGreaterThan(0);

    await user.click(screen.getByTestId('complete-i2'));
    const dialog = await screen.findByRole('dialog', { name: 'Hoàn thành sửa chữa' });
    const confirm = within(dialog).getByTestId('complete-confirm');
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByTestId('complete-cause'), 'Thiếu gas');
    await user.type(within(dialog).getByTestId('complete-result'), 'Đã nạp gas');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(sent).toEqual({ result: 'Đã nạp gas', cause: 'Thiếu gas' }));
  });

  /**
   * THE PREFILL IS NOT A FINDING. The field starts with the cause on file so the
   * technician can correct it; left as it is, nothing is sent, and the cause on
   * file is not recorded again as this technician's own determination.
   */
  it('does not send the cause on file back as the technician\'s own', async () => {
    let sent: unknown = null;
    installApiMock(
      technicalRoutes(
        {
          'GET /api/issues?stage=IN_PROGRESS&pageSize=100': () =>
            listBody([
              issue({
                id: 'i2',
                status: 'IN_PROGRESS',
                inspectionEnabled: true,
                reportedCause: 'Hết gas',
                technicianName: 'Trần Văn B',
                technicianPhone: '0901234567',
                acceptedAt: '2026-09-17T03:00:00.000Z',
                attempts: [ATTEMPT_OPEN],
              }),
            ]),
          'POST /api/issues/i2/complete': (init: RequestInit) => {
            sent = JSON.parse(String(init.body));
            return { status: 200, body: { issue: issue({ id: 'i2', status: 'AWAITING_INSPECTION', inspectionEnabled: true }) } };
          },
        },
        TECHNICAL_USER,
        true,
      ),
    );
    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    await user.click(await screen.findByTestId('complete-i2'));
    const dialog = await screen.findByRole('dialog', { name: 'Hoàn thành sửa chữa' });
    expect(within(dialog).getByTestId('complete-cause')).toHaveValue('Hết gas');
    await user.type(within(dialog).getByTestId('complete-result'), 'Đã nạp gas');
    await user.click(within(dialog).getByTestId('complete-confirm'));
    await waitFor(() => expect(sent).toEqual({ result: 'Đã nạp gas' }));
  });

  it('records the cause during the repair, on its own', async () => {
    let sent: unknown = null;
    installApiMock(
      technicalRoutes({
        'POST /api/issues/i2/cause': (init: RequestInit) => {
          sent = JSON.parse(String(init.body));
          return { status: 200, body: { issue: issue({ id: 'i2', status: 'IN_PROGRESS' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/app/technical/in-progress');

    await user.click(await screen.findByTestId('cause-edit-i2'));
    const dialog = await screen.findByRole('dialog', { name: 'Cập nhật nguyên nhân' });
    await user.type(within(dialog).getByTestId('cause-input'), 'Thiếu gas');
    await user.click(within(dialog).getByTestId('cause-confirm'));
    await waitFor(() => expect(sent).toEqual({ cause: 'Thiếu gas' }));
  });

  it('names the reporter by the employee name the server composed', async () => {
    installApiMock(technicalRoutes({}, TECHNICAL_USER, true));
    renderApp('/app/technical/awaiting-inspection');
    const queue = await screen.findByRole('list', { name: 'Chờ nghiệm thu' });
    // "Đức", not "Lễ tân Một (Đức)" — nothing here parses a composite name.
    expect(within(queue).getByText(/Người báo: Đức ·/)).toBeInTheDocument();
    expect(within(queue).queryByText(/Lễ tân Một/)).not.toBeInTheDocument();
  });

  it('cannot inspect: a finished repair offers the technician nothing', async () => {
    installApiMock(technicalRoutes({}, TECHNICAL_USER, true));
    renderApp('/app/technical/awaiting-inspection');
    await screen.findByRole('list', { name: 'Chờ nghiệm thu' });
    expect(screen.queryByTestId('inspect-i3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nghiệm thu/ })).not.toBeInTheDocument();
  });

  it('says who assigned the job and when, and notes a repeat neutrally', async () => {
    installApiMock(
      technicalRoutes({
        'GET /api/issues?stage=WAITING&pageSize=100': () =>
          listBody([
            issue({
              ...MINE,
              repeatOf: {
                id: 'old',
                description: 'Máy lạnh chảy nước',
                reportedAt: '2026-09-01T02:00:00.000Z',
                completedAt: '2026-09-02T02:00:00.000Z',
                technicianName: 'Bảo',
              },
            }),
          ]),
      }),
    );
    renderApp('/app/technical/new');
    const queue = await screen.findByRole('list', { name: 'Được giao' });
    expect(within(queue).getByTestId('assignment-i1')).toHaveTextContent('Đã giao kỹ thuật');
    expect(within(queue).getByTestId('assignment-i1')).toHaveTextContent('giao bởi Quản trị viên');
    const repeat = within(queue).getByTestId('issue-repeat');
    expect(repeat).toHaveTextContent('Báo lại sau lần hoàn thành trước');
    expect(repeat).toHaveTextContent('Máy lạnh chảy nước');
    expect(repeat).toHaveTextContent('Bảo');
    // A warning, never a block: the job can still be taken.
    expect(within(queue).getByTestId('accept-i1')).toBeInTheDocument();
  });

  it('keeps "Lịch sử" — every stage, no count — and offers nothing on a job now held by someone else', async () => {
    installApiMock(
      technicalRoutes({
        'GET /api/issues?pageSize=100': () =>
          listBody([
            issue({
              assignedTechnician: { id: 9, name: 'Người khác' },
              assignmentState: 'ASSIGNED',
              assignmentStateLabel: 'Đã giao kỹ thuật',
            }),
          ]),
      }),
    );
    renderApp('/app/technical/history');
    const queue = await screen.findByRole('list', { name: 'Lịch sử' });
    expect(within(queue).getByText('Phòng · Phòng 301')).toBeInTheDocument();
    expect(screen.getByTestId('technical-tab-history')).toHaveTextContent(/^Lịch sử$/);
    expect(screen.queryByTestId('accept-i1')).not.toBeInTheDocument();
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
/* Quản lý kỹ thuật                                                           */
/* -------------------------------------------------------------------------- */

describe('Quản lý kỹ thuật — no "Nghiệm thu" screen any more', () => {
  it('sends an old queue link to "Quản lý sự cố kỹ thuật"', async () => {
    installApiMock(
      technicalRoutes(
        {
          'GET /api/issues/technicians': () => ({ status: 200, body: { technicians: [] } }),
          'GET /api/issues?pageSize=500': () => listBody([issue()]),
        },
        TECHNICAL_MANAGER_USER,
      ),
    );
    renderApp('/app/technical/awaiting-inspection');

    expect(await screen.findByRole('heading', { name: 'Quản lý sự cố kỹ thuật' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Quản lý sự cố kỹ thuật']);
    expect(screen.queryByTestId('inspection-inactive')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nghiệm thu/)).not.toBeInTheDocument();
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

/**
 * "ĐÃ HOÀN THÀNH" BY COMPLETION DATE. No period by default — the whole history,
 * exactly the request the queue always made. A period goes to the SERVER as the
 * technician's completion days; half a period is never sent.
 */
describe('Bộ phận kỹ thuật filters "Đã hoàn thành" by the day the repair was finished', () => {
  const DONE = () => issue({ id: 'd1', status: 'COMPLETED', completedAt: '2026-09-17T04:10:00.000Z' });

  it('starts unfiltered, narrows on the server, says so when empty, and clears', async () => {
    const today = hcmToday();
    const week = `completedFrom=${daysBefore(today, 6)}&completedTo=${today}`;
    const fetchMock = installApiMock(
      technicalRoutes({
        'GET /api/issues?stage=COMPLETED&pageSize=100': () => listBody([DONE()]),
        [`GET /api/issues?stage=COMPLETED&${week}&pageSize=100`]: () => listBody([]),
      }),
    );
    renderApp('/app/technical/completed');

    const queue = await screen.findByRole('list', { name: 'Đã hoàn thành' });
    expect(within(queue).getByText('Phòng · Phòng 301')).toBeInTheDocument();
    expect(screen.getByTestId('done-filters')).toHaveTextContent('Ngày hoàn thành');
    expect(screen.queryByTestId('done-range-clear')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByTestId('done-range-6'));
    expect(await screen.findByText('Không có sự cố hoàn thành trong khoảng thời gian này.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(`/api/issues?stage=COMPLETED&${week}&pageSize=100`);

    await userEvent.setup().click(screen.getByTestId('done-range-clear'));
    expect(await screen.findByRole('list', { name: 'Đã hoàn thành' })).toBeInTheDocument();
  });

  it('never sends half a period, and asks for the other end', async () => {
    const fetchMock = installApiMock(technicalRoutes());
    renderApp('/app/technical/completed');
    await screen.findByTestId('done-filters');

    fireEvent.change(screen.getByTestId('done-range-from'), { target: { value: '2026-09-01' } });
    expect(await screen.findByTestId('done-range-invalid')).toHaveTextContent('Hãy chọn đủ ngày bắt đầu và ngày kết thúc.');
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.includes('completedFrom'))).toBe(false);
  });

  it('shows no completion filter on the other queues', async () => {
    installApiMock(technicalRoutes());
    renderApp('/app/technical/new');
    await screen.findByRole('list', { name: 'Được giao' });
    expect(screen.queryByTestId('done-filters')).not.toBeInTheDocument();
  });
});
