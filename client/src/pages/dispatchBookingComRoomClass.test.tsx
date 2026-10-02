/**
 * The Admin's Booking.com room-class selector and PMS-note review.
 *
 * What these tests are really guarding:
 *
 *   The internal code and the OTA room name are DIFFERENT FIELDS. The name
 *   Booking.com printed — "(0)" and all — is evidence of what was sold and must
 *   survive intact; the code is what our PMS calls it. Conflating them is the
 *   defect this screen exists to prevent.
 *
 *   The note is the BOOKING.COM note, from the Booking.com builder. An "AGD"
 *   prefix appearing here would mean a Booking.com reservation was printed in
 *   Agoda's format — asserted against directly, because the reference designs
 *   for this screen were Agoda screenshots.
 *
 *   The code the note prints is the code the ORDER WILL CARRY. That used to be
 *   guaranteed by writing each selection to a persisted draft and rendering the
 *   server's echo. There is no draft any more: the review lives in the browser
 *   and is written once, at Gửi. So the guarantee is now asserted where it
 *   actually matters — the code shown on screen is the code in the dispatch
 *   request, and the server re-resolves it against the branch's ACTIVE mapping.
 *
 *   The list of codes still comes from the server, per branch. The browser never
 *   invents a catalogue, and a code belonging to another branch is never offered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = {
  id: 1,
  code: 'TRUONG_DINH_05',
  hotelName: 'Saigon Hotel & Ben Thanh',
  address: '05 Trương Định',
  breakfastIncluded: false,
};
const BRANCH2 = {
  id: 2,
  code: 'LY_TU_TRONG_260',
  hotelName: 'Luxury Elegance Hotel',
  address: '260 Lý Tự Trọng',
  breakfastIncluded: false,
};

/** CN1's real catalogue shape: three classes, no DEL. */
const CN1_CLASSES = [
  { id: 'rc-stan', stableKey: 'standard', displayName: 'Standard', normalizedName: 'standard', pmsCode: 'STAN', active: true, sortOrder: 1, aliases: [], updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'rc-sup', stableKey: 'superior', displayName: 'Superior', normalizedName: 'superior', pmsCode: 'SUP', active: true, sortOrder: 2, aliases: [], updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'rc-defam', stableKey: 'deluxe-family', displayName: 'Deluxe Family', normalizedName: 'deluxefamily', pmsCode: 'DEFAM', active: true, sortOrder: 3, aliases: [], updatedAt: '2026-08-01T00:00:00.000Z' },
];

/** CN2 codes an Admin must not be able to put on a CN1 booking. */
const CN2_CLASSES = [
  { id: 'rc2-del', stableKey: 'deluxe', displayName: 'Deluxe', normalizedName: 'deluxe', pmsCode: 'DEL', active: true, sortOrder: 1, aliases: [], updatedAt: '2026-08-01T00:00:00.000Z' },
];

const mappingBody = (branchId: number) => ({
  active: {
    id: `v-${branchId}`,
    branchId,
    versionNumber: 1,
    status: 'ACTIVE',
    changeReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    activatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
    createdBy: null,
    activatedBy: null,
    roomClasses: branchId === 1 ? CN1_CLASSES : CN2_CLASSES,
  },
  draft: null,
});

/** The OTA name is deliberately one Booking.com really prints, "(0)" included. */
const OTA_ROOM_NAME = 'Standard Double Room No Window (0)';

/**
 * The extraction preview — the whole review, and the only thing that exists.
 *
 * No `id` and no `status`: the reservation has not been created. It is created
 * once, by the dispatch, when the Admin presses Gửi.
 */
function preview(overrides: Record<string, unknown> = {}) {
  return {
    persisted: false,
    booking: {
      bookingCode: '6312474567',
      hotelName: 'Saigon Hotel & Ben Thanh Market',
      sourcePlatform: 'BOOKING_COM',
      guestName: 'Thùy Chi Phan',
      phone: '+84964934713',
      checkIn: '2026-07-23',
      checkOut: '2026-07-25',
      currency: 'VND',
      totalAmount: 3_078_000,
      paymentStatus: 'PAY_AFTER',
      specialRequest: null,
      parserVersion: '4a.2.0',
      ...overrides,
    },
    suggestedBranch: BRANCH,
    branchConfidence: 100,
    branchConfident: true,
    requiresManualConfirmation: false,
    parserQuality: { score: 98, level: 'HIGH', requiresAdminReview: false, missingCriticalFields: [], warningCount: 0 },
    businessType: 'DIRECT',
    businessTypeConfidence: 90,
    businessTypeRequiresAdminConfirmation: false,
    businessTypeMatchedRules: ['retail-rate'],
    rooms: [
      {
        roomIndex: 1,
        roomName: OTA_ROOM_NAME,
        roomTotal: 1_539_000,
        nights: [
          { stayDate: '2026-07-23', amount: 648_000, currency: 'VND', isEstimated: false },
          { stayDate: '2026-07-24', amount: 891_000, currency: 'VND', isEstimated: false },
        ],
      },
    ],
    warnings: [],
    agoda: null,
  };
}

/** Nothing recognised — the honest answer for a name the mapping cannot read. */
const UNRESOLVED = {
  versionId: 'v-1',
  rooms: [
    {
      sourceRoomName: OTA_ROOM_NAME,
      status: 'UNRESOLVED',
      roomClassId: null,
      displayName: null,
      pmsCode: null,
      matchedAlias: null,
      matchType: 'NONE',
    },
  ],
};

/** The auto-detection the extract-time snapshot used to perform. */
const RESOLVED_STAN = {
  versionId: 'v-1',
  rooms: [
    {
      sourceRoomName: OTA_ROOM_NAME,
      status: 'RESOLVED',
      roomClassId: 'rc-stan',
      displayName: 'Standard',
      pmsCode: 'STAN',
      matchedAlias: null,
      matchType: 'DISPLAY_NAME',
    },
  ],
};

function mount(
  resolved: unknown = UNRESOLVED,
  extractBody: Record<string, unknown> = preview(),
  extra: Record<string, () => { status: number; body?: unknown }> = {},
) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH2] } }),
    'POST /api/bookings/extract': () => ({ status: 201, body: extractBody }),
    'GET /api/admin/branches/1/room-mapping': () => ({ status: 200, body: mappingBody(1) }),
    'GET /api/admin/branches/2/room-mapping': () => ({ status: 200, body: mappingBody(2) }),
    'POST /api/admin/branches/1/room-mapping/resolve': () => ({ status: 200, body: resolved }),
    // CN2 recognises nothing of CN1's names — a different branch, a different
    // catalogue. Never a cross-branch fallback.
    'POST /api/admin/branches/2/room-mapping/resolve': () => ({
      status: 200,
      body: { versionId: 'v-2', rooms: UNRESOLVED.rooms },
    }),
    ...extra,
  });
}

async function extract(user: ReturnType<typeof userEvent.setup>) {
  const textarea = await screen.findByRole('textbox');
  await user.type(textarea, 'Booking.com raw text');
  await user.click(screen.getByRole('button', { name: 'Trích xuất thông tin' }));
}

/* ================================================================== */
/* The OTA name and the internal code are different things             */
/* ================================================================== */

describe('the Hạng phòng section', () => {
  it('shows the Booking.com room name exactly as extracted', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const field = await screen.findByLabelText('Tên hạng phòng dòng 1');
    // The trailing "(0)" is part of what the platform printed.
    expect(field).toHaveValue(OTA_ROOM_NAME);
  });

  it('never replaces the OTA name with the internal code', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByLabelText('Tên hạng phòng dòng 1')).toHaveValue(OTA_ROOM_NAME);
    // The select only carries the value once its options have arrived.
    await waitFor(() => expect(screen.getByLabelText('Mã nội bộ dòng 1')).toHaveValue('rc-stan'));
    expect(screen.getByLabelText('Tên hạng phòng dòng 1')).toHaveValue(OTA_ROOM_NAME);
  });

  it('offers the real codes of the selected branch', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    await waitFor(() =>
      expect(within(select as HTMLElement).getAllByRole('option').length).toBeGreaterThan(1),
    );
    const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['— Chưa chọn —', 'STAN — Standard', 'SUP — Superior', 'DEFAM — Deluxe Family']);
    // CN2's Deluxe is not a CN1 code and must not be offered here.
    expect(options.some((o) => o?.startsWith('DEL —'))).toBe(false);
  });

  it('pre-selects a code the system detected, without asking again', async () => {
    // The resolve endpoint answers from the branch's ACTIVE mapping, which is
    // the work the extract-time snapshot used to do before a branch was known.
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await waitFor(() => expect(screen.getByLabelText('Mã nội bộ dòng 1')).toHaveValue('rc-stan'));
    expect(screen.getByTestId('bcom-room-1-status')).toHaveTextContent('hệ thống tự nhận diện');
  });

  it('shows — Chưa chọn — when nothing could be mapped, and never guesses', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByLabelText('Mã nội bộ dòng 1')).toHaveValue('');
    expect(screen.getByTestId('bcom-room-1-status')).toHaveTextContent('Chưa gán mã hạng phòng');
  });
});

/* ================================================================== */
/* A selection reaches the server — in the dispatch                    */
/* ================================================================== */

describe('choosing an internal code', () => {
  it('records the choice and carries it into the dispatch request', async () => {
    /*
      The guarantee this replaces: "the code on screen is the code the server
      stored". It used to be checked by writing each selection immediately. The
      write happens once now, so it is checked at the write — the request that
      creates the booking carries exactly the class the Admin picked.
    */
    const fetchMock = mount(UNRESOLVED, preview(), {
      'POST /api/admin/bookings/dispatch': () => ({
        status: 201,
        body: { booking: { id: 'created-1' } },
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    await waitFor(() => expect(within(select as HTMLElement).getAllByRole('option').length).toBe(4));
    await user.selectOptions(select, 'rc-sup');

    await waitFor(() =>
      expect(screen.getByTestId('bcom-room-1-status')).toHaveTextContent('đã chọn thủ công'),
    );

    // Nothing was written by the selection itself.
    expect(
      fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT'),
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: /Gửi xuống chi nhánh/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/admin/bookings/dispatch' && (i as RequestInit)?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.rooms[0].roomClassId).toBe('rc-sup');
      expect(body.branchId).toBe(1);
      expect(body.bookingCode).toBe('6312474567');
    });
  });

  it('regenerates the PMS note from the chosen code', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    await waitFor(() => expect(within(select as HTMLElement).getAllByRole('option').length).toBe(4));
    await user.selectOptions(select, 'rc-defam');

    await waitFor(() =>
      expect((screen.getByTestId('bcom-pms-note') as HTMLTextAreaElement).value).toContain('_1DEFAM_'),
    );
  });
});

/* ================================================================== */
/* The note is the BOOKING.COM note                                    */
/* ================================================================== */

describe('the Ghi chú PMS section', () => {
  it('uses the Booking.com format, never the Agoda one', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const note = (await screen.findByTestId('bcom-pms-note')) as HTMLTextAreaElement;
    // The Booking.com builder's own layout: BK <code>_<ROOM>_<n> ĐÊM … CI
    await waitFor(() => expect(note.value).toContain('BK 6312474567_1STAN_2 ĐÊM'));
    expect(note.value).toContain('PAY AFTER CHECK-IN CI');
    // The reference screenshots for this screen were Agoda notes. Never here.
    expect(note.value).not.toContain('AGD ');
    expect(note.value).not.toContain('GIÁ KHÁCH ĐẶT');
    expect(note.value).not.toContain('CTRIP_');
  });

  it('carries the guest phone, as the Booking.com note does', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const note = (await screen.findByTestId('bcom-pms-note')) as HTMLTextAreaElement;
    expect(note.value).toContain('CÓ SĐT +84964934713');
  });

  it('is editable', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const note = (await screen.findByTestId('bcom-pms-note')) as HTMLTextAreaElement;
    expect(note.readOnly).toBe(false);
    expect(note.disabled).toBe(false);

    await user.clear(note);
    await user.type(note, 'SUA TAY');
    expect(note).toHaveValue('SUA TAY');
  });

  it('copies what is on screen', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);
    const note = (await screen.findByTestId('bcom-pms-note')) as HTMLTextAreaElement;
    await waitFor(() => expect(note.value).toContain('1STAN'));

    // Stubbed AFTER userEvent.setup(), which installs a clipboard of its own.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);

    await user.click(screen.getByRole('button', { name: /Sao chép note/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('BK 6312474567_1STAN_2 ĐÊM');
  });

  it('explains itself instead of printing a note it cannot build', async () => {
    // No booking code: the Booking.com builder refuses rather than inventing.
    mount(RESOLVED_STAN, preview({ bookingCode: null }));
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByTestId('bcom-pms-note-card')).toHaveTextContent(
      'Chưa có mã Booking để tạo ghi chú.',
    );
    expect(screen.queryByTestId('bcom-pms-note')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* Dispatch is blocked until every room has a code                     */
/* ================================================================== */

describe('dispatch gating', () => {
  it('blocks sending and says why when a code is missing', async () => {
    mount();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByTestId('dispatch-room-blocking')).toHaveTextContent(
      'Vui lòng chọn mã nội bộ cho tất cả hạng phòng trước khi gửi.',
    );
    expect(screen.getByRole('button', { name: /Gửi xuống chi nhánh/ })).toBeDisabled();
  });

  it('allows sending once every room carries a code', async () => {
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await screen.findByTestId('bcom-room-classes');
    await waitFor(() =>
      expect(screen.queryByTestId('dispatch-room-blocking')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Gửi xuống chi nhánh/ })).toBeEnabled();
  });

  it('re-offers the NEW branch codes as soon as the branch changes', async () => {
    /*
      This case used to assert the opposite instruction — "save first, then we
      will show you the new branch's codes" — because the server validated a
      selection against the branch the DRAFT was saved with, and offering codes
      before saving produced a refusal the Admin could not explain.

      There is no saved branch to lag behind the picker any more. The codes
      offered are always the currently selected branch's, which is the branch the
      dispatch will be validated against, so the underlying guarantee — you can
      only pick a code that belongs to the branch this order is going to — is
      kept without asking the Admin to save anything.
    */
    mount(RESOLVED_STAN);
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await screen.findByTestId('bcom-room-classes');
    await waitFor(() => expect(screen.getByLabelText('Mã nội bộ dòng 1')).toHaveValue('rc-stan'));

    await user.selectOptions(screen.getByLabelText('Chọn chi nhánh gửi đến'), '2');

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    await waitFor(() => {
      const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
      expect(options).toEqual(['— Chưa chọn —', 'DEL — Deluxe']);
    });
    // CN1's code is gone with CN1: a stale selection cannot survive the switch.
    expect(select).toHaveValue('');
  });
});
