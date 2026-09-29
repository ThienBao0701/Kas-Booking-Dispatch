/**
 * "KHÔNG SỬA ĐƯỢC" and the reorganised incident card, from the technician's side.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Both outcomes ask for what they cannot be recorded without: "Hoàn thành"
 *      the result the manager will inspect, "Không sửa được" the reason.
 *   2. A returned incident reads as "Cần sửa lại", not as a fresh report —
 *      both are NEW, and telling them apart is the point of the whole flow.
 *   3. The attempt history is on screen: who went, when, how long, and why they
 *      stopped, for every attempt and not just the last.
 *   4. The duration shown is the server's string. The browser never formats it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TECHNICAL_USER, installApiMock, renderApp } from '../test/utils';
import { withLifecycle } from '../test/issueFixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion', address: '05 Trương Định' };

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    attemptNumber: 1,
    technicianName: 'Bao',
    technicianPhone: '0369852177',
    acceptedByName: 'Kỹ thuật viên A',
    acceptedAt: '2026-09-17T08:54:00.000Z',
    outcome: 'CANNOT_REPAIR',
    outcomeAt: '2026-09-17T08:58:00.000Z',
    reason: 'Không có linh kiện',
    durationSeconds: 240,
    durationLabel: '4 phút',
    ...over,
  };
}

function issue(over: Record<string, unknown> = {}) {
  return withLifecycle({
    id: 'i1',
    branchId: 1,
    branch: BRANCH,
    areaCategory: 'ROOM',
    roomNumber: '101',
    floorNumber: null,
    areaSubtype: null,
    locationDetail: null,
    locationLabel: 'Phòng · Phòng 101',
    category: 'TOILET',
    description: 'Hello',
    photoUrl: null,
    status: 'IN_PROGRESS',
    reportedBy: { id: 2, fullName: 'Nguyễn Văn A' },
    reportedByName: 'Nguyễn Văn A',
    acceptedBy: { id: 4, fullName: 'Kỹ thuật viên A' },
    acceptedByName: 'Kỹ thuật viên A',
    acceptedAt: '2026-09-17T08:54:00.000Z',
    technicianName: 'Bao',
    technicianPhone: '0369852177',
    completedBy: null,
    completedByName: null,
    completedAt: null,
    shiftType: 'A',
    shiftReceptionistName: 'Nguyễn Văn A',
    durationSeconds: 300,
    durationLabel: '5 phút',
    attempts: [],
    cannotRepairCount: 0,
    needsRework: false,
    createdAt: '2026-09-16T16:09:00.000Z',
    updatedAt: '2026-09-17T08:54:00.000Z',
    ...over,
  });
}

function routes(
  queue: 'WAITING' | 'REWORK' | 'IN_PROGRESS' | 'COMPLETED',
  issues: unknown[],
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: TECHNICAL_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/issues/counts': () => ({
      status: 200,
      body: {
        counts: {
          newCount: 1,
          reworkCount: 0,
          inProgressCount: 1,
          awaitingInspectionCount: 0,
          completedCount: 0,
          inspectionEnabled: false,
        },
      },
    }),
    [`GET /api/issues?stage=${queue}&pageSize=100`]: () => ({
      status: 200,
      body: { issues, pagination: { page: 1, pageSize: 100, total: issues.length, totalPages: 1 } },
    }),
    ...extra,
  };
}

const QUEUE_PATH = { WAITING: 'new', REWORK: 'rework', IN_PROGRESS: 'in-progress', COMPLETED: 'completed' } as const;

describe('the two outcomes of a repair', () => {
  it('offers both "Hoàn thành" and "Không sửa được" on an incident being worked', async () => {
    installApiMock(routes('IN_PROGRESS', [issue()]));
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    expect(await screen.findByTestId('complete-i1')).toHaveTextContent('Hoàn thành');
    expect(screen.getByTestId('cannot-repair-i1')).toHaveTextContent('Không sửa được');
  });

  it('offers neither on an incident nobody has accepted', async () => {
    installApiMock(routes('WAITING', [issue({ status: 'NEW', acceptedAt: null, technicianName: null })]));
    renderApp(`/app/technical/${QUEUE_PATH.WAITING}`);

    expect(await screen.findByTestId('accept-i1')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-i1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cannot-repair-i1')).not.toBeInTheDocument();
  });

  /**
   * While inspection is DORMANT, "Hoàn thành" is the bare press it was before
   * inspection: no result is asked for, and the incident is finished.
   */
  it('finishes the repair with one press while inspection is dormant', async () => {
    let sent: Record<string, unknown> | null = null;
    installApiMock(
      routes('IN_PROGRESS', [issue()], {
        'POST /api/issues/i1/complete': (init) => {
          sent = JSON.parse(String(init.body)) as Record<string, unknown>;
          return { status: 200, body: { issue: issue({ status: 'COMPLETED' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    await user.click(await screen.findByTestId('complete-i1'));
    await waitFor(() => expect(sent).toEqual({}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * With inspection switched on, "Hoàn thành" is no longer a bare press: it
   * records the result that Quản lý kỹ thuật will inspect, and nothing is sent
   * until there is one.
   */
  it('asks for the result before it finishes the repair when inspection is on', async () => {
    let sent: Record<string, unknown> | null = null;
    installApiMock(
      routes('IN_PROGRESS', [issue({ inspectionEnabled: true })], {
        'POST /api/issues/i1/complete': (init) => {
          sent = JSON.parse(String(init.body)) as Record<string, unknown>;
          return { status: 200, body: { issue: issue({ status: 'AWAITING_INSPECTION', inspectionEnabled: true }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    await user.click(await screen.findByTestId('complete-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Hoàn thành sửa chữa' });
    expect(sent).toBeNull();
    expect(within(dialog).getByTestId('complete-confirm')).toBeDisabled();
    // Whitespace is not a result.
    await user.type(within(dialog).getByTestId('complete-result'), '   ');
    expect(within(dialog).getByTestId('complete-confirm')).toBeDisabled();

    await user.type(within(dialog).getByTestId('complete-result'), 'Đã thông tắc');
    await user.click(within(dialog).getByTestId('complete-confirm'));
    await waitFor(() => expect(sent).toEqual({ result: 'Đã thông tắc' }));
  });

  it('asks for a reason before it will return an incident to the queue', async () => {
    let sent: Record<string, unknown> | null = null;
    installApiMock(
      routes('IN_PROGRESS', [issue()], {
        'POST /api/issues/i1/cannot-repair': (init) => {
          sent = JSON.parse(String(init.body)) as Record<string, unknown>;
          return { status: 200, body: { issue: issue({ status: 'NEW', needsRework: true }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    await user.click(await screen.findByTestId('cannot-repair-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Không sửa được' });

    // Nothing has been sent yet — the dialog is the point.
    expect(sent).toBeNull();
    // And it says what will happen to the record, so the technician is not
    // guessing whether their four minutes are about to be thrown away.
    expect(within(dialog).getByText(/Thông tin người sửa và thời gian đã xử lý vẫn được lưu lại/))
      .toBeInTheDocument();

    await user.click(within(dialog).getByTestId('cannot-repair-confirm'));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ reason: 'Không có linh kiện' });
  });

  it('appends typed detail to the chosen preset', async () => {
    let sent: Record<string, unknown> | null = null;
    installApiMock(
      routes('IN_PROGRESS', [issue()], {
        'POST /api/issues/i1/cannot-repair': (init) => {
          sent = JSON.parse(String(init.body)) as Record<string, unknown>;
          return { status: 200, body: { issue: issue({ status: 'NEW' }) } };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    await user.click(await screen.findByTestId('cannot-repair-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Không sửa được' });
    await user.selectOptions(within(dialog).getByTestId('cannot-repair-reason'), 'Cần đơn vị bên ngoài');
    await user.type(within(dialog).getByTestId('cannot-repair-detail'), 'Cần thợ điện lạnh');
    await user.click(within(dialog).getByTestId('cannot-repair-confirm'));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({ reason: 'Cần đơn vị bên ngoài — Cần thợ điện lạnh' });
  });

  it('will not confirm "Khác" with nothing typed', async () => {
    installApiMock(routes('IN_PROGRESS', [issue()]));
    const user = userEvent.setup();
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    await user.click(await screen.findByTestId('cannot-repair-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Không sửa được' });
    await user.selectOptions(within(dialog).getByTestId('cannot-repair-reason'), 'Khác');

    // "Khác" is not a reason. It is the absence of one.
    expect(within(dialog).getByTestId('cannot-repair-confirm')).toBeDisabled();
    await user.type(within(dialog).getByTestId('cannot-repair-detail'), 'Hỏng bo mạch');
    expect(within(dialog).getByTestId('cannot-repair-confirm')).toBeEnabled();
  });
});

describe('an incident that came back', () => {
  const returned = issue({
    status: 'NEW',
    acceptedAt: null,
    technicianName: null,
    technicianPhone: null,
    durationSeconds: null,
    durationLabel: null,
    attempts: [attempt()],
    cannotRepairCount: 1,
    needsRework: true,
  });

  /**
   * A FRESH REPORT AND A RETURNED ONE ARE BOTH `NEW`.
   *
   * Showing them identically hides the single most useful thing a technician
   * picking up the queue could know: that the last person to go could not finish
   * it, and why.
   */
  it('reads as "Cần sửa lại", in its own queue, not as a fresh report', async () => {
    installApiMock(routes('REWORK', [returned]));
    renderApp(`/app/technical/${QUEUE_PATH.REWORK}`);

    const queue = await screen.findByRole('list', { name: 'Cần sửa lại' });
    expect(within(queue).getByTestId('issue-stage')).toHaveTextContent('Cần sửa lại');
    expect(within(queue).queryByText('Chờ kỹ thuật')).not.toBeInTheDocument();
  });

  it('shows the failed attempt: who, when, how long and why', async () => {
    installApiMock(routes('REWORK', [returned]));
    renderApp(`/app/technical/${QUEUE_PATH.REWORK}`);

    const timeline = await screen.findByTestId('issue-timeline');
    expect(within(timeline).getByText(/Lần 1/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Bao/)).toBeInTheDocument();
    expect(within(timeline).getByText(/0369852177/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Không sửa được/)).toBeInTheDocument();
    expect(within(timeline).getByText(/4 phút/)).toBeInTheDocument();
    expect(within(timeline).getByText('Lý do: Không có linh kiện')).toBeInTheDocument();
  });

  it('can still be accepted again', async () => {
    installApiMock(routes('REWORK', [returned]));
    renderApp(`/app/technical/${QUEUE_PATH.REWORK}`);
    expect(await screen.findByTestId('accept-i1')).toBeInTheDocument();
  });
});

describe('the incident card', () => {
  it('shows a running repair counting up, using the server’s wording', async () => {
    installApiMock(routes('IN_PROGRESS', [issue({ durationLabel: '5 phút' })]));
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    const queue = await screen.findByRole('list', { name: 'Đang sửa' });
    expect(within(queue).getByText('Đã xử lý')).toBeInTheDocument();
    // The string is the SERVER's — the browser never formats a duration, so the
    // card, the Admin monitor and the PDF cannot round the same interval three
    // different ways.
    expect(within(queue).getByText('5 phút')).toBeInTheDocument();
  });

  it('keeps every attempt on an incident that was eventually fixed', async () => {
    const fixed = issue({
      status: 'COMPLETED',
      completedAt: '2026-09-17T09:35:00.000Z',
      technicianName: 'Minh',
      technicianPhone: '0911222333',
      durationLabel: '15 phút',
      cannotRepairCount: 1,
      attempts: [
        attempt(),
        attempt({
          id: 'a2',
          attemptNumber: 2,
          technicianName: 'Minh',
          technicianPhone: '0911222333',
          outcome: 'COMPLETED',
          reason: null,
          acceptedAt: '2026-09-17T09:20:00.000Z',
          outcomeAt: '2026-09-17T09:35:00.000Z',
          durationLabel: '15 phút',
        }),
      ],
    });
    installApiMock(routes('COMPLETED', [fixed]));
    renderApp(`/app/technical/${QUEUE_PATH.COMPLETED}`);

    const timeline = await screen.findByTestId('issue-timeline');
    expect(within(timeline).getByText(/Lần 1/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Lần 2/)).toBeInTheDocument();
    // Bảo's four failed minutes survive the incident being closed by somebody else.
    expect(within(timeline).getByText('Lý do: Không có linh kiện')).toBeInTheDocument();
  });

  it('labels the reporter and their shift', async () => {
    installApiMock(routes('IN_PROGRESS', [issue()]));
    renderApp(`/app/technical/${QUEUE_PATH.IN_PROGRESS}`);

    const queue = await screen.findByRole('list', { name: 'Đang sửa' });
    expect(within(queue).getByText(/Người báo: Nguyễn Văn A/)).toBeInTheDocument();
  });
});
