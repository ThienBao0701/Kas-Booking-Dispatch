/**
 * Chứng từ detail — editing "Lý do charge", and the absence of the operation
 * history.
 *
 * TWO SEPARATE CLAIMS ARE BEING MADE HERE, and only one of them is security.
 *
 * The editing control is offered to an Admin and withheld from Bộ phận đặt
 * phòng. That is a UI courtesy, NOT the boundary — the server refuses the write
 * in `assertReasonEditable`, and the server suite is what proves it. A test
 * that only checked the button would be testing the doormat, not the lock.
 *
 * The history assertions are the opposite: they are purely about what the
 * screen renders. The audit ROWS are still written for every change and every
 * card reveal, and `GET /api/charge-documents/:id/audit` still serves them —
 * so these tests deliberately assert that the section is gone WITHOUT asserting
 * anything about the records, which must survive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  BOOKING_DEPARTMENT_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = {
  id: 1,
  code: 'TRUONG_DINH_05',
  hotelName: 'Saigon Hotel',
  address: '05 Trương Định',
  branchNumber: 1,
};

const ORIGINAL_REASON = 'Khách không đến nhận phòng (no-show).';
const NEW_REASON = 'Khách huỷ sát giờ, đã xác nhận qua điện thoại.';

function doc(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    branch: BRANCH,
    bookingId: null,
    guestName: 'NGUYEN VAN A',
    bookingCode: 'BK-EXT-001',
    amount: 1_500_000,
    cardLast4: '1111',
    cardMasked: '•••• 1111',
    cardExpiry: '12/28',
    checkIn: '2026-08-01',
    checkOut: '2026-08-03',
    reason: ORIGINAL_REASON,
    status: 'CHUA_XU_LY',
    chargedAt: null,
    createdBy: { id: 1, fullName: 'Quản trị viên' },
    updatedBy: null,
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-01T02:00:00.000Z',
    attachments: [],
    ...over,
  };
}

function mountDetail(
  user: typeof ADMIN_USER,
  extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'GET /api/charge-documents/c1': () => ({ status: 200, body: { document: doc() } }),
    ...extra,
  });
}

/* ================================================================== */
/* Change 3 — the operation history is not on this screen              */
/* ================================================================== */

describe('operation history is no longer rendered', () => {
  it('shows no "Lịch sử thao tác" heading', async () => {
    mountDetail(ADMIN_USER);
    renderApp('/app/charge-documents/c1');

    // Wait for the page proper, then assert the section is absent.
    await screen.findByText('Lý do charge');
    expect(screen.queryByText('Lịch sử thao tác')).not.toBeInTheDocument();
    expect(screen.queryByTestId('charge-audit')).not.toBeInTheDocument();
  });

  it('does not even request the audit endpoint', async () => {
    // The section is gone, so the fetch that fed it should be gone too — a
    // screen that still pulls a trail it never shows is wasted work.
    const fetchMock = mountDetail(ADMIN_USER);
    renderApp('/app/charge-documents/c1');
    await screen.findByText('Lý do charge');

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/audit'))).toBe(false);
    });
  });
});

/* ================================================================== */
/* Change 2 — Admin edits the reason                                   */
/* ================================================================== */

describe('Admin can edit the charge reason', () => {
  it('offers the edit control and shows the current reason', async () => {
    mountDetail(ADMIN_USER);
    renderApp('/app/charge-documents/c1');

    expect(await screen.findByTestId('charge-reason')).toHaveTextContent(ORIGINAL_REASON);
    expect(screen.getByRole('button', { name: /Sửa lý do/ })).toBeInTheDocument();
  });

  it('PUTs the trimmed reason and shows the saved value', async () => {
    const fetchMock = mountDetail(ADMIN_USER, {
      'PUT /api/charge-documents/c1': () => ({
        status: 200,
        body: { document: doc({ reason: NEW_REASON }) },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');

    await user.click(await screen.findByRole('button', { name: /Sửa lý do/ }));
    const box = screen.getByTestId('charge-reason-input');
    await user.clear(box);
    // Deliberate surrounding whitespace: the value that leaves must be trimmed.
    await user.type(box, `   ${NEW_REASON}   `);
    await user.click(screen.getByRole('button', { name: /Lưu lý do/ }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/charge-documents/c1' &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeDefined();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).toEqual({ reason: NEW_REASON });
    });

    // The detail refreshes and the new reason is displayed, with feedback.
    expect(await screen.findByRole('status')).toHaveTextContent('Đã lưu lý do charge.');
  });

  it('refuses to send a blank reason', async () => {
    const fetchMock = mountDetail(ADMIN_USER, {
      'PUT /api/charge-documents/c1': () => ({ status: 200, body: { document: doc() } }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');

    await user.click(await screen.findByRole('button', { name: /Sửa lý do/ }));
    const box = screen.getByTestId('charge-reason-input');
    await user.clear(box);
    await user.type(box, '    ');
    await user.click(screen.getByRole('button', { name: /Lưu lý do/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Vui lòng nhập lý do charge.');
    // Nothing left the browser.
    const puts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts).toHaveLength(0);
  });

  it('surfaces a server refusal instead of pretending it saved', async () => {
    mountDetail(ADMIN_USER, {
      'PUT /api/charge-documents/c1': () => ({
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Chỉ Admin mới được sửa lý do charge.' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/charge-documents/c1');

    await user.click(await screen.findByRole('button', { name: /Sửa lý do/ }));
    const box = screen.getByTestId('charge-reason-input');
    await user.clear(box);
    await user.type(box, NEW_REASON);
    await user.click(screen.getByRole('button', { name: /Lưu lý do/ }));

    expect(await screen.findByText(/Chỉ Admin mới được sửa lý do charge/)).toBeInTheDocument();
  });
});

/* ================================================================== */
/* Change 2 — Bộ phận đặt phòng reads but does not edit                */
/* ================================================================== */

describe('Bộ phận đặt phòng cannot edit the reason', () => {
  it('sees the reason but is offered no edit control', async () => {
    mountDetail(BOOKING_DEPARTMENT_USER);
    renderApp('/app/charge-documents/c1');

    expect(await screen.findByTestId('charge-reason')).toHaveTextContent(ORIGINAL_REASON);
    expect(screen.queryByRole('button', { name: /Sửa lý do/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('charge-reason-input')).not.toBeInTheDocument();
  });
});
