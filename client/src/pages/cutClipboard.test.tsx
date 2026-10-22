/**
 * CẮT is cut, not hide — the clipboard half of it.
 *
 * WHY THIS FILE EXISTS SEPARATELY: the property under test is an ORDERING one.
 * The value must reach the Windows clipboard BEFORE the field leaves the
 * screen, because a receptionist who loses the value from the screen without
 * gaining it in the clipboard cannot create the reservation and cannot get the
 * value back — the field stays hidden for the rest of the claim cycle.
 *
 * These assert what the components hand to `copyText`, and control whether it
 * succeeds. That `copyText` then reaches the real OS clipboard via
 * `navigator.clipboard.writeText` is proved separately in `lib/copy.test.ts` —
 * it has to be, because `userEvent.setup()` installs its own stub over
 * `navigator.clipboard`, so a component test asserting the browser API directly
 * would be asserting user-event's stub rather than the browser's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import { copyText } from '../lib/copy';

vi.mock('../lib/copy', () => ({
  copyText: vi.fn(),
  useCopy: () => ({ copied: false, copy: vi.fn() }),
}));

const copyTextMock = vi.mocked(copyText);

const NOW = new Date('2026-08-10T05:00:00.000Z');
const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' };

const CUSTOMER = 'Charlie Nguyen';
const TOTAL = 891_000;

/** A real multi-line note: the line breaks are part of the contract. */
const PMS_NOTE = [
  'BK 5832616717_1STAN_1 ĐÊM 891.000 PAY AFTER CHECK-IN CI',
  '11/08 CÓ SĐT +886 960 617 206 KHÁCH ĐẾN KHOẢNG 18:00',
].join('\n');

beforeEach(() => {
  copyTextMock.mockReset();
  copyTextMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    customerName: CUSTOMER,
    phone: '+886960617206',
    bookingCode: '5832616717',
    checkInDate: '2026-08-11',
    checkOutDate: '2026-08-12',
    checkInTime: null,
    checkOutTime: null,
    totalAmount: TOTAL,
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
    adminPmsNote: PMS_NOTE,
    claimedBy: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimCycle: 0,
    cutFields: [],
    ...over,
  };
}

function listItem() {
  return {
    id: 'bk1',
    bookingCode: '5832616717',
    customerName: CUSTOMER,
    phone: null,
    branch: BRANCH,
    sourcePlatform: 'BOOKING_COM',
    businessType: 'DIRECT',
    verificationStatus: 'NOT_SUBMITTED',
    checkInDate: '2026-08-11',
    checkOutDate: '2026-08-12',
    numberOfRooms: 1,
    roomSummary: '1 phòng',
    totalAmount: TOTAL,
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
  };
}

/** Mounts the queue. `cutOk` decides whether the server accepts the cut. */
function mount(over: Record<string, unknown> = {}, cutOk = true) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: {
        counts: { new: 1, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 },
        serverNow: NOW.toISOString(),
      },
    }),
    'GET /api/bookings/new?pageSize=100': () => ({
      status: 200,
      body: { bookings: [listItem()], pagination: { page: 1, pageSize: 100, total: 1 } },
    }),
    'GET /api/bookings/bk1': () => ({
      status: 200,
      body: { booking: detail(over), serverNow: NOW.toISOString() },
    }),
    'POST /api/bookings/bk1/cut': () =>
      cutOk
        ? {
            status: 200,
            body: {
              claimedAt: NOW.toISOString(),
              claimExpiresAt: inMs(180_000),
              claimCycle: 0,
              cutFields: ['CUSTOMER_NAME'],
              serverNow: NOW.toISOString(),
            },
          }
        : { status: 409, body: { error: { code: 'CONFLICT', message: 'Đơn đã có người nhận.' } } },
  });
}

/* ================================================================== */
/* The clipboard receives the ORIGINAL value                           */
/* ================================================================== */

describe('CẮT writes to the system clipboard', () => {
  it('copies the exact customer name', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith(CUSTOMER));
  });

  it('copies the total amount', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-TOTAL_AMOUNT'));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));
    // The same string the copy button it replaced would have produced.
    expect(String(copyTextMock.mock.calls[0]![0])).toContain('891');
  });

  it('copies the COMPLETE PMS note, line breaks intact', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-PMS_NOTE'));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith(PMS_NOTE));
    const written = String(copyTextMock.mock.calls[0]![0]);
    expect(written.split('\n')).toHaveLength(2);
    expect(written).toContain('KHÁCH ĐẾN KHOẢNG 18:00');
    expect(written.endsWith('18:00')).toBe(true);
  });

  it('copies each field independently, never the wrong one', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-PMS_NOTE'));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledTimes(1));

    // The note, not the guest and not the amount.
    expect(copyTextMock).toHaveBeenCalledWith(PMS_NOTE);
    expect(copyTextMock).not.toHaveBeenCalledWith(CUSTOMER);
  });
});

/* ================================================================== */
/* Copy happens BEFORE hide                                            */
/* ================================================================== */

describe('the order of operations', () => {
  it('writes to the clipboard before asking the server to hide anything', async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    /*
      The clipboard write is held open deliberately. While it is unresolved the
      server must not have been told anything — that is the ordering guarantee,
      and it cannot be faked by observing which line of a test ran first.
    */
    let release!: (ok: boolean) => void;
    copyTextMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    const posted = () =>
      fetchMock.mock.calls.some(
        ([u, init]) =>
          String(u) === '/api/bookings/bk1/cut' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));

    expect(copyTextMock).toHaveBeenCalledWith(CUSTOMER);
    expect(posted()).toBe(false); // still nothing sent

    release(true);
    await waitFor(() => expect(posted()).toBe(true));
  });

  it('hides the field once the cut succeeds', async () => {
    // The server is the source of truth for what is hidden; after the mutation
    // the refetched payload carries the field as taken.
    mount({ cutFields: ['CUSTOMER_NAME'] });
    renderApp('/app/new');

    const detailPanel = within(await screen.findByTestId('booking-detail'));
    expect(detailPanel.queryByText(CUSTOMER)).not.toBeInTheDocument();
    expect(detailPanel.getAllByTestId('cut-placeholder').length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* A failed clipboard write aborts the whole CẮT                       */
/* ================================================================== */

describe('when the clipboard write fails', () => {
  beforeEach(() => {
    // `copyText` never throws — it catches the browser refusal, tries the
    // legacy fallback, and reports false. That is the contract being simulated.
    copyTextMock.mockResolvedValue(false);
  });

  it('does NOT hide the field', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));

    // Still on screen, still cuttable — the receptionist lost nothing.
    expect(await screen.findByTestId('cut-CUSTOMER_NAME')).toBeInTheDocument();
    const detailPanel = within(screen.getByTestId('booking-detail'));
    expect(detailPanel.getAllByText(CUSTOMER).length).toBeGreaterThan(0);
    expect(detailPanel.queryByTestId('cut-placeholder')).not.toBeInTheDocument();
  });

  it('does NOT tell the server, so no claim is started', async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));
    await screen.findByText(/Không sao chép được vào clipboard/);

    const posted = fetchMock.mock.calls.some(
      ([u, init]) =>
        String(u) === '/api/bookings/bk1/cut' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posted).toBe(false);
  });

  it('says plainly that nothing was cut', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    await user.click(await screen.findByTestId('cut-CUSTOMER_NAME'));

    expect(await screen.findByText(/Chưa CẮT thông tin này/)).toBeInTheDocument();
  });

  it('leaves the button usable for a retry', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/new');

    const button = await screen.findByTestId('cut-CUSTOMER_NAME');
    await user.click(button);
    await screen.findByText(/Không sao chép được vào clipboard/);

    await waitFor(() => expect(screen.getByTestId('cut-CUSTOMER_NAME')).not.toBeDisabled());
  });
});
