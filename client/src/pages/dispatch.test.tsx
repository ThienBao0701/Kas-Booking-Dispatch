import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel & Ben Thanh', address: '05 Trương Định' };
const BRANCH2 = { id: 2, code: 'LY_TU_TRONG_260', hotelName: 'Luxury Elegance Hotel Ben Than', address: '260 Lý Tự Trọng' };

/**
 * The extraction preview — the whole review, held in the browser.
 *
 * There is no `booking.id` and no second fetch for a stored detail: extracting
 * a Booking.com reservation writes nothing, so the screen renders straight from
 * this response.
 */
const DEFAULT_EXTRACT = {
  persisted: false,
  booking: {
    bookingCode: '6312474567',
    hotelName: 'Saigon Hotel & Ben Thanh Market',
    sourcePlatform: 'BOOKING_COM',
    guestName: 'Thùy Chi Phan',
    phone: '+84 964 934 713',
    checkIn: '2026-07-23',
    checkOut: '2026-07-25',
    currency: 'VND',
    totalAmount: 3_078_000,
    paymentStatus: 'PAY_AFTER',
    specialRequest: null,
    parserVersion: '4a.2.0',
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
      roomName: 'Phòng Tiêu Chuẩn Giường Đôi',
      roomTotal: 1_539_000,
      nights: [{ stayDate: '2026-07-23', amount: 648_000, currency: 'VND', isEstimated: false }],
    },
  ],
  warnings: [],
  agoda: null,
};

const NO_MAPPING = { active: null, draft: null };
const NOTHING_RESOLVED = {
  versionId: null,
  rooms: [
    {
      sourceRoomName: 'Phòng Tiêu Chuẩn Giường Đôi',
      status: 'UNRESOLVED',
      roomClassId: null,
      displayName: null,
      pmsCode: null,
      matchedAlias: null,
      matchType: 'NONE',
    },
  ],
};

function mockDispatch(
  extract: Record<string, unknown> = DEFAULT_EXTRACT,
  extra: Record<string, () => { status: number; body?: unknown }> = {},
) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH, BRANCH2] } }),
    'POST /api/bookings/extract': () => ({ status: 201, body: extract }),
    // The room-class surface is covered in its own file; here it only needs to
    // answer so the review renders.
    'GET /api/admin/branches/1/room-mapping': () => ({ status: 200, body: NO_MAPPING }),
    'GET /api/admin/branches/2/room-mapping': () => ({ status: 200, body: NO_MAPPING }),
    'POST /api/admin/branches/1/room-mapping/resolve': () => ({ status: 200, body: NOTHING_RESOLVED }),
    'POST /api/admin/branches/2/room-mapping/resolve': () => ({ status: 200, body: NOTHING_RESOLVED }),
    ...extra,
  });
}

async function extract(user: ReturnType<typeof userEvent.setup>) {
  const textarea = await screen.findByRole('textbox');
  await user.type(textarea, 'Booking.com raw text');
  await user.click(screen.getByRole('button', { name: 'Trích xuất thông tin' }));
}

describe('DispatchPage — data-quality / confidence display', () => {
  it('shows a HIGH completeness score and branch confidence, no review banner', async () => {
    mockDispatch();

    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByText(/Độ hoàn thiện dữ liệu:/)).toBeInTheDocument();
    expect(screen.getByText('98%')).toBeInTheDocument();
    expect(screen.getByText(/Độ tin cậy chi nhánh:/)).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.queryByText('Admin cần kiểm tra lại booking này trước khi gửi.')).not.toBeInTheDocument();
  });

  it('shows the review banner when the extraction requires admin review', async () => {
    mockDispatch({
      ...DEFAULT_EXTRACT,
      branchConfidence: 80,
      branchConfident: false,
      requiresManualConfirmation: true,
      parserQuality: { score: 70, level: 'LOW', requiresAdminReview: true, missingCriticalFields: ['bookingCode'], warningCount: 1 },
    });

    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByText('Admin cần kiểm tra lại booking này trước khi gửi.')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });
});

describe('DispatchPage — branch address field', () => {
  it('shows the selected branch address and updates it when the branch changes', async () => {
    mockDispatch();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const addressField = await screen.findByLabelText('Địa chỉ khách sạn');
    expect(addressField).toHaveValue('05 Trương Định');
    expect(addressField).toHaveAttribute('readonly');
    expect(addressField).toHaveAttribute('placeholder', 'Chưa chọn chi nhánh');
    // The raw Booking.com property name is not shown as the address.
    expect(addressField).not.toHaveValue('Saigon Hotel & Ben Thanh Market');

    // Changing the branch dropdown updates the displayed address immediately.
    const branchSelect = screen.getByLabelText('Chọn chi nhánh gửi đến');
    await user.selectOptions(branchSelect, '2');
    expect(addressField).toHaveValue('260 Lý Tự Trọng');
  });

  it('shows an empty address with the placeholder when no branch is resolved', async () => {
    mockDispatch({
      ...DEFAULT_EXTRACT,
      suggestedBranch: null,
      branchConfident: false,
      branchConfidence: 0,
    });
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const addressField = await screen.findByLabelText('Địa chỉ khách sạn');
    expect(addressField).toHaveValue('');
    expect(addressField).toHaveAttribute('placeholder', 'Chưa chọn chi nhánh');
  });
});

describe('DispatchPage — business type', () => {
  /** The business-type read-out lives in a role="status" span (the "Loại đơn" chip). */
  function statusHas(text: RegExp): boolean {
    return screen.getAllByRole('status').some((el) => text.test(el.textContent ?? ''));
  }

  it('shows a confident DIRECT type with confidence, no confirmation prompt', async () => {
    mockDispatch();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await screen.findByText(/Loại đơn:/);
    expect(statusHas(/Đơn thường/)).toBe(true);
    expect(screen.getByText(/Độ tin cậy loại đơn:/)).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.queryByText('Không thể tự xác định loại đơn. Admin vui lòng xác nhận.')).not.toBeInTheDocument();
  });

  it('shows the PARTNER type', async () => {
    mockDispatch({ ...DEFAULT_EXTRACT, businessType: 'PARTNER', businessTypeConfidence: 100, businessTypeMatchedRules: ['partner-rate'] });
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);
    await screen.findByText(/Loại đơn:/);
    expect(statusHas(/Đơn đối tác/)).toBe(true);
  });

  it('prompts for confirmation on UNKNOWN and lets the Admin mark it a partner', async () => {
    /*
      The decision used to PATCH the draft and adopt the response. With no draft
      to patch it is recorded locally and travels in the dispatch payload, where
      the server applies the same rule the old endpoint did. So no request is
      made here — asserted below, because a silent write would mean the DRAFT
      lifecycle had crept back in.
    */
    const fetchMock = mockDispatch({
      ...DEFAULT_EXTRACT,
      businessType: 'UNKNOWN',
      businessTypeConfidence: 0,
      businessTypeRequiresAdminConfirmation: true,
      businessTypeMatchedRules: [],
    });
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByText('Không thể tự xác định loại đơn. Admin vui lòng xác nhận.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Đánh dấu là Đơn đối tác' }));

    await screen.findByText('Admin đã xác nhận');
    expect(statusHas(/Đơn đối tác/)).toBe(true);

    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/business-type')),
    ).toBe(false);
  });

  it('carries the confirmed type into the dispatch request', async () => {
    const fetchMock = mockDispatch(
      {
        ...DEFAULT_EXTRACT,
        businessType: 'UNKNOWN',
        businessTypeConfidence: 0,
        businessTypeRequiresAdminConfirmation: true,
        businessTypeMatchedRules: [],
        // A room the branch mapping recognises, so Gửi is reachable.
        rooms: DEFAULT_EXTRACT.rooms,
      },
      {
        'POST /api/admin/branches/1/room-mapping/resolve': () => ({
          status: 200,
          body: {
            versionId: 'v-1',
            rooms: [
              {
                sourceRoomName: 'Phòng Tiêu Chuẩn Giường Đôi',
                status: 'RESOLVED',
                roomClassId: 'rc-stan',
                displayName: 'Standard',
                pmsCode: 'STAN',
                matchedAlias: null,
                matchType: 'DISPLAY_NAME',
              },
            ],
          },
        }),
        'POST /api/admin/bookings/dispatch': () => ({
          status: 201,
          body: { booking: { id: 'created-1' } },
        }),
      },
    );
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await screen.findByText('Không thể tự xác định loại đơn. Admin vui lòng xác nhận.');
    await user.click(screen.getByRole('button', { name: 'Đánh dấu là Đơn đối tác' }));
    await screen.findByText('Admin đã xác nhận');

    const send = screen.getByRole('button', { name: /Gửi xuống chi nhánh/ });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === '/api/admin/bookings/dispatch' && (i as RequestInit)?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body)).businessType).toBe('PARTNER');
    });
  });
});

/* ================================================================== */
/* Nothing is persisted before Gửi                                     */
/* ================================================================== */

describe('DispatchPage — the review is not a record', () => {
  it('extracting writes nothing: no draft fetch, no save, no send', async () => {
    const fetchMock = mockDispatch();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    await screen.findByLabelText('Mã đặt phòng');

    // The only write in the whole review stage is the extraction itself, and
    // the server answers that one without touching the database.
    const writes = fetchMock.mock.calls.filter(([u, i]) => {
      const method = (i as RequestInit)?.method ?? 'GET';
      return method !== 'GET' && !String(u).endsWith('/room-mapping/resolve');
    });
    expect(writes.map(([u]) => String(u))).toEqual(['/api/bookings/extract']);
  });

  it('editing a field never calls the server', async () => {
    const fetchMock = mockDispatch();
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    const nameField = await screen.findByLabelText('Tên khách');
    const before = fetchMock.mock.calls.length;

    await user.clear(nameField);
    await user.type(nameField, 'Người Khác');
    expect(nameField).toHaveValue('Người Khác');

    // Typing is typing. Nothing is saved until the order is sent.
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('re-extracting replaces the review, with no draft to clean up', async () => {
    const second = {
      ...DEFAULT_EXTRACT,
      booking: { ...DEFAULT_EXTRACT.booking, bookingCode: '9999999999', guestName: 'Khách Thứ Hai' },
    };
    let call = 0;
    mockDispatch(DEFAULT_EXTRACT, {
      'POST /api/bookings/extract': () => ({
        status: 201,
        body: call++ === 0 ? DEFAULT_EXTRACT : second,
      }),
    });
    const user = userEvent.setup();
    renderApp('/app/dispatch');
    await extract(user);

    expect(await screen.findByLabelText('Mã đặt phòng')).toHaveValue('6312474567');

    await user.click(screen.getByRole('button', { name: /Đơn khác/ }));
    await extract(user);

    await waitFor(() =>
      expect(screen.getByLabelText('Mã đặt phòng')).toHaveValue('9999999999'),
    );
    expect(screen.getByLabelText('Tên khách')).toHaveValue('Khách Thứ Hai');
  });
});
