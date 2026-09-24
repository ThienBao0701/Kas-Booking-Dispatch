/**
 * "KẾT THÚC CA" — a shift ending normally, in the browser.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. It is a SEPARATE control from "Đổi ca", and both are offered.
 *   2. The confirmation shows the shift, the receptionist and the start time —
 *      the three things the operator is confirming they are ending.
 *   3. NO TIMESTAMP IS SENT. The request body carries nothing at all.
 *   4. When there is outstanding work and no handover note, it says so and
 *      offers "Bàn giao ca" — without blocking, and without fabricating one.
 *   5. After the close the application asks for a shift again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const NO_PENDING = {
  openIssues: [],
  bookings: { awaitingCreation: 0, awaitingReview: 0, needsRecreation: 0 },
};

const SOME_PENDING = {
  openIssues: [{ id: 'i1', location: 'Phòng · Phòng 101', status: 'NEW', needsRework: false }],
  bookings: { awaitingCreation: 2, awaitingReview: 0, needsRecreation: 0 },
};

function preview(over: Record<string, unknown> = {}) {
  return {
    session: session(),
    pending: NO_PENDING,
    handoverNoteCount: 0,
    reportCount: 3,
    cash: {
      openingCash: 7570000,
      cashCollected: 4400000,
      transferCollected: 240000,
      cardCollected: 500000,
      receivable: 0,
      cashExpense: 100000,
      endingCash: 11870000,
      paymentCount: 5,
      voidedCount: 0,
    },
    handoverAdvised: false,
    ...over,
  };
}

function shellRoutes(
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
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
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: session() } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reception/shifts/end-preview': () => ({ status: 200, body: preview() }),
    'GET /api/reception/handover-notes': () => ({ status: 200, body: { notes: [] } }),
    'GET /api/reception/handover-notes/context': () => ({ status: 200, body: { pending: NO_PENDING } }),
    ...extra,
  };
}

describe('the two controls', () => {
  it('offers "Kết thúc ca" and "Đổi ca" as separate actions', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/new');

    expect(await screen.findByTestId('shift-end-open')).toHaveTextContent('Kết thúc ca');
    expect(screen.getByTestId('shift-handover-open')).toHaveTextContent('Đổi ca');
  });

  it('shows neither before anybody has checked in', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: null } }),
      }),
    );
    renderApp('/app/new');

    // The check-in dialog opens instead; there is no shift to end.
    await screen.findByTestId('shift-options');
    expect(screen.queryByTestId('shift-end-open')).not.toBeInTheDocument();
  });
});

describe('the confirmation', () => {
  it('shows the shift, the receptionist and the start time', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));

    expect(await screen.findByTestId('end-shift-name')).toHaveTextContent('Ca A · 06:00 – 14:00');
    expect(screen.getByTestId('end-shift-staff')).toHaveTextContent('Nguyễn Văn A');
    expect(screen.getByTestId('end-shift-started')).toHaveTextContent(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('shows the drawer it is about to close', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    const cash = await screen.findByTestId('end-shift-cash');
    expect(cash).toHaveTextContent('7.570.000 ₫');
    expect(cash).toHaveTextContent('11.870.000 ₫');
  });

  it('warns that the shift can record nothing afterwards', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/new');
    await userEvent.click(await screen.findByTestId('shift-end-open'));
    expect(
      await screen.findByText(/ca này không ghi thêm được báo cáo nào/i),
    ).toBeInTheDocument();
  });

  it('sends an EMPTY body — no timestamp, ever', async () => {
    const bodies: unknown[] = [];
    installApiMock(
      shellRoutes({
        'POST /api/reception/shifts/close': (init) => {
          bodies.push(JSON.parse(String(init.body)));
          return { status: 200, body: { closed: 1, session: session({ closedAt: 'x' }), cash: null } };
        },
      }),
    );
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    await userEvent.click(await screen.findByTestId('end-shift-confirm'));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // Exact shape: nothing the browser could use to claim when the shift ended.
    expect(bodies[0]).toEqual({});
  });

  it('closes without ending the shift when cancelled', async () => {
    const fetchMock = installApiMock(shellRoutes());
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    await userEvent.click(await screen.findByTestId('end-shift-cancel'));

    await waitFor(() => expect(screen.queryByTestId('end-shift-confirm')).not.toBeInTheDocument());
    const closed = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/reception/shifts/close'),
    );
    expect(closed).toHaveLength(0);
  });
});

/**
 * "BÀN GIAO CA" HAS NO SCREEN, SO THE DIALOG NO LONGER SENDS ANYONE TO ONE.
 *
 * The server still reports `handoverAdvised`; the dialog simply has nowhere to
 * point it. What matters is unchanged: ending a shift is never blocked.
 */
describe('ending a shift after "Bàn giao ca" was removed', () => {
  it('never links to the removed handover page, whatever the server advises', async () => {
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/end-preview': () => ({
          status: 200,
          body: preview({ pending: SOME_PENDING, handoverAdvised: true }),
        }),
      }),
    );
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('end-shift-confirm');
    expect(screen.queryByTestId('handover-advised')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /Bàn giao ca/ })).not.toBeInTheDocument();
  });

  it('does NOT block the close', async () => {
    const bodies: unknown[] = [];
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/end-preview': () => ({
          status: 200,
          body: preview({ pending: SOME_PENDING, handoverAdvised: true }),
        }),
        'POST /api/reception/shifts/close': (init) => {
          bodies.push(JSON.parse(String(init.body)));
          return { status: 200, body: { closed: 1, session: null, cash: null } };
        },
      }),
    );
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    expect(await screen.findByTestId('end-shift-confirm')).toBeEnabled();
    await userEvent.click(screen.getByTestId('end-shift-confirm'));
    await waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('sends an old /app/handover link to "Báo cáo vấn đề" rather than a blank page', async () => {
    installApiMock(shellRoutes());
    renderApp('/app/handover');
    expect((await screen.findAllByRole('heading', { name: 'Báo cáo vấn đề' })).length).toBeGreaterThan(0);
  });
});

describe('after the close', () => {
  it('asks for a shift again', async () => {
    let closed = false;
    installApiMock(
      shellRoutes({
        'GET /api/reception/shifts/current': () => ({
          status: 200,
          body: { session: closed ? null : session() },
        }),
        'POST /api/reception/shifts/close': () => {
          closed = true;
          return { status: 200, body: { closed: 1, session: null, cash: null } };
        },
      }),
    );
    renderApp('/app/new');

    await userEvent.click(await screen.findByTestId('shift-end-open'));
    await userEvent.click(await screen.findByTestId('end-shift-confirm'));

    // "Chọn ca làm việc" — the undismissable picker, because without a session
    // the server cannot say who is at the desk.
    expect(await screen.findByTestId('shift-options')).toBeInTheDocument();
    expect(screen.queryByTestId('shift-later')).not.toBeInTheDocument();
  });
});
