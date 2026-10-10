/**
 * The reception shift check-in, from the receptionist's side.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A receptionist with no open shift is asked to choose one, and cannot
 *      dismiss the question.
 *   2. The panel appears again ONLY when the server says the grace period has
 *      elapsed — `promptDue` — and never on the client's own clock arithmetic.
 *   3. No other role is ever asked for a shift.
 *   4. The running shift is shown in the header, so nobody has to remember it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, TECHNICAL_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SHIFTS = [
  { code: 'A', name: 'Ca A', startLocalTime: '06:00', endLocalTime: '14:00', crossesMidnight: false, graceMinutes: 10 },
  { code: 'B', name: 'Ca B', startLocalTime: '14:00', endLocalTime: '22:00', crossesMidnight: false, graceMinutes: 10 },
  { code: 'C', name: 'Ca C', startLocalTime: '22:00', endLocalTime: '06:00', crossesMidnight: true, graceMinutes: 10 },
  { code: 'A4', name: 'Ca A4', startLocalTime: '06:00', endLocalTime: '18:00', crossesMidnight: false, graceMinutes: 10 },
  { code: 'C4', name: 'Ca C4', startLocalTime: '18:00', endLocalTime: '06:00', crossesMidnight: true, graceMinutes: 10 },
];

function session(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    branchId: 1,
    shiftType: 'A4',
    shiftName: 'Ca A4',
    shiftWindow: '06:00 – 18:00',
    receptionistName: 'Nguyễn Văn A',
    startedAt: '2026-09-16T23:00:00.000Z',
    nominalEndAt: '2026-09-17T11:00:00.000Z',
    graceEndAt: '2026-09-17T11:10:00.000Z',
    closedAt: null,
    promptDue: false,
    ...over,
  };
}

/**
 * The mock matches on the FULL url, so every endpoint the authenticated shell
 * touches has to be present or it resolves 404 and the screen renders an error
 * instead of the thing under test.
 */
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
    // The host page: "Báo cáo vấn đề", which every receptionist has.
    'GET /api/reception/reports/options': () => ({
      status: 200,
      body: { categories: [], paymentMethods: [], roomServiceTypes: [], guestRequestItems: [] },
    }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({ status: 200, body: { reports: [], counts: {} } }),
    'GET /api/issues?pageSize=100': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
    }),
    ...extra,
  };
}

describe('a receptionist with no shift is asked to choose one', () => {
  it('shows every shift with its clock times', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Chọn ca làm việc' });
    // The options come from their own query, so the first one is awaited.
    await within(dialog).findByTestId('shift-option-A');
    for (const s of SHIFTS) {
      expect(within(dialog).getByTestId(`shift-option-${s.code}`)).toBeInTheDocument();
    }
    // The times are shown, so A and A4 are distinguishable at 06:00.
    expect(within(dialog).getByTestId('shift-option-A')).toHaveTextContent('06:00 – 14:00');
    expect(within(dialog).getByTestId('shift-option-A4')).toHaveTextContent('06:00 – 18:00');
    // And the branch the shift belongs to.
    expect(within(dialog).getByText('05 Trương Định')).toBeInTheDocument();
  });

  /**
   * NOTHING IS PRESELECTED. Ca A and Ca A4 both begin at 06:00, so a default
   * chosen from the clock would be wrong half the time and accepted silently.
   */
  it('confirms nothing until a shift AND a name are given', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Chọn ca làm việc' });
    const confirm = within(dialog).getByTestId('shift-confirm');

    // Nothing chosen yet.
    expect(confirm).toBeDisabled();

    await user.click(await within(dialog).findByTestId('shift-option-A4'));
    expect(confirm).toBeDisabled(); // a shift, but no name

    await user.type(within(dialog).getByTestId('shift-name'), '   ');
    expect(confirm).toBeDisabled(); // whitespace is not a name

    await user.type(within(dialog).getByTestId('shift-name'), 'Nguyễn Văn A');
    expect(confirm).toBeEnabled();
  });

  it('sends the chosen shift and the trimmed name', async () => {
    let body: unknown = null;
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
        'POST /api/reception/shifts/check-in': (init) => {
          body = JSON.parse(String(init.body));
          return { status: 201, body: { session: session() } };
        },
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Chọn ca làm việc' });
    await user.click(await within(dialog).findByTestId('shift-option-A4'));
    await user.type(within(dialog).getByTestId('shift-name'), '  Nguyễn Văn A  ');
    await user.click(within(dialog).getByTestId('shift-confirm'));

    expect(body).toEqual({ shiftType: 'A4', receptionistName: 'Nguyễn Văn A' });
  });
});

describe('the shift panel appears only when the server says so', () => {
  it('stays hidden while a shift is running', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session({ promptDue: false }) } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    renderApp('/app/reports');

    // The page itself renders, and no dialog interrupts it.
    expect(await screen.findByTestId('report-overview')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  /**
   * The ONLY input is `promptDue`. The client does no clock arithmetic of its
   * own — a reception PC running ten minutes fast must not nag its receptionist
   * early, and this is what guarantees it cannot.
   */
  it('reappears when the grace period has elapsed', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session({ promptDue: true }) } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Ca làm việc đã kết thúc' });
    expect(within(dialog).getByText(/Ca trước đã hết giờ/)).toBeInTheDocument();
  });
});

describe('the running shift is shown in the header', () => {
  it('names the shift, its window and the receptionist', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session() } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    renderApp('/app/reports');

    const indicator = await screen.findByTestId('shift-indicator');
    expect(indicator).toHaveTextContent('CA A4');
    expect(indicator).toHaveTextContent('06:00 – 18:00');
    expect(indicator).toHaveTextContent('Nguyễn Văn A');
  });
});

describe('no other role has a shift', () => {
  it('never asks an Admin', async () => {
    const fetchMock = installApiMock(
      shellRoutes(ADMIN_USER, {
        'GET /api/issues?pageSize=100': () => ({
          status: 200,
          body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
        }),
        'GET /api/issues?pageSize=100&': () => ({ status: 200, body: { issues: [] } }),
      }),
    );

    renderApp('/app/issues');
    // Both the nav item and the topbar carry this page's name, so the wait is on
    // something only the Admin monitor renders.
    await screen.findByRole('button', { name: /Xuất báo cáo/ });

    expect(screen.queryByRole('dialog', { name: 'Chọn ca làm việc' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('shift-indicator')).not.toBeInTheDocument();
    // And the endpoint is never even called.
    const called = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.includes('/reception/shifts'))).toBe(false);
  });

  it('never asks a technical user', async () => {
    const fetchMock = installApiMock(
      shellRoutes(TECHNICAL_USER, {
        'GET /api/issues/counts': () => ({
          status: 200,
          body: { counts: { newCount: 0, inProgressCount: 0, completedCount: 0 } },
        }),
        'GET /api/branches': () => ({ status: 200, body: { branches: [] } }),
        'GET /api/issues?status=NEW&pageSize=100': () => ({
          status: 200,
          body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
        }),
      }),
    );

    renderApp('/app/technical/new');
    await screen.findByTestId('technical-tab-new');

    expect(screen.queryByRole('dialog', { name: 'Chọn ca làm việc' })).not.toBeInTheDocument();
    const called = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.includes('/reception/shifts'))).toBe(false);
  });
});

/**
 * THE TWO CASES ARE TREATED DIFFERENTLY, AND THAT IS THE POINT.
 *
 * With no session the application does not know who is working, so the question
 * has to be answered. With an EXPIRED one it already does, and the receptionist
 * may be mid-order — so the handover prompt can be put off, and a banner keeps
 * asking instead of the dialog reopening on every poll.
 */
describe('the check-in prompt is required at the start and deferrable at handover', () => {
  it('cannot be dismissed when there is no shift at all', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Chọn ca làm việc' });
    expect(within(dialog).queryByTestId('shift-later')).not.toBeInTheDocument();
  });

  it('can be put off at handover, leaving a banner that brings it back', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session({ promptDue: true }) } }),
        'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
      }),
    );

    const user = userEvent.setup();
    renderApp('/app/reports');

    const dialog = await screen.findByRole('dialog', { name: 'Ca làm việc đã kết thúc' });
    await user.click(within(dialog).getByTestId('shift-later'));

    // The dialog is gone; the reminder is not.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const banner = screen.getByTestId('shift-expired-banner');
    expect(banner).toHaveTextContent('Ca làm việc đã kết thúc');

    // And the page underneath is usable again.
    expect(screen.getByTestId('report-overview')).toBeInTheDocument();

    // The banner reopens it on demand.
    await user.click(screen.getByTestId('shift-reopen'));
    expect(await screen.findByRole('dialog', { name: 'Ca làm việc đã kết thúc' })).toBeInTheDocument();
  });
});
