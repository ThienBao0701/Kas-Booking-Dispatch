/**
 * The Admin OTA review panel.
 *
 * The panel holds no business rules of its own: the note, the selectable PMS
 * codes and `canDispatch` all come from the server, and every edit is sent back
 * for re-resolution. These tests therefore assert two things — that the panel
 * FAITHFULLY renders what the server said, and that it cannot let an Admin act
 * on something the server refused.
 *
 * The server is mocked here so each scenario is deterministic; the real
 * resolution logic is covered by the server suites.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OtaReviewPanel } from './OtaReviewPanel';
import type { OtaReviewResponse, OtaReviewRoomLine } from '../api/otaReview';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCHES = [
  { id: 5, code: 'LE_THANH_TON_278', branchNumber: 5, address: '278 Lê Thánh Tôn', hotelName: 'Zody' },
  { id: 4, code: 'NGUYEN_THAI_BINH_170', branchNumber: 4, address: '170 Nguyễn Thái Bình', hotelName: 'Indochina' },
];

const CN5_CODES = ['STAN', 'SUP', 'TWIN', 'DEL', 'STU', 'SUITE'];
const CN4_CODES = ['SUP', 'DEL12', 'DEL34', 'DD', 'DEBAL', 'SUITEBAL'];

function room(over: Partial<OtaReviewRoomLine> = {}): OtaReviewRoomLine {
  return {
    quantity: 1,
    otaRoomName: 'Standard Double Room No Window',
    otaRoomTypeId: null,
    pmsCode: null,
    requiresManualMapping: true,
    ...over,
  };
}

/** A CTrip review as the server would return it. */
function response(over: Partial<OtaReviewResponse['review']> = {}, codes = CN5_CODES): OtaReviewResponse {
  return {
    review: {
      source: 'CTRIP',
      branchId: 5,
      branchCode: 'LE_THANH_TON_278',
      branchAddress: '278 Lê Thánh Tôn',
      requiresManualBranch: false,
      bookingCode: '1658113703317875',
      guestName: 'LEE/JENSON HWEE',
      checkIn: '2026-08-01',
      checkOut: '2026-08-08',
      nights: 7,
      rooms: [room()],
      nightlyRates: [],
      branchPrice: 4_645_956,
      guestBookedPrice: 6_637_080,
      breakfastIncluded: false,
      paymentMode: 'CN',
      note: null,
      noteError: 'Chưa đủ dữ liệu để tạo ghi chú: mã hạng phòng nội bộ.',
      warnings: [
        {
          code: 'OTA_ROOM_MAPPING_UNRESOLVED',
          message: 'Chưa có hạng phòng nội bộ cho "Standard Double Room No Window" tại chi nhánh này.',
          severity: 'ERROR',
        },
      ],
      canDispatch: false,
      blockingReasons: ['Còn hạng phòng chưa gán mã nội bộ.'],
      ...over,
    },
    branchOptions: BRANCHES,
    validPmsCodes: codes,
    knownOtaRoomNames: [],
    existingBookingId: null,
  };
}

/** The resolved form of the confirmed CTrip sample, after manual STAN. */
const RESOLVED = response({
  rooms: [room({ pmsCode: 'STAN', requiresManualMapping: false })],
  note: 'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN\nGIÁ KHÁCH ĐẶT 6.637.080 KHONG AN SANG',
  noteError: null,
  warnings: [],
  canDispatch: true,
  blockingReasons: [],
});

/**
 * Mocks the review endpoint. `sequence` supplies successive responses so a test
 * can model "unresolved, then resolved after the Admin corrects it".
 */
function mockReview(...sequence: OtaReviewResponse[]) {
  const bodies: unknown[] = [];
  const dispatchBodies: unknown[] = [];
  let call = 0;
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsedBody = init.body ? JSON.parse(String(init.body)) : undefined;

    // The dispatch endpoint answers with its own shape; routing by URL keeps a
    // dispatch from being served a review payload and silently misread.
    if (String(url).includes('/ota/dispatch')) {
      if (parsedBody) dispatchBodies.push(parsedBody);
      const review = sequence[Math.min(call - 1, sequence.length - 1)]!.review;
      return new Response(
        JSON.stringify({ bookingId: 'bk_1', created: dispatchState.created, review }),
        { status: dispatchState.created ? 201 : 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (parsedBody) bodies.push(parsedBody);
    const payload = sequence[Math.min(call, sequence.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, dispatchBodies, fetchMock };
}

/** Lets a test say whether the next dispatch creates a booking or finds one. */
const dispatchState = { created: true };

afterEach(() => {
  dispatchState.created = true;
});

/**
 * `onDispatch` is OPTIONAL and the dispatch page supplies none today, so the
 * default mount reflects production: no dispatch handler is wired. Tests that
 * exercise the send action pass one explicitly.
 */
const mount = (
  source: 'AGODA' | 'CTRIP' = 'CTRIP',
  onDispatch?: (branchId: number, note: string) => void,
) => render(<OtaReviewPanel source={source} rawText="RAW" onDispatch={onDispatch} />);

/* ================================================================== */
/* Rendering what the server said                                      */
/* ================================================================== */

describe('renders the server review', () => {
  it('shows every CTrip field', async () => {
    mockReview(RESOLVED);
    mount();

    expect(await screen.findByDisplayValue('1658113703317875')).toBeInTheDocument();
    expect(screen.getByDisplayValue('LEE/JENSON HWEE')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-08-01')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-08-08')).toBeInTheDocument();
    expect(screen.getByTestId('ota-nights')).toHaveTextContent('7');
    // CTrip's payout field is labelled Công nợ, and CTrip shows no
    // guest-booked price at all — its note no longer carries one.
    expect(screen.getByLabelText('Công nợ')).toHaveValue('4645956');
    expect(screen.queryByLabelText('Giá khách đặt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Original room rate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Giá chi nhánh/)).not.toBeInTheDocument();
  });

  it('shows Agoda price labels naming the platform fields', async () => {
    mockReview({
      ...RESOLVED,
      review: { ...RESOLVED.review, source: 'AGODA' },
    });
    mount('AGODA');

    expect(await screen.findByText(/Net rate/)).toBeInTheDocument();
    expect(screen.getByText(/Reference sell rate/)).toBeInTheDocument();
  });

  it('states plainly that no nightly prices were supplied', async () => {
    mockReview(RESOLVED);
    mount();
    expect(await screen.findByTestId('ota-no-nightly')).toHaveTextContent(
      /không tự chia tổng tiền/,
    );
  });

  it('shows the exact server note verbatim', async () => {
    mockReview(RESOLVED);
    mount();
    expect(await screen.findByTestId('ota-note')).toHaveTextContent(
      'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 CN GIÁ KHÁCH ĐẶT 6.637.080 KHONG AN SANG',
    );
  });
});

/* ================================================================== */
/* Unresolved mappings block dispatch                                  */
/* ================================================================== */

describe('unresolved room mapping', () => {
  it('blocks dispatch and shows the specific reason, not a generic error', async () => {
    mockReview(response());
    mount();

    await screen.findByTestId('ota-review');
    expect(screen.getByRole('button', { name: /Gửi chi nhánh/ })).toBeDisabled();
    expect(screen.getByTestId('ota-blocking')).toHaveTextContent(
      'Còn hạng phòng chưa gán mã nội bộ.',
    );
    expect(screen.getByTestId('ota-warnings')).toHaveTextContent(/Standard Double Room No Window/);
    // No note exists, so copying is not offered.
    expect(screen.getByRole('button', { name: /Sao chép note/ })).toBeDisabled();
  });

  it('unblocks after the Admin picks STAN for CN5', async () => {
    const { bodies } = mockReview(response(), RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.selectOptions(screen.getByLabelText('Mã nội bộ dòng 1'), 'STAN');

    await waitFor(() =>
      expect(screen.getByTestId('ota-note')).toHaveTextContent('1STAN_7DEM'),
    );

    // The correction really was sent to the server.
    const last = bodies[bodies.length - 1] as { overrides?: { rooms?: { pmsCode: string }[] } };
    expect(last.overrides?.rooms?.[0]?.pmsCode).toBe('STAN');
  });
});

/* ================================================================== */
/* The selector only offers what the branch has                        */
/* ================================================================== */

describe('PMS-code selector', () => {
  it('offers only the selected branch codes and never free text', async () => {
    mockReview(response());
    mount();

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    expect(select.tagName).toBe('SELECT'); // never a text input
    const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    for (const code of CN5_CODES) expect(options).toContain(code);
  });

  it('does not offer STAN at CN4', async () => {
    mockReview(
      response({ branchId: 4, branchCode: 'NGUYEN_THAI_BINH_170' }, CN4_CODES),
    );
    mount();

    const select = await screen.findByLabelText('Mã nội bộ dòng 1');
    const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    expect(options).not.toContain('STAN');
    expect(options).toContain('DEL12');
  });

  it('changing branch re-asks the server and drops stale room overrides', async () => {
    const { bodies } = mockReview(
      RESOLVED,
      response({ branchId: 4, branchCode: 'NGUYEN_THAI_BINH_170' }, CN4_CODES),
    );
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '4');

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { overrides?: { branchId?: number; rooms?: unknown } };
      expect(last.overrides?.branchId).toBe(4);
      // Room overrides are cleared so the server re-resolves for the new branch.
      expect(last.overrides?.rooms).toBeUndefined();
    });
  });
});

/* ================================================================== */
/* Room rows                                                           */
/* ================================================================== */

describe('room rows', () => {
  it('adds a row', async () => {
    const { bodies } = mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getByRole('button', { name: /Thêm loại phòng/ }));

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { overrides?: { rooms?: unknown[] } };
      expect(last.overrides?.rooms).toHaveLength(2);
    });
  });

  it('removes a row', async () => {
    const { bodies } = mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getAllByRole('button', { name: /Xoá/ })[0]!);

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { overrides?: { rooms?: unknown[] } };
      expect(last.overrides?.rooms).toHaveLength(0);
    });
  });

  it('renders a multi-room note exactly as the server built it', async () => {
    mockReview(
      response({
        rooms: [
          room({ pmsCode: 'SUP', requiresManualMapping: false }),
          room({ quantity: 1, pmsCode: 'DEL', requiresManualMapping: false }),
        ],
        note: 'AGD 123456789_2SUP_1DEL_3DEM 6.500.000 CN\nGIÁ KHÁCH ĐẶT 8.200.000 KHONG AN SANG',
        noteError: null,
        warnings: [],
        canDispatch: true,
        blockingReasons: [],
      }),
    );
    mount();
    expect(await screen.findByTestId('ota-note')).toHaveTextContent('2SUP_1DEL_3DEM');
  });
});

/* ================================================================== */
/* Payment mode and prices                                             */
/* ================================================================== */

describe('rendering a fully-resolved server response', () => {
  /**
   * The shape the real route returns for the confirmed Agoda booking, with
   * every field populated. The panel must SHOW all of it and warn about none
   * of it — a false "missing check-in" on a booking that has one is what makes
   * an Admin distrust the screen.
   */
  const REAL: OtaReviewResponse = {
    ...response(),
    review: {
      ...response().review,
      source: 'AGODA',
      bookingCode: '1756224954',
      guestName: 'Nga Đỗ',
      checkIn: '2026-08-04',
      checkOut: '2026-08-05',
      nights: 1,
      rooms: [
        {
          quantity: 1,
          otaRoomName: 'Superior Double Room',
          rawOtaRoomName: 'Superior Double Room',
          otaRoomTypeId: null,
          pmsCode: 'SUP',
          requiresManualMapping: false,
          sourceNightlyTotal: 529_537,
          perRoomNightlyRate: 529_537,
        },
      ],
      branchPrice: 529_537,
      guestBookedPrice: 875_000,
      note: 'AGD 1756224954_1SUP_1DEM 529.537 CN\nGIÁ KHÁCH ĐẶT 875.000 KHONG AN SANG',
      noteError: null,
      warnings: [],
      canDispatch: true,
      blockingReasons: [],
    },
  };

  it('shows guest, dates, room and prices', async () => {
    mockReview(REAL);
    mount('AGODA');

    await screen.findByTestId('ota-review');
    expect(screen.getByLabelText('Mã đặt phòng')).toHaveValue('1756224954');
    expect(screen.getByLabelText('Tên khách')).toHaveValue('Nga Đỗ');
    expect(screen.getByLabelText('Nhận phòng')).toHaveValue('2026-08-04');
    expect(screen.getByLabelText('Trả phòng')).toHaveValue('2026-08-05');
    expect(screen.getByTestId('ota-nights').textContent).toContain('1');
    expect(screen.getByLabelText('Tên hạng phòng dòng 1')).toHaveValue('Superior Double Room');
    expect(screen.getByLabelText('Số lượng phòng dòng 1')).toHaveValue(1);
    expect(screen.getByLabelText('Giá chi nhánh')).toHaveValue('529537');
    expect(screen.getByLabelText('Giá khách đặt')).toHaveValue('875000');
  });

  it('shows the note and no missing-field warnings', async () => {
    mockReview(REAL);
    mount('AGODA');

    await screen.findByTestId('ota-review');
    expect(screen.getByTestId('ota-note').textContent).toContain(
      'AGD 1756224954_1SUP_1DEM 529.537 CN',
    );
    expect(screen.queryByTestId('ota-warnings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ota-blocking')).not.toBeInTheDocument();
  });
});

describe('breakfast', () => {
  it('is fixed to "no breakfast" and cannot be toggled', async () => {
    // Agoda and CTrip stays at these branches include no breakfast — a
    // configured rule, not a choice, so the control states it rather than
    // offering it. The server enforces the same thing independently.
    const { bodies } = mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    const box = screen.getByLabelText('Ăn sáng');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText('Không ăn sáng')).toBeInTheDocument();

    await userEvent.click(box);
    // The click changed nothing and sent nothing.
    expect(box).not.toBeChecked();
    expect(
      bodies.every(
        (b) =>
          (b as { overrides?: { breakfastIncluded?: unknown } }).overrides?.breakfastIncluded !==
          true,
      ),
    ).toBe(true);
  });

  it('renders a note ending in KHONG AN SANG', async () => {
    mockReview(RESOLVED);
    mount();
    expect((await screen.findByTestId('ota-note')).textContent).toContain('KHONG AN SANG');
  });
});

describe('payment mode', () => {
  it('offers exactly CN and THANH TOÁN TẠI KHÁCH SẠN', async () => {
    mockReview(RESOLVED);
    mount();

    const select = await screen.findByLabelText('Hình thức thanh toán');
    const options = within(select as HTMLElement).getAllByRole('option').map((o) => o.textContent);
    // The operator confirmed "TẠI" belongs in this phrase.
    expect(options).toEqual(['CN', 'THANH TOÁN TẠI KHÁCH SẠN']);
  });

  it('switching to hotel payment shows the one-line note', async () => {
    mockReview(
      RESOLVED,
      response({
        rooms: [room({ pmsCode: 'STAN', requiresManualMapping: false })],
        paymentMode: 'HOTEL_PAYMENT',
        note: 'CTRIP_1658113703317875_1STAN_7DEM 4.645.956 THANH TOÁN KHÁCH SẠN',
        noteError: null,
        warnings: [],
        canDispatch: true,
        blockingReasons: [],
      }),
    );
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.selectOptions(screen.getByLabelText('Hình thức thanh toán'), 'HOTEL_PAYMENT');

    await waitFor(() => {
      const note = screen.getByTestId('ota-note').textContent ?? '';
      expect(note.split('\n')).toHaveLength(1);
      expect(note).not.toContain('GIÁ KHÁCH ĐẶT');
    });
  });

  it('blocks a CN note with no guest-booked price, naming the reason', async () => {
    mockReview(
      response({
        rooms: [room({ pmsCode: 'STAN', requiresManualMapping: false })],
        guestBookedPrice: null,
        note: null,
        noteError: 'Chưa đủ dữ liệu để tạo ghi chú: Original room rate.',
        warnings: [],
        canDispatch: false,
        blockingReasons: ['Thiếu giá khách đặt (bắt buộc khi thanh toán CN).'],
      }),
    );
    mount();

    expect(await screen.findByTestId('ota-blocking')).toHaveTextContent('Thiếu giá khách đặt');
    expect(screen.getByRole('button', { name: /Gửi chi nhánh/ })).toBeDisabled();
  });

  it('sends an edited branch price on blur, without fighting the response', async () => {
    // Typed text lives in a local draft so an arriving response cannot overwrite
    // a half-typed number; the value is committed when the field loses focus.
    const { bodies } = mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    const branchPrice = screen.getByLabelText('Công nợ');
    await userEvent.clear(branchPrice);
    await userEvent.type(branchPrice, '5000000');
    // The draft holds exactly what was typed — no server value mixed in.
    expect(branchPrice).toHaveValue('5000000');

    await userEvent.tab();

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { overrides?: { branchPrice?: number } };
      expect(last.overrides?.branchPrice).toBe(5_000_000);
    });
  });

  it('sends an edited guest-booked price on blur (Agoda, which still has one)', async () => {
    const { bodies } = mockReview({
      ...RESOLVED,
      review: { ...RESOLVED.review, source: 'AGODA' },
    });
    mount('AGODA');

    await screen.findByTestId('ota-review');
    const guestPrice = screen.getByLabelText('Giá khách đặt');
    await userEvent.clear(guestPrice);
    await userEvent.type(guestPrice, '7000000');
    await userEvent.tab();

    await waitFor(() => {
      const last = bodies[bodies.length - 1] as { overrides?: { guestBookedPrice?: number } };
      expect(last.overrides?.guestBookedPrice).toBe(7_000_000);
    });
  });
});

/* ================================================================== */
/* The note is editable                                                */
/* ================================================================== */

describe('the PMS note editor', () => {
  it('is an editable field, not a read-only block', async () => {
    mockReview(RESOLVED);
    mount();

    const note = (await screen.findByTestId('ota-note')) as HTMLTextAreaElement;
    expect(note.tagName).toBe('TEXTAREA');
    expect(note.readOnly).toBe(false);
    expect(note.disabled).toBe(false);
    // No dark read-only styling left on it.
    expect(note.className).not.toContain('bg-slate-900');
    expect(note.className).not.toContain('text-slate-50');
  });

  it('accepts a hand edit and says the sent note is still the generated one', async () => {
    mockReview(RESOLVED);
    mount();

    const note = (await screen.findByTestId('ota-note')) as HTMLTextAreaElement;
    await userEvent.clear(note);
    await userEvent.type(note, 'SUA TAY');

    expect(note).toHaveValue('SUA TAY');
    expect(screen.getByTestId('ota-note-edited')).toBeInTheDocument();
  });

  it('copies the edited text rather than the server original', async () => {
    mockReview(RESOLVED);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    mount();

    const note = await screen.findByTestId('ota-note');
    await userEvent.clear(note);
    await userEvent.type(note, 'SUA TAY');
    await userEvent.click(screen.getByRole('button', { name: /Sao chép note/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SUA TAY'));
  });

  it('shows no edited notice before anything is typed', async () => {
    mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-note');
    expect(screen.queryByTestId('ota-note-edited')).not.toBeInTheDocument();
  });
});

/* ================================================================== */
/* Copy note                                                           */
/* ================================================================== */

describe('copy note', () => {
  it('copies exactly the visible note and confirms', async () => {
    mockReview(RESOLVED);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    mount();

    await screen.findByTestId('ota-note');
    await userEvent.click(screen.getByRole('button', { name: /Sao chép note/ }));

    await waitFor(() => expect(screen.getByText('Đã sao chép.')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(RESOLVED.review.note);
  });

  it('reports failure when the clipboard is unavailable', async () => {
    mockReview(RESOLVED);
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    mount();

    await screen.findByTestId('ota-note');
    await userEvent.click(screen.getByRole('button', { name: /Sao chép note/ }));

    await waitFor(() =>
      expect(screen.getByText(/Không sao chép được/)).toBeInTheDocument(),
    );
  });
});

/* ================================================================== */
/* Dispatch gating                                                     */
/* ================================================================== */

describe('dispatch', () => {
  it('is enabled whenever the server says canDispatch', async () => {
    // The panel dispatches for itself now, so the action no longer depends on a
    // page happening to supply a callback — which is what left it dead before.
    mockReview(RESOLVED);
    mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Gửi chi nhánh/ })).toBeEnabled(),
    );
  });

  it('posts the reviewed reservation to the dispatch endpoint', async () => {
    const { dispatchBodies } = mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getByRole('button', { name: /Gửi chi nhánh/ }));

    await waitFor(() => expect(dispatchBodies).toHaveLength(1));
    // The same body the review takes: the server re-derives and dispatches THAT.
    const sent = dispatchBodies[0] as { source: string; rawText: string };
    expect(sent.source).toBe('CTRIP');
    expect(sent.rawText).toBe('RAW');
  });

  it('confirms the booking was sent', async () => {
    mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getByRole('button', { name: /Gửi chi nhánh/ }));

    expect(await screen.findByTestId('ota-dispatch-result')).toHaveTextContent(/Đã gửi chi nhánh/);
  });

  it('says plainly when the reservation had already been sent', async () => {
    // Clicking twice must not read as two successful dispatches.
    dispatchState.created = false;
    mockReview(RESOLVED);
    mount();

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getByRole('button', { name: /Gửi chi nhánh/ }));

    expect(await screen.findByTestId('ota-dispatch-result')).toHaveTextContent(/đã được gửi trước đó/);
  });

  it('notifies the page with the branch and the server note verbatim', async () => {
    const calls: [number, string][] = [];
    mockReview(RESOLVED);
    mount('CTRIP', (branchId, note) => calls.push([branchId, note]));

    await screen.findByTestId('ota-review');
    await userEvent.click(screen.getByRole('button', { name: /Gửi chi nhánh/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]![0]).toBe(RESOLVED.review.branchId);
    expect(calls[0]![1]).toBe(RESOLVED.review.note);
  });

  it('reports a failed dispatch instead of claiming success', async () => {
    mockReview(RESOLVED);
    mount();
    await screen.findByTestId('ota-review');

    // The endpoint refuses; the panel must not show a sent confirmation.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Đơn chưa hợp lệ.' } }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /Gửi chi nhánh/ }));

    await waitFor(() => expect(screen.queryByTestId('ota-dispatch-result')).not.toBeInTheDocument());
  });

  it('requires a branch and says so when recognition failed', async () => {
    mockReview(
      response({
        branchId: null,
        branchCode: null,
        requiresManualBranch: true,
        note: null,
        canDispatch: false,
        blockingReasons: ['Chưa chọn chi nhánh.'],
      }),
    );
    mount();

    expect(await screen.findByText(/Không nhận diện được chi nhánh/)).toBeInTheDocument();
    expect(screen.getByTestId('ota-blocking')).toHaveTextContent('Chưa chọn chi nhánh.');
    expect(screen.getByRole('button', { name: /Gửi chi nhánh/ })).toBeDisabled();
  });
});

/* ================================================================== */
/* An already-dispatched reservation amends, never re-dispatches       */
/* ================================================================== */

describe('routing to the amendment flow', () => {
  /** The review says this reservation already exists as a booking. */
  const EXISTING: OtaReviewResponse = { ...RESOLVED, existingBookingId: 'bk_existing' };

  /** Mocks review → amendment, so the panel can route between them. */
  function mockExisting(changes: { field: string; label: string; oldValue: string | null; newValue: string | null }[]) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const target = String(url);
        calls.push(target);
        if (target.includes('/ota/amendment')) {
          return new Response(
            JSON.stringify({
              bookingId: 'bk_existing',
              review: EXISTING.review,
              changes,
              otaCancelled: false,
              currentStatus: 'NEW',
              expectedVersion: '2026-08-02T00:00:00.000Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify(EXISTING), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    return { calls };
  }

  it('states that the booking was already sent, with no comparison', async () => {
    // 5.2 — the pilot reconciles amendments in its own PMS. A field-by-field
    // diff that the reviewer is not expected to act on invites them to guess
    // or to ignore it, so the status is stated plainly instead.
    mockExisting([
      { field: 'checkOut', label: 'Ngày trả phòng', oldValue: '2026-08-08', newValue: '2026-08-10' },
    ]);
    mount();

    expect(await screen.findByTestId('amendment-already-dispatched')).toHaveTextContent(
      'Đơn này đã được gửi cho chi nhánh.',
    );
    expect(screen.queryByTestId('amendment-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ota-review')).not.toBeInTheDocument();
  });

  it('never offers a dispatch button for an existing booking', async () => {
    // Unchanged and still load-bearing: re-sending returns the existing
    // booking untouched, so the amended details would be silently discarded.
    mockExisting([
      { field: 'checkOut', label: 'Ngày trả phòng', oldValue: '2026-08-08', newValue: '2026-08-10' },
    ]);
    mount();

    await screen.findByTestId('amendment-already-dispatched');
    expect(screen.queryByRole('button', { name: /Gửi chi nhánh/ })).not.toBeInTheDocument();
  });

  it('writes nothing at all — it neither dispatches nor applies an amendment', async () => {
    const { calls } = mockExisting([]);
    mount();

    await screen.findByTestId('amendment-already-dispatched');
    expect(calls.some((c) => c.includes('/ota/dispatch'))).toBe(false);
    expect(calls.some((c) => c.includes('/amendment/apply'))).toBe(false);
  });

  it('lets the reviewer go back without writing', async () => {
    const onBack = vi.fn();
    const { calls } = mockExisting([]);
    render(<OtaReviewPanel source="CTRIP" rawText="RAW" onBack={onBack} />);

    await screen.findByTestId('amendment-already-dispatched');
    await userEvent.click(screen.getByRole('button', { name: 'Quay lại' }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.includes('/amendment/apply'))).toBe(false);
  });

  it('keeps the normal review for a reservation that does not exist yet', async () => {
    mockReview(RESOLVED);
    mount();

    expect(await screen.findByTestId('ota-review')).toBeInTheDocument();
    expect(screen.queryByTestId('amendment-already-dispatched')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gửi chi nhánh/ })).toBeInTheDocument();
  });
});
