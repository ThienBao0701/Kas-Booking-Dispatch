/**
 * The CUT claim, as the receptionist experiences it.
 *
 * WHAT THESE TESTS ARE NOT: the security boundary. The server owns the claim,
 * and `server/tests/bookingClaim.test.ts` proves it — including the concurrent
 * race. What is checked here is that the screen tells the truth about who owns
 * an order, that the countdown is derived from the SERVER's deadline rather
 * than started locally, and that the duplicate warning is where a person will
 * actually see it.
 *
 * The countdown assertions freeze time with fake timers so "02:59" is exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import {
  ADMIN_USER,
  EMPTY_OPERATIONAL_BLOCKS,
  RECEPTIONIST_USER,
  installApiMock,
  renderApp,
} from '../test/utils';
import { BookingDetailView } from '../components/BookingDetailView';
import { copyText } from '../lib/copy';
import { claimStateOf, DUPLICATE_WARNING, formatRemaining } from '../lib/claim';

/*
  CẮT copies before it hides, so the clipboard has to succeed for the rest of
  the flow to happen at all. jsdom has no working clipboard, so it is stubbed
  here as succeeding; the failure path and the real browser API are covered in
  `cutClipboard.test.tsx` and `lib/copy.test.ts`.
*/
vi.mock('../lib/copy', () => ({
  copyText: vi.fn(),
  useCopy: () => ({ copied: false, copy: vi.fn() }),
}));

// Re-armed per test: the afterEach below calls `vi.restoreAllMocks()`, which
// strips the resolved value and would leave `copyText` returning undefined —
// silently aborting every CẮT after the first test in this file.
beforeEach(() => {
  vi.mocked(copyText).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const NOW = new Date('2026-08-09T10:00:00.000Z');
const BRANCH = {
  id: 1,
  code: 'TRUONG_DINH_05',
  hotelName: 'Saigon Hotel',
  address: '05 Trương Định',
};

/** Absolute instant `ms` after NOW, as the server would send it. */
function inMs(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'bk1',
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    businessType: 'DIRECT',
    businessTypeManuallyConfirmed: false,
    hotelName: 'Saigon Hotel',
    branch: BRANCH,
    branchId: 1,
    customerName: 'NGUYEN VAN A',
    phone: '+84901234567',
    bookingCode: '6037224525',
    checkInDate: '2026-08-10',
    checkOutDate: '2026-08-11',
    checkInTime: null,
    checkOutTime: null,
    totalAmount: 609_120,
    currency: 'VND',
    paymentStatus: 'PAY_AFTER',
    specialRequest: null,
    isLastMinute: false,
    rooms: [],
    warnings: [],
    proofs: [],
    guests: [],
    sentAt: NOW.toISOString(),
    sentBy: null,
    completedBy: null,
    reviewedBy: null,
    createdBy: null,
    completedAt: null,
    reviewedAt: null,
    receivedAt: null,
    adminPmsNote: null,
    // Unclaimed by default.
    claimedBy: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimCycle: 0,
    ...over,
  };
}

function listItem(over: Record<string, unknown> = {}) {
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
    sentAt: NOW.toISOString(),
    sentBy: null,
    status: 'NEW',
    missingNightlyPriceCount: 0,
    warningCount: 0,
    latestAttemptNumber: 0,
    latestRejectionReason: null,
    submittedAt: null,
    reviewedAt: null,
    claimedBy: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimCycle: 0,
    ...over,
  };
}

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function mountQueue(
  user: typeof ADMIN_USER,
  bookingOver: Record<string, unknown> = {},
  extra: Record<string, Handler> = {},
) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/bookings/new?pageSize=100': () => ({
      status: 200,
      body: { bookings: [listItem(bookingOver)], pagination: { page: 1, pageSize: 100, total: 1 } },
    }),
    /*
      `serverNow` IS ALWAYS SENT BY THE REAL API, so it is always sent here.

      It used to be omitted, and that omission hid a frozen countdown: the
      offset was recomputed every render, which cancelled `Date.now()` out and
      pinned the display to its opening value. Every test passed, because
      without `serverNow` the offset was zero and the arithmetic came out right.
      A fixture that is easier than production is a fixture that tests nothing.
    */
    'GET /api/bookings/bk1': () => ({
      status: 200,
      body: { booking: detail(bookingOver), serverNow: NOW.toISOString() },
    }),
    ...extra,
  });
}

/* ================================================================== */
/* Pure helpers                                                        */
/* ================================================================== */

describe('formatRemaining', () => {
  it('renders mm:ss', () => {
    expect(formatRemaining(3 * 60 * 1000)).toBe('03:00');
    expect(formatRemaining(179_000)).toBe('02:59');
    expect(formatRemaining(61_000)).toBe('01:01');
    expect(formatRemaining(1_000)).toBe('00:01');
  });

  it('floors at zero rather than going negative', () => {
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(-5_000)).toBe('00:00');
  });
});

describe('claimStateOf — derived from the absolute deadline', () => {
  const base = { claimedBy: null, claimedAt: null, claimCycle: 0 };

  it('is UNCLAIMED with no claim', () => {
    expect(claimStateOf({ ...base, claimedByUserId: null, claimExpiresAt: null }, 2)).toBe('UNCLAIMED');
  });

  it('is MINE when I hold an unexpired claim', () => {
    expect(
      claimStateOf({ ...base, claimedByUserId: 2, claimExpiresAt: inMs(60_000) }, 2, NOW.getTime()),
    ).toBe('MINE');
  });

  it('is OTHERS when someone else holds it', () => {
    expect(
      claimStateOf({ ...base, claimedByUserId: 9, claimExpiresAt: inMs(60_000) }, 2, NOW.getTime()),
    ).toBe('OTHERS');
  });

  it('is EXPIRED once the deadline passes — even for my own claim', () => {
    // A stale polled list must not keep presenting an elapsed claim as active.
    expect(
      claimStateOf({ ...base, claimedByUserId: 2, claimExpiresAt: inMs(-1) }, 2, NOW.getTime()),
    ).toBe('EXPIRED');
  });
});

/* ================================================================== */
/* §1 — the top "take this order" card is gone                         */
/* ================================================================== */

describe('the removed CUT card', () => {
  it('shows no "Nhận đơn để tạo trên hệ thống" block', async () => {
    mountQueue(RECEPTIONIST_USER);
    renderApp('/app/new');

    await screen.findByTestId('pms-note-card');
    expect(screen.queryByText(/Nhận đơn để tạo trên hệ thống/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bấm CUT để nhận đơn/)).not.toBeInTheDocument();
  });

  it('offers no global CUT action anywhere on the page', async () => {
    // Taking the order is not a separate decision any more; it happens on the
    // first field the receptionist actually takes.
    mountQueue(RECEPTIONIST_USER);
    renderApp('/app/new');

    await screen.findByTestId('pms-note-card');
    expect(screen.queryByTestId('claim-cut')).not.toBeInTheDocument();
    expect(screen.queryByTestId('claim-panel')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* §2 — the three controls are CẮT                                     */
/* ================================================================== */

describe('the three CẮT controls', () => {
  it('replaces all three receptionist copy actions', async () => {
    mountQueue(RECEPTIONIST_USER, { adminPmsNote: 'BK 6037224525_1STAN_1 ĐÊM' });
    renderApp('/app/new');

    for (const field of ['CUSTOMER_NAME', 'TOTAL_AMOUNT', 'PMS_NOTE']) {
      expect(await screen.findByTestId(`cut-${field}`)).toHaveTextContent('CẮT');
    }
    // And the copy actions they replaced are gone for reception.
    expect(screen.queryByRole('button', { name: /Sao chép PMS Note/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sao chép Tên khách/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sao chép Tổng tiền/ })).not.toBeInTheDocument();
  });

  it('POSTs the field name to the cut endpoint', async () => {
    const fetchMock = mountQueue(RECEPTIONIST_USER, {}, {
      'POST /api/bookings/bk1/cut': () => ({
        status: 200,
        body: {
          claimedAt: NOW.toISOString(),
          claimExpiresAt: inMs(180_000),
          claimCycle: 0,
          cutFields: ['CUSTOMER_NAME'],
          serverNow: NOW.toISOString(),
        },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === '/api/bookings/bk1/cut' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(String((post as unknown as [string, RequestInit])[1].body)).toContain('CUSTOMER_NAME');
    });
  });

  it('surfaces the server conflict when someone else won the race', async () => {
    mountQueue(RECEPTIONIST_USER, {}, {
      'POST /api/bookings/bk1/cut': () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Đơn này đã được Lễ tân Hai nhận. Bạn không thể nhận đơn này.',
          },
        },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));
    expect(await screen.findByText(/đã được Lễ tân Hai nhận/)).toBeInTheDocument();
  });
});

/* ================================================================== */
/* §2/§4 — a cut field disappears, and ONLY that field                 */
/* ================================================================== */

describe('what a CẮT hides', () => {
  const held = {
    claimedByUserId: RECEPTIONIST_USER.id,
    claimedAt: NOW.toISOString(),
    claimExpiresAt: inMs(120_000),
    adminPmsNote: 'BK 6037224525_1STAN_1 ĐÊM',
  };

  /*
    Assertions are scoped to the DETAIL panel.

    The left-hand queue lists every booking by guest name, and that list is a
    different payload with no cut state on it. CẮT is defined on the three
    booking-detail controls, so the detail is where "the information is no
    longer shown" has to hold.
  */
  const panel = () => screen.findByTestId('booking-detail');

  it('hides ONLY the customer name', async () => {
    mountQueue(RECEPTIONIST_USER, { ...held, cutFields: ['CUSTOMER_NAME'] });
    renderApp('/app/new');

    const detail = within(await panel());
    // Gone: the field value AND the heading that repeats it.
    expect(detail.queryByText('NGUYEN VAN A')).not.toBeInTheDocument();
    expect(detail.getAllByTestId('cut-placeholder').length).toBeGreaterThan(0);
    // Untouched: the other two still show their values and their buttons.
    expect(detail.getByTestId('pms-note-text')).toHaveTextContent('BK 6037224525_1STAN_1 ĐÊM');
    expect(detail.getByTestId('cut-TOTAL_AMOUNT')).toBeInTheDocument();
    expect(detail.getByTestId('cut-PMS_NOTE')).toBeInTheDocument();
    expect(detail.queryByTestId('cut-CUSTOMER_NAME')).not.toBeInTheDocument();
  });

  it('hides ONLY the total amount', async () => {
    mountQueue(RECEPTIONIST_USER, { ...held, cutFields: ['TOTAL_AMOUNT'] });
    renderApp('/app/new');

    const detail = within(await panel());
    // Twice on purpose: the sticky heading and the "Tên khách" field.
    expect(detail.getAllByText('NGUYEN VAN A').length).toBe(2);
    expect(detail.getByTestId('pms-note-text')).toBeInTheDocument();
    expect(detail.queryByTestId('cut-TOTAL_AMOUNT')).not.toBeInTheDocument();
    expect(detail.getByTestId('cut-CUSTOMER_NAME')).toBeInTheDocument();
    expect(detail.getByTestId('cut-PMS_NOTE')).toBeInTheDocument();
  });

  it('hides ONLY the PMS note', async () => {
    mountQueue(RECEPTIONIST_USER, { ...held, cutFields: ['PMS_NOTE'] });
    renderApp('/app/new');

    const detail = within(await panel());
    expect(detail.queryByTestId('pms-note-text')).not.toBeInTheDocument();
    expect(detail.getAllByText('NGUYEN VAN A').length).toBe(2);
    expect(detail.getByTestId('cut-CUSTOMER_NAME')).toBeInTheDocument();
    expect(detail.getByTestId('cut-TOTAL_AMOUNT')).toBeInTheDocument();
    expect(detail.queryByTestId('cut-PMS_NOTE')).not.toBeInTheDocument();
  });

  it('hides all three once all three are taken', async () => {
    mountQueue(RECEPTIONIST_USER, {
      ...held,
      cutFields: ['CUSTOMER_NAME', 'TOTAL_AMOUNT', 'PMS_NOTE'],
    });
    renderApp('/app/new');

    const detail = within(await panel());
    for (const field of ['CUSTOMER_NAME', 'TOTAL_AMOUNT', 'PMS_NOTE']) {
      expect(detail.queryByTestId(`cut-${field}`)).not.toBeInTheDocument();
    }
    expect(detail.queryByTestId('pms-note-text')).not.toBeInTheDocument();
    expect(detail.queryByText('NGUYEN VAN A')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* §5 — the countdown is only digits                                   */
/* ================================================================== */

describe('the countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  it('is bare mm:ss with no labels or timestamps', async () => {
    mountQueue(RECEPTIONIST_USER, {
      claimedByUserId: RECEPTIONIST_USER.id,
      claimedBy: { id: RECEPTIONIST_USER.id, fullName: 'Lễ tân Một' },
      claimedAt: NOW.toISOString(),
      // The extra 900 ms absorbs real time elapsing during the async render, so
      // the floored display is deterministically 02:59.
      claimExpiresAt: inMs(179_900),
    });
    renderApp('/app/new');

    const countdown = await screen.findByTestId('claim-countdown');
    expect(countdown.textContent).toBe('02:59');
    expect(screen.queryByText(/Bạn đã CẮT lúc/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hết hạn lúc/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bạn đã nhận đơn này/)).not.toBeInTheDocument();
  });

  it('ticks down without ever restarting', async () => {
    mountQueue(RECEPTIONIST_USER, {
      claimedByUserId: RECEPTIONIST_USER.id,
      claimedAt: NOW.toISOString(),
      claimExpiresAt: inMs(180_900),
    });
    renderApp('/app/new');

    const countdown = await screen.findByTestId('claim-countdown');
    expect(countdown.textContent).toBe('03:00');

    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(countdown.textContent).toBe('02:55'));
  });

  it('REGRESSION: keeps ticking even though the server sends serverNow', async () => {
    /*
      The bug this pins: the server-clock offset was recomputed on every render,
      so `expiry - (now + (serverNow - now))` collapsed to `expiry - serverNow`
      — a constant. The display froze at its opening value until F5, and only
      when `serverNow` was present, which is always in production and was never
      in these fixtures.

      Three separate reads over ten seconds, because a single "it changed once"
      assertion would still pass against a timer that ticks once and stops.
    */
    mountQueue(RECEPTIONIST_USER, {
      claimedByUserId: RECEPTIONIST_USER.id,
      claimedAt: NOW.toISOString(),
      claimExpiresAt: inMs(180_900),
    });
    renderApp('/app/new');

    const countdown = await screen.findByTestId('claim-countdown');
    expect(countdown.textContent).toBe('03:00');

    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(countdown.textContent).toBe('02:57'));

    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(countdown.textContent).toBe('02:54'));

    await vi.advanceTimersByTimeAsync(4_000);
    await waitFor(() => expect(countdown.textContent).toBe('02:50'));
  });

  it('reaches 00:00 and stops there', async () => {
    mountQueue(RECEPTIONIST_USER, {
      claimedByUserId: RECEPTIONIST_USER.id,
      claimedAt: NOW.toISOString(),
      claimExpiresAt: inMs(3_000),
    });
    renderApp('/app/new');

    const countdown = await screen.findByTestId('claim-countdown');
    await vi.advanceTimersByTimeAsync(10_000);
    // Floored, never negative.
    await waitFor(() => expect(countdown.textContent).toBe('00:00'));
  });

  it('is measured against the SERVER clock, so a wound-back PC cannot extend it', async () => {
    // The machine is 10 minutes behind the server. Without the offset the
    // display would read far more than the real remaining time.
    vi.setSystemTime(new Date(NOW.getTime() - 600_000));
    const claimed = {
      claimedByUserId: RECEPTIONIST_USER.id,
      claimedAt: NOW.toISOString(),
      claimExpiresAt: inMs(120_900),
    };
    mountQueue(RECEPTIONIST_USER, claimed, {
      'GET /api/bookings/bk1': () => ({
        status: 200,
        body: { booking: detail(claimed), serverNow: NOW.toISOString() },
      }),
    });
    renderApp('/app/new');

    const countdown = await screen.findByTestId('claim-countdown');
    expect(countdown.textContent).toBe('02:00');
  });

  it('shows no countdown when another receptionist holds the claim', async () => {
    mountQueue(RECEPTIONIST_USER, {
      claimedByUserId: 999,
      claimedBy: { id: 999, fullName: 'Lễ tân Hai' },
      claimedAt: NOW.toISOString(),
      claimExpiresAt: inMs(120_000),
    });
    renderApp('/app/new');

    await screen.findByTestId('pms-note-card');
    expect(screen.queryByTestId('claim-countdown')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* §13 — Admin is untouched                                            */
/* ================================================================== */

describe('Admin', () => {
  /*
    Rendered directly rather than through /app/new: an Admin's "Đơn mới" is the
    branch-overview list and has no detail panel at all, so routing there would
    prove nothing about the fields. What matters is that the same component,
    given `isAdmin` and no cut controller, renders exactly what it always did.
  */
  function mountDetail(over: Record<string, unknown> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BookingDetailView
            booking={{ ...detail(over), ...EMPTY_OPERATIONAL_BLOCKS } as never}
            isAdmin
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('keeps every copy button and is offered no CẮT', () => {
    mountDetail({ adminPmsNote: 'BK 6037224525_1STAN_1 ĐÊM' });

    expect(screen.getByRole('button', { name: /Sao chép PMS Note/ })).toBeInTheDocument();
    for (const field of ['CUSTOMER_NAME', 'TOTAL_AMOUNT', 'PMS_NOTE']) {
      expect(screen.queryByTestId(`cut-${field}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('cut-placeholder')).not.toBeInTheDocument();
  });

  it('still sees values a receptionist has cut', () => {
    // §12: the cut list is never sent to an Admin, so nothing is hidden — even
    // for an order a receptionist has taken all three fields off.
    mountDetail({
      adminPmsNote: 'BK 6037224525_1STAN_1 ĐÊM',
      cutFields: [],
      claimedByUserId: 999,
      claimedBy: { id: 999, fullName: 'Lễ tân Hai' },
    });

    expect(screen.getAllByText('NGUYEN VAN A').length).toBeGreaterThan(0);
    expect(screen.getByTestId('pms-note-text')).toHaveTextContent('BK 6037224525_1STAN_1 ĐÊM');
  });
});

/* ================================================================== */
/* §10 — the duplicate warning stays                                   */
/* ================================================================== */

describe('the duplicate warning', () => {
  it('sits immediately above the submit button, not in a tooltip', async () => {
    mountQueue(RECEPTIONIST_USER);
    renderApp('/app/new');

    const warning = await screen.findByTestId('duplicate-warning');
    expect(warning).toHaveTextContent(DUPLICATE_WARNING);
    // Visible text, not a title/aria-only affordance, and nothing added to it.
    expect(warning.textContent?.trim()).toBe(DUPLICATE_WARNING);
  });

  it('uses the operator wording verbatim', () => {
    expect(DUPLICATE_WARNING).toBe(
      'Vui lòng kiểm tra đơn trước khi gửi để đảm bảo không bị trùng nhé.',
    );
  });

  it('sits immediately before the "Gửi Admin kiểm tra" button', async () => {
    mountQueue(RECEPTIONIST_USER);
    renderApp('/app/new');

    const warning = await screen.findByTestId('duplicate-warning');
    const submit = screen.getByRole('button', { name: /Gửi Admin kiểm tra/ });
    // Document order: the warning precedes the control it is warning about.
    expect(warning.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
