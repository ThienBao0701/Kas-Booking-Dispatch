/**
 * "ĐỔI CA" from the receptionist's side.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The action is reachable WHILE a shift is running, which is the one state
 *      the existing shift picker deliberately never appears in.
 *   2. It is a separate dialog from check-in — the daily two-field case does not
 *      grow the rare four-field one's questions.
 *   3. Reason and receiver are both required before it can be confirmed.
 *   4. The request carries NO timestamp. The handover instant is the server's,
 *      and a reception PC with a wrong clock must not decide it.
 *   5. Nobody but a receptionist on a shift sees the button.
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
    shiftType: 'A',
    shiftName: 'Ca A',
    shiftWindow: '06:00 – 14:00',
    receptionistName: 'Nguyễn Văn A',
    startedAt: '2026-09-16T23:00:00.000Z',
    nominalEndAt: '2026-09-17T07:00:00.000Z',
    graceEndAt: '2026-09-17T07:10:00.000Z',
    closedAt: null,
    // NOT due: the whole point is that "Đổi ca" works mid-shift, where the
    // automatic picker never appears.
    promptDue: false,
    ...over,
  };
}

/** Every endpoint the authenticated shell touches; the mock matches full URLs. */
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
    'GET /api/issues?pageSize=100': () => ({
      status: 200,
      body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
    }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session() } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: SHIFTS } }),
    ...extra,
  };
}

describe('the "Đổi ca" action', () => {
  it('is offered while a shift is running', async () => {
    installApiMock(shellRoutes(RECEPTIONIST_USER));
    renderApp('/app/issues');

    expect(await screen.findByTestId('shift-handover-open')).toHaveTextContent('Đổi ca');
    // And the automatic picker is NOT on screen — this is a mid-shift action.
    expect(screen.queryByRole('dialog', { name: 'Chọn ca làm việc' })).not.toBeInTheDocument();
  });

  it('is not offered to a receptionist who has not checked in', async () => {
    installApiMock(
      shellRoutes(RECEPTIONIST_USER, {
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
      }),
    );
    renderApp('/app/issues');

    // The check-in dialog is what appears instead; there is nothing to hand over.
    await screen.findByRole('dialog', { name: 'Chọn ca làm việc' });
    expect(screen.queryByTestId('shift-handover-open')).not.toBeInTheDocument();
  });

  it('is not offered to an Admin', async () => {
    installApiMock(shellRoutes(ADMIN_USER));
    renderApp('/app/issues');

    await screen.findByRole('button', { name: /Xuất báo cáo/ });
    expect(screen.queryByTestId('shift-handover-open')).not.toBeInTheDocument();
  });

  it('is not offered to Bộ phận kỹ thuật', async () => {
    installApiMock(
      shellRoutes(TECHNICAL_USER, {
        'GET /api/issues/counts': () => ({
          status: 200,
          body: { counts: { newCount: 0, inProgressCount: 0, completedCount: 0 } },
        }),
        'GET /api/issues?status=NEW&pageSize=100': () => ({
          status: 200,
          body: { issues: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } },
        }),
        'GET /api/branches': () => ({ status: 200, body: { branches: [] } }),
      }),
    );
    renderApp('/app/technical/new');

    await screen.findByTestId('technical-tab-new');
    expect(screen.queryByTestId('shift-handover-open')).not.toBeInTheDocument();
  });
});

describe('the handover dialog', () => {
  async function openDialog(
    extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
  ) {
    installApiMock(shellRoutes(RECEPTIONIST_USER, extra));
    const user = userEvent.setup();
    renderApp('/app/issues');
    await user.click(await screen.findByTestId('shift-handover-open'));
    return { user, dialog: await screen.findByRole('dialog', { name: 'Đổi ca' }) };
  }

  it('shows the current shift and who is on it', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText(/Ca A · 06:00 – 14:00/)).toBeInTheDocument();
    expect(within(dialog).getByText('Nguyễn Văn A')).toBeInTheDocument();
    // The time is shown so the operator can see what they are confirming, and
    // is labelled as advisory — the server records the real instant.
    expect(within(dialog).getByTestId('handover-clock')).toBeInTheDocument();
    expect(within(dialog).getByText(/hệ thống ghi nhận giờ chính xác/)).toBeInTheDocument();
  });

  it('will not confirm without a reason and a receiver', async () => {
    const { user, dialog } = await openDialog();
    const confirm = within(dialog).getByTestId('handover-confirm');
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByTestId('handover-reason'), 'Có việc cá nhân');
    expect(confirm).toBeDisabled(); // a reason, but nobody named

    await user.type(within(dialog).getByTestId('handover-incoming-name'), 'Nguyễn Văn B');
    expect(confirm).toBeEnabled();
  });

  it('treats whitespace as no answer at all', async () => {
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByTestId('handover-reason'), '   ');
    await user.type(within(dialog).getByTestId('handover-incoming-name'), '   ');
    expect(within(dialog).getByTestId('handover-confirm')).toBeDisabled();
  });

  /**
   * THE SUGGESTION IS A SHORTCUT, NOT A DECISION.
   *
   * Ca A normally hands to Ca B, so Ca B starts selected. But every shift stays
   * pickable, because Ca A and Ca A4 both start at 06:00 and the rota genuinely
   * cannot be derived — a receptionist covering an unusual pattern has to be
   * able to say what is actually happening.
   */
  it('suggests the usual next shift but offers all five', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByTestId('handover-shift-B')).toHaveAttribute('aria-pressed', 'true');
    for (const code of ['A', 'B', 'C', 'A4', 'C4']) {
      expect(within(dialog).getByTestId(`handover-shift-${code}`)).toBeInTheDocument();
    }
  });

  it('sends the reason, the receiver and the chosen shift — and NO timestamp', async () => {
    let body: Record<string, unknown> | null = null;
    const { user, dialog } = await openDialog({
      'POST /api/reception/shifts/handover': (init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          status: 201,
          body: { handover: { id: 'h1' }, session: session({ id: 's2', shiftType: 'C' }) },
        };
      },
    });

    await user.type(within(dialog).getByTestId('handover-reason'), '  Có việc cá nhân  ');
    await user.type(within(dialog).getByTestId('handover-incoming-name'), '  Nguyễn Văn B  ');
    await user.click(within(dialog).getByTestId('handover-shift-C'));
    await user.click(within(dialog).getByTestId('handover-confirm'));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'C',
    });
    // Named explicitly: a client-supplied instant would let a wrongly-set
    // reception PC decide which receptionist owns the orders at the boundary.
    expect(body).not.toHaveProperty('actualHandoverAt');
    expect(body).not.toHaveProperty('handoverAt');
  });

  it('sends an optional handover note only when one was written', async () => {
    let body: Record<string, unknown> | null = null;
    const routes = {
      'POST /api/reception/shifts/handover': (init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { status: 201, body: { handover: { id: 'h1' }, session: session() } };
      },
    };

    const { user, dialog } = await openDialog(routes);
    await user.type(within(dialog).getByTestId('handover-reason'), 'Có việc');
    await user.type(within(dialog).getByTestId('handover-incoming-name'), 'B');
    await user.type(within(dialog).getByTestId('handover-note'), 'Phòng 101 chờ kỹ thuật');
    await user.click(within(dialog).getByTestId('handover-confirm'));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.note).toEqual({ content: 'Phòng 101 chờ kỹ thuật' });
  });

  it('shows the server’s refusal rather than closing as if it worked', async () => {
    const { user, dialog } = await openDialog({
      'POST /api/reception/shifts/handover': () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Người nhận ca đang có một ca làm việc khác chưa kết thúc.',
          },
        },
      }),
    });

    await user.type(within(dialog).getByTestId('handover-reason'), 'Có việc');
    await user.type(within(dialog).getByTestId('handover-incoming-name'), 'B');
    await user.click(within(dialog).getByTestId('handover-confirm'));

    expect(
      await screen.findByText('Người nhận ca đang có một ca làm việc khác chưa kết thúc.'),
    ).toBeInTheDocument();
    // Still open, so the receptionist can correct it.
    expect(screen.getByRole('dialog', { name: 'Đổi ca' })).toBeInTheDocument();
  });

  it('can be cancelled without sending anything', async () => {
    let posted = 0;
    const { user, dialog } = await openDialog({
      'POST /api/reception/shifts/handover': () => {
        posted += 1;
        return { status: 201, body: { handover: { id: 'h1' }, session: session() } };
      },
    });

    await user.click(within(dialog).getByTestId('handover-cancel'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Đổi ca' })).not.toBeInTheDocument(),
    );
    expect(posted).toBe(0);
  });
});
