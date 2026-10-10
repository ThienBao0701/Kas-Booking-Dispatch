/**
 * "Gửi lại đơn" (Admin recovery) and "Nhắc nhở" (Admin → one receptionist).
 *
 * The privacy of a reminder is enforced in the database by `recipientUserId`
 * and proved in `server/tests/reminders.test.ts`. What is checked here is that
 * each role is shown the right screen, that unread is visible, that opening one
 * marks it read, and that resending posts to the right order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  BOOKING_DEPARTMENT_USER,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = '2026-08-09T10:00:00.000Z';
const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' };

function expired(over: Record<string, unknown> = {}) {
  return {
    id: 'bk1',
    bookingCode: '6037224525',
    customerName: 'NGUYEN VAN A',
    phone: null,
    branch: BRANCH,
    sourcePlatform: 'BOOKING_COM',
    businessType: 'DIRECT',
    verificationStatus: 'NOT_SUBMITTED',
    checkInDate: '2026-08-10',
    checkOutDate: '2026-08-11',
    numberOfRooms: 1,
    roomSummary: '1 phòng',
    totalAmount: 609_120,
    currency: 'VND',
    paymentStatus: 'PAY_AFTER',
    isLastMinute: false,
    sentAt: NOW,
    sentBy: null,
    status: 'NEW',
    missingNightlyPriceCount: 0,
    warningCount: 0,
    latestAttemptNumber: 0,
    latestRejectionReason: null,
    submittedAt: null,
    reviewedAt: null,
    claimedBy: { id: 2, fullName: 'Lễ tân Một' },
    claimedByUserId: 2,
    claimedAt: '2026-08-09T09:57:00.000Z',
    claimExpiresAt: '2026-08-09T10:00:00.000Z',
    claimCycle: 0,
    ...over,
  };
}

function reminder(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    body: 'Nhớ kiểm tra kỹ mã booking trước khi tạo đơn.',
    createdAt: NOW,
    readAt: null,
    read: false,
    sender: { id: 1, fullName: 'Quản trị viên' },
    recipient: { id: RECEPTIONIST_USER.id, fullName: 'Lễ tân Một' },
    ...over,
  };
}

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function mount(user: typeof ADMIN_USER, extra: Record<string, Handler> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/bookings/expired-claims?pageSize=100': () => ({
      status: 200,
      body: {
        bookings: [expired()],
        pagination: { page: 1, pageSize: 100, total: 1 },
        serverNow: NOW,
      },
    }),
    'GET /api/reminders': () => ({ status: 200, body: { reminders: [reminder()] } }),
    'GET /api/reminders/unread-count': () => ({ status: 200, body: { count: 1 } }),
    'GET /api/admin/users': () => ({
      status: 200,
      body: {
        users: [
          { id: 2, username: 'letana', fullName: 'Lễ tân Một', role: 'RECEPTIONIST', active: true },
          { id: 9, username: 'letanb', fullName: 'Lễ tân Hai', role: 'RECEPTIONIST', active: true },
        ],
      },
    }),
    ...extra,
  });
}

/* ================================================================== */
/* Gửi lại đơn                                                         */
/* ================================================================== */

describe('Gửi lại đơn', () => {
  it('appears in the Admin menu', async () => {
    mount(ADMIN_USER);
    renderApp('/app/resend-orders');
    expect(await screen.findByRole('link', { name: /Gửi lại đơn/ })).toBeInTheDocument();
  });

  it('is absent from the receptionist menu', async () => {
    mount(RECEPTIONIST_USER);
    renderApp('/app/new');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: /Gửi lại đơn/ })).not.toBeInTheDocument();
  });

  it('shows why the order expired and who had it', async () => {
    mount(ADMIN_USER);
    renderApp('/app/resend-orders');

    const list = await screen.findByTestId('expired-claims');
    expect(within(list).getByText(/6037224525/)).toBeInTheDocument();
    expect(within(list).getByText(/Hết thời gian 3 phút/)).toBeInTheDocument();
    expect(within(list).getByText(/Lễ tân Một/)).toBeInTheDocument();
  });

  it('posts the resend for that order', async () => {
    const fetchMock = mount(ADMIN_USER, {
      'POST /api/bookings/bk1/resend': () => ({ status: 200, body: { success: true, claimCycle: 1 } }),
    });
    const user = userEvent.setup();
    renderApp('/app/resend-orders');

    await user.click(await screen.findByTestId('resend-bk1'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/bookings/bk1/resend' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
    });
  });

  it('surfaces a refusal instead of pretending it resent', async () => {
    mount(ADMIN_USER, {
      'POST /api/bookings/bk1/resend': () => ({
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'Đơn này đã được gửi lại rồi.' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/resend-orders');

    await user.click(await screen.findByTestId('resend-bk1'));
    expect(await screen.findByText(/đã được gửi lại rồi/)).toBeInTheDocument();
  });

  it('refuses a receptionist who types the URL', async () => {
    mount(RECEPTIONIST_USER);
    renderApp('/app/resend-orders');
    await waitFor(() => expect(screen.queryByTestId('expired-claims')).not.toBeInTheDocument());
  });
});

/* ================================================================== */
/* Nhắc nhở                                                            */
/* ================================================================== */

describe('Nhắc nhở', () => {
  it('is in the Admin menu', async () => {
    mount(ADMIN_USER);
    renderApp('/app/reminders');
    expect(await screen.findByRole('link', { name: /Nhắc nhở/ })).toBeInTheDocument();
  });

  it('is in the receptionist menu', async () => {
    mount(RECEPTIONIST_USER);
    renderApp('/app/reminders');
    expect(await screen.findByRole('link', { name: /Nhắc nhở/ })).toBeInTheDocument();
  });

  it('is absent for Bộ phận đặt phòng', async () => {
    mount(BOOKING_DEPARTMENT_USER);
    renderApp('/app/charge-documents');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: /Nhắc nhở/ })).not.toBeInTheDocument();
  });

  it('lets an Admin pick one receptionist and send', async () => {
    const fetchMock = mount(ADMIN_USER, {
      'POST /api/reminders': () => ({ status: 201, body: { reminder: reminder() } }),
    });
    const user = userEvent.setup();
    renderApp('/app/reminders');

    // Wait for the receptionist list to arrive before selecting — the <select>
    // renders with only its placeholder until the users query resolves.
    await screen.findByRole('option', { name: /Lễ tân Hai/ });
    await user.selectOptions(screen.getByLabelText('Người nhận'), '9');
    await user.type(screen.getByTestId('reminder-body'), 'Nhớ kiểm tra kỹ mã booking.');
    await user.click(screen.getByTestId('reminder-send'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/reminders' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      // ONE named recipient — never a broadcast.
      expect(body).toEqual({ recipientUserId: 9, body: 'Nhớ kiểm tra kỹ mã booking.' });
    });
  });

  it('refuses to send without a recipient', async () => {
    const fetchMock = mount(ADMIN_USER);
    const user = userEvent.setup();
    renderApp('/app/reminders');

    await user.type(await screen.findByTestId('reminder-body'), 'Thiếu người nhận');
    await user.click(screen.getByTestId('reminder-send'));

    expect(await screen.findByText('Vui lòng chọn lễ tân nhận nhắc nhở.')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([u, init]) =>
          String(u) === '/api/reminders' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('shows the receptionist an unread reminder, with a count in the heading', async () => {
    mount(RECEPTIONIST_USER);
    renderApp('/app/reminders');

    expect(await screen.findByText('Nhắc nhở (1)')).toBeInTheDocument();
    const list = screen.getByTestId('reminder-list');
    expect(within(list).getByText(/Nhớ kiểm tra kỹ mã booking/)).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Đánh dấu đã đọc/ })).toBeInTheDocument();
  });

  it('marks it read when the receptionist opens it', async () => {
    const fetchMock = mount(RECEPTIONIST_USER, {
      'POST /api/reminders/r1/read': () => ({
        status: 200,
        body: { reminder: reminder({ read: true, readAt: NOW }) },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/reminders');

    await user.click(await screen.findByTestId('reminder-read-r1'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/reminders/r1/read' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
    });
  });

  it('renders a read reminder as Đã đọc with no action', async () => {
    mount(RECEPTIONIST_USER, {
      'GET /api/reminders': () => ({
        status: 200,
        body: { reminders: [reminder({ read: true, readAt: NOW })] },
      }),
    });
    renderApp('/app/reminders');

    const list = await screen.findByTestId('reminder-list');
    // Awaited: the table shows its loading state before the rows arrive.
    expect(await within(list).findByText('Đã đọc')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Đánh dấu đã đọc/ })).not.toBeInTheDocument();
  });

  it('does not offer a receptionist the compose form', async () => {
    mount(RECEPTIONIST_USER);
    renderApp('/app/reminders');
    await screen.findByTestId('reminder-list');
    expect(screen.queryByTestId('reminder-send')).not.toBeInTheDocument();
  });

  it('shows an Admin whether what they sent was read', async () => {
    mount(ADMIN_USER, {
      'GET /api/reminders': () => ({
        status: 200,
        body: { reminders: [reminder({ read: true, readAt: NOW })] },
      }),
    });
    renderApp('/app/reminders');

    const list = await screen.findByTestId('reminder-list');
    expect(await within(list).findByText('Đã đọc')).toBeInTheDocument();
    // The recipient has a column of its own now, headed "Người nhận".
    expect(within(list).getByRole('columnheader', { name: 'Người nhận' })).toBeInTheDocument();
    expect(within(list).getByText('Lễ tân Một')).toBeInTheDocument();
  });

  /** Người nhận · Nội dung · Chi nhánh · Người gửi · Thời gian · Trạng thái. */
  it('lays the Admin’s reminders out as a compact table with the specified columns', async () => {
    mount(ADMIN_USER, {
      'GET /api/reminders': () => ({ status: 200, body: { reminders: [reminder()] } }),
    });
    renderApp('/app/reminders');

    const list = await screen.findByTestId('reminder-list');
    await within(list).findByText('Chưa đọc');
    const headers = within(list).getAllByRole('columnheader').map((h) => h.textContent);
    const wanted = ['Người nhận', 'Nội dung', 'Chi nhánh', 'Người gửi', 'Thời gian', 'Trạng thái'];
    const at = wanted.map((w) => headers.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});
