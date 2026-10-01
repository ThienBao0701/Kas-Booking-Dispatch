import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, EMPTY_OPERATIONAL_BLOCKS, RECEPTIONIST_USER, installApiMock, jsonResponse, renderApp } from '../test/utils';

/**
 * The receptionist is checked in. The server derives the order's creator from
 * this, so the proof form needs no creator-name field — and the shift picker
 * never interrupts these tests.
 */
const OPEN_SHIFT = {
  status: 200,
  body: {
    session: {
      id: 's1',
      branchId: 1,
      shiftType: 'A',
      shiftName: 'Ca A',
      shiftWindow: '06:00 – 14:00',
      receptionistName: 'Lễ tân Một',
      startedAt: '2026-09-16T23:00:00.000Z',
      nominalEndAt: '2026-09-17T07:00:00.000Z',
      graceEndAt: '2026-09-17T07:10:00.000Z',
      closedAt: null,
      promptDue: false,
    },
  },
};

/** Dispatches a document paste event carrying a single PNG clipboard image. */
function firePasteImage(type = 'image/png') {
  const item = { kind: 'file', type, getAsFile: () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x', { type }) };
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { items: [item] } });
  act(() => {
    document.dispatchEvent(e);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NEW_BOOKING = {
  id: 'b1',
  status: 'NEW',
  hotelName: 'Saigon Hotel & Ben Thanh',
  branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel & Ben Thanh', address: '05 Trương Định' },
  branchId: 1,
  customerName: 'Nguyễn Văn A',
  phone: '0901234567',
  bookingCode: '489234523',
  checkInDate: '2026-07-19',
  checkOutDate: '2026-07-21',
  checkInTime: null,
  checkOutTime: null,
  totalAmount: 1_700_000,
  currency: 'VND',
  paymentStatus: 'PAY_AFTER',
  specialRequest: null,
  parserVersion: '4a.2.0',
  isLastMinute: false,
  rooms: [
    {
      id: 'r1',
      roomIndex: 1,
      roomType: 'Deluxe Double Room',
      roomSubtotal: 1_700_000,
      taxAmount: null,
      feeAmount: null,
      nights: [
        { id: 'n1', stayDate: '2026-07-19', amount: 850_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
        { id: 'n2', stayDate: '2026-07-20', amount: 850_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
      ],
    },
  ],
  warnings: [],
  ...EMPTY_OPERATIONAL_BLOCKS,
  proofs: [],
  sourcePlatform: 'BOOKING_COM',
  verificationStatus: 'NOT_SUBMITTED',
  createdBy: null,
  sentBy: { id: 1, fullName: 'Quản trị viên' },
  completedBy: null,
  reviewedBy: null,
  createdAt: '2026-07-15T02:00:00.000Z',
  updatedAt: '2026-07-15T02:00:00.000Z',
  sentAt: '2026-07-15T02:00:00.000Z',
  completedAt: null,
  completionNote: null,
  reviewedAt: null,
};

const PENDING_PROOF = {
  id: 'p1',
  attemptNumber: 1,
  status: 'PENDING_REVIEW',
  originalFileName: 'proof.png',
  mimeType: 'image/png',
  fileSize: 2048,
  submissionNote: null,
  submittedBy: { id: 2, fullName: 'Lễ tân Một' },
  submittedAt: '2026-07-16T02:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  reviewReasonCode: null,
  reviewNote: null,
  imageUrl: '/api/bookings/b1/proofs/p1/image',
};

const PENDING_BOOKING = {
  ...NEW_BOOKING,
  verificationStatus: 'PENDING_REVIEW',
  completedBy: { id: 2, fullName: 'Lễ tân Một' },
  completedAt: '2026-07-16T02:00:00.000Z',
  proofs: [PENDING_PROOF],
};

const COMPLETED_BOOKING = {
  ...NEW_BOOKING,
  status: 'COMPLETED',
  verificationStatus: 'APPROVED',
  completedBy: { id: 2, fullName: 'Lễ tân Một' },
  completedAt: '2026-07-16T02:00:00.000Z',
  completionNote: 'Đã tạo trên hệ thống',
  reviewedBy: { id: 1, fullName: 'Quản trị viên' },
  reviewedAt: '2026-07-16T03:00:00.000Z',
  proofs: [{ ...PENDING_PROOF, status: 'APPROVED', reviewedBy: { id: 1, fullName: 'Quản trị viên' }, reviewedAt: '2026-07-16T03:00:00.000Z' }],
};

function mockDetail(booking: unknown) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
    'GET /api/bookings/b1': () => ({ status: 200, body: { booking } }),
  });
}

describe('BookingDetailPage — a reception manager reads, and acts on nothing', () => {
  it('shows the order and its branch, with no proof upload', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({
        status: 200,
        body: {
          user: {
            id: 9,
            username: 'quanly',
            fullName: 'Quản lý Một',
            role: 'RECEPTION_MANAGER',
            branch: null,
            managedBranchIds: [1],
            active: true,
            mustChangePassword: false,
          },
        },
      }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: NEW_BOOKING } }),
    });
    renderApp('/app/booking/b1');

    expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
    expect(screen.getByTestId('booking-header-branch')).toHaveTextContent('05 Trương Định');
    expect(screen.queryByTestId('proof-creator')).not.toBeInTheDocument();
  });
});

describe('BookingDetailPage — simplified copy surface', () => {
  it('exposes only a nightly-price copy on room rows (no room-block copies)', async () => {
    mockDetail(NEW_BOOKING);
    renderApp('/app/booking/b1');

    expect((await screen.findAllByLabelText(/Sao chép giá đêm/)).length).toBe(2);
    expect(screen.queryByLabelText(/hạng phòng/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/toàn bộ phòng/i)).not.toBeInTheDocument();
  });

  it('shows a receptionist no phone field, and no warning, when phone is missing', async () => {
    // The phone field is Admin-only now; a missing number was never a warning
    // and must not become one just because the field went away.
    mockDetail({ ...NEW_BOOKING, phone: null });
    renderApp('/app/booking/b1');

    expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
    expect(screen.queryByText('Số điện thoại')).not.toBeInTheDocument();
    expect(screen.queryByText('(Hiển thị số điện thoại)')).not.toBeInTheDocument();
    expect(screen.queryByText(/Cảnh báo/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('blocks note generation when the booking code is missing', async () => {
    mockDetail({ ...NEW_BOOKING, bookingCode: null });
    renderApp('/app/booking/b1');

    expect(await screen.findByText('Chưa có mã Booking để tạo ghi chú.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sao chép PMS Note' })).not.toBeInTheDocument();
  });
});

describe('BookingDetailPage — receptionist proof upload', () => {
  it('shows copyable fields and submits a creation proof via the proofs API', async () => {
    let submitted = false;
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({
        status: 200,
        body: { booking: submitted ? PENDING_BOOKING : NEW_BOOKING },
      }),
      'POST /api/bookings/b1/proofs': () => {
        submitted = true;
        return { status: 201, body: { booking: PENDING_BOOKING } };
      },
    });

    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    // Reception's two main fields carry copy buttons; the note has its own.
    expect(await screen.findByRole('heading', { name: 'Nguyễn Văn A' })).toBeInTheDocument();
    expect(screen.getByLabelText('Sao chép Tên khách')).toBeInTheDocument();
    expect(screen.getByLabelText('Sao chép Tổng tiền')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sao chép Mã Booking')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sao chép PMS Note' })).toBeInTheDocument();

    // Upload card wording, and the submit button is disabled until a file is chosen.
    expect(
      screen.getByText('Xác nhận đã tạo — gửi ảnh cho Admin kiểm tra'),
    ).toBeInTheDocument();
    const submitBtn = screen.getByRole('button', { name: 'Gửi Admin kiểm tra' });
    expect(submitBtn).toBeDisabled();

    // Pick a PNG file via the hidden file input.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);

    // Success feedback + the proofs endpoint was called with a multipart POST.
    expect(await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.')).toBeInTheDocument();
    const called = fetchMock.mock.calls.some(
      ([url, init]) => String(url) === '/api/bookings/b1/proofs' && (init as RequestInit).method === 'POST',
    );
    expect(called).toBe(true);
  });

  /**
   * THE CREATOR NAME IS NO LONGER TYPED.
   *
   * It used to be a required free-text box on this form, retyped on every order
   * and stored exactly as sent. The server now takes it from the shift the
   * receptionist checked in with, so the field is gone — there is nothing to
   * mistype, nothing to leave blank, and nothing a request can put another
   * receptionist's name into.
   */
  it('offers no creator-name field at all', async () => {
    mockDetail(NEW_BOOKING);
    renderApp('/app/booking/b1');

    await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    expect(screen.queryByLabelText('Tên người tạo đơn')).toBeNull();
    // Nor the older optional admin note.
    expect(screen.queryByText('Ghi chú cho Admin (không bắt buộc)')).toBeNull();
  });

  it('shows whose name the server will record', async () => {
    mockDetail(NEW_BOOKING);
    renderApp('/app/booking/b1');

    const creator = await screen.findByTestId('proof-creator');
    expect(creator).toHaveTextContent('Lễ tân Một');
    expect(creator).toHaveTextContent('Ca A');
  });

  it('submits with the image alone, and sends no name', async () => {
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: NEW_BOOKING } }),
      'POST /api/bookings/b1/proofs': () => ({ status: 201, body: { booking: PENDING_BOOKING } }),
    });
    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    const submitBtn = await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.click(submitBtn);

    expect(await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.')).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/bookings/b1/proofs');
    expect(call).toBeDefined();
    const sent = call![1]!.body as FormData;
    expect(sent.get('image')).toBeInstanceOf(File);
    // The field the old typed box used is not sent at all.
    expect(sent.get('note')).toBeNull();
  });

  it('does not expose OCR details to the receptionist (only a received note)', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: PENDING_BOOKING } }),
    });
    renderApp('/app/booking/b1');

    // The receptionist sees a simple "received" note…
    expect(await screen.findByText('Ảnh đã được hệ thống tiếp nhận.')).toBeInTheDocument();
    // …and never the admin-only OCR card, comparison card, or their controls.
    expect(screen.queryByText('Dữ liệu nhận diện từ ảnh')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Phân tích lại ảnh' })).not.toBeInTheDocument();
    expect(screen.queryByText('Kết quả đối chiếu')).not.toBeInTheDocument();
  });

  it('shows the rejection reason and a resubmit prompt for a rejected booking', async () => {
    const rejected = {
      ...NEW_BOOKING,
      verificationStatus: 'REJECTED',
      proofs: [
        {
          ...PENDING_PROOF,
          status: 'REJECTED',
          reviewReasonCode: 'WRONG_DATES',
          reviewNote: 'Ngày nhận phòng sai',
          reviewedBy: { id: 1, fullName: 'Quản trị viên' },
          reviewedAt: '2026-07-16T03:00:00.000Z',
        },
      ],
    };
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: rejected } }),
    });

    renderApp('/app/booking/b1');

    expect(await screen.findByText('Admin yêu cầu tạo lại')).toBeInTheDocument();
    // The reason shows in the banner and again in the attempt history.
    expect(screen.getAllByText(/Sai ngày check-in\/check-out/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Gửi Admin kiểm tra' })).toBeInTheDocument();
  });

  it('submits a proof pasted via Ctrl+V (dropzone integration)', async () => {
    let submitted = false;
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: submitted ? PENDING_BOOKING : NEW_BOOKING } }),
      'POST /api/bookings/b1/proofs': () => {
        submitted = true;
        return { status: 201, body: { booking: PENDING_BOOKING } };
      },
    });
    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    const submitBtn = await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    expect(submitBtn).toBeDisabled();

    firePasteImage('image/png');
    // Paste preview + success notice appear, and submit becomes enabled.
    expect(await screen.findByText('Đã dán ảnh từ clipboard.')).toBeInTheDocument();
    expect(await screen.findByText(/^pasted-proof-\d+\.png$/)).toBeInTheDocument();
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);
    expect(await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/bookings/b1/proofs' && (i as RequestInit).method === 'POST')).toBe(true);
  });

  it('supports the same upload experience for a rejected-booking resubmission', async () => {
    const rejected = { ...NEW_BOOKING, verificationStatus: 'REJECTED', proofs: [{ ...PENDING_PROOF, status: 'REJECTED', reviewReasonCode: 'UNCLEAR_IMAGE' }] };
    let submitted = false;
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: submitted ? PENDING_BOOKING : rejected } }),
      'POST /api/bookings/b1/proofs': () => {
        submitted = true;
        return { status: 201, body: { booking: PENDING_BOOKING } };
      },
    });
    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    await screen.findByText('Admin yêu cầu tạo lại');
    // Drag-drop a valid image onto the resubmission dropzone.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'again.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await user.click(screen.getByRole('button', { name: 'Gửi Admin kiểm tra' }));
    expect(await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/bookings/b1/proofs' && (i as RequestInit).method === 'POST')).toBe(true);
  });

  it('keeps the selected image and shows the error when the upload fails', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: NEW_BOOKING } }),
      'POST /api/bookings/b1/proofs': () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Lỗi máy chủ.' } } }),
    });
    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    const submitBtn = await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(screen.getByText('proof.png')).toBeInTheDocument();

    await user.click(submitBtn);
    // The image preview is preserved so the receptionist can retry.
    expect(await screen.findByText('Lỗi máy chủ.')).toBeInTheDocument();
    expect(screen.getByText('proof.png')).toBeInTheDocument();
  });

  it('disables submit while uploading and prevents a double submit', async () => {
    let resolveUpload: () => void = () => {};
    let postCount = 0;
    const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const key = `${(init.method ?? 'GET').toUpperCase()} ${String(url)}`;
      if (key === 'GET /api/auth/me') return jsonResponse(200, { user: RECEPTIONIST_USER });
      if (key === 'GET /api/notifications/unread-count') return jsonResponse(200, { count: 0 });
      if (key === 'GET /api/bookings/b1') return jsonResponse(200, { booking: NEW_BOOKING });
      if (key === 'POST /api/bookings/b1/proofs') {
        postCount += 1;
        return new Promise<Response>((resolve) => {
          resolveUpload = () => resolve(jsonResponse(201, { booking: PENDING_BOOKING }));
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: key } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    const submitBtn = await screen.findByRole('button', { name: 'Gửi Admin kiểm tra' });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'proof.png', { type: 'image/png' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);

    await user.click(submitBtn);
    // While the deferred upload is in flight the button shows the uploading label
    // and is disabled — a second click cannot fire a duplicate request.
    const uploadingBtn = await screen.findByRole('button', { name: 'Đang gửi ảnh...' });
    expect(uploadingBtn).toBeDisabled();
    await user.click(uploadingBtn);
    expect(postCount).toBe(1);

    resolveUpload();
    expect(await screen.findByText('Đã gửi ảnh cho Admin kiểm tra.')).toBeInTheDocument();
  });
});

describe('BookingDetailPage — admin review', () => {
  it('shows the LEFT/RIGHT comparison and approves a pending proof', async () => {
    let approved = false;
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: approved ? COMPLETED_BOOKING : PENDING_BOOKING } }),
      'GET /api/admin/bookings/b1/proofs/p1/analyses/latest': () => ({ status: 200, body: { analysis: { id: 'a1', proofId: 'p1', status: 'DISABLED', provider: 'disabled', analysisVersion: '1', extractedText: null, fields: null, errorMessage: null, startedAt: null, completedAt: null, createdAt: '2026-07-16T02:00:00.000Z' } } }),
      'GET /api/admin/bookings/b1/proofs/p1/comparisons/latest': () => ({ status: 200, body: { comparison: null } }),
      'POST /api/bookings/b1/proofs/p1/approve': () => {
        approved = true;
        return { status: 200, body: { booking: COMPLETED_BOOKING } };
      },
    });

    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    // The review comparison shows both the source facts and the proof image.
    expect(await screen.findByText('Thông tin đơn gốc')).toBeInTheDocument();
    expect(screen.getByText('Ảnh lễ tân gửi')).toBeInTheDocument();
    // Admin sees the advisory OCR + comparison cards (advisory only — no auto verdict).
    expect(screen.getByText('Dữ liệu nhận diện từ ảnh')).toBeInTheDocument();
    expect(screen.getByText('Kết quả đối chiếu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Đúng — xác nhận/ }));

    expect(await screen.findByText('Đã xác nhận đúng. Đơn đã hoàn thành.')).toBeInTheDocument();
    const called = fetchMock.mock.calls.some(
      ([url, init]) => String(url) === '/api/bookings/b1/proofs/p1/approve' && (init as RequestInit).method === 'POST',
    );
    expect(called).toBe(true);
  });

  it('rejects a pending proof with a reason code', async () => {
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: PENDING_BOOKING } }),
      'GET /api/admin/bookings/b1/proofs/p1/analyses/latest': () => ({ status: 200, body: { analysis: null } }),
      'GET /api/admin/bookings/b1/proofs/p1/comparisons/latest': () => ({ status: 200, body: { comparison: null } }),
      'POST /api/bookings/b1/proofs/p1/reject': () => ({ status: 200, body: { booking: { ...NEW_BOOKING, verificationStatus: 'REJECTED' } } }),
    });

    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    await user.click(await screen.findByRole('button', { name: /Sai — yêu cầu tạo lại/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Gửi yêu cầu tạo lại' }));

    expect(await screen.findByText('Đã gửi yêu cầu tạo lại cho chi nhánh.')).toBeInTheDocument();
    const called = fetchMock.mock.calls.some(
      ([url, init]) => String(url) === '/api/bookings/b1/proofs/p1/reject' && (init as RequestInit).method === 'POST',
    );
    expect(called).toBe(true);
  });

  it('asks for an extra confirmation before approving a MISMATCH (never auto-approves)', async () => {
    const mismatch = {
      id: 'c1', bookingId: 'b1', proofId: 'p1', analysisId: 'a1', overallStatus: 'MISMATCH', comparisonVersion: 'proof-compare-v1',
      errorMessage: null, createdAt: '2026-07-16T02:10:00.000Z',
      result: { overall: 'MISMATCH', version: 'proof-compare-v1', summary: { matchCount: 0, mismatchCount: 1, warningCount: 0, notFoundCount: 0 },
        fields: [{ field: 'TOTAL_AMOUNT', label: 'Giá tổng', importance: 'CRITICAL', result: 'MISMATCH', expected: '4.720.680', detected: '4.270.680', message: 'Giá tổng trong ảnh không khớp.' }] },
    };
    const fetchMock = installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/reception/shifts/current': () => OPEN_SHIFT,
      'GET /api/bookings/b1': () => ({ status: 200, body: { booking: PENDING_BOOKING } }),
      'GET /api/admin/bookings/b1/proofs/p1/analyses/latest': () => ({ status: 200, body: { analysis: null } }),
      'GET /api/admin/bookings/b1/proofs/p1/comparisons/latest': () => ({ status: 200, body: { comparison: mismatch } }),
      'POST /api/bookings/b1/proofs/p1/approve': () => ({ status: 200, body: { booking: COMPLETED_BOOKING } }),
    });

    const user = userEvent.setup();
    renderApp('/app/booking/b1');

    // The comparison card is visible with the mismatch banner.
    expect(await screen.findByLabelText('Kết quả đối chiếu: CÓ SAI KHÁC')).toBeInTheDocument();
    // Both manual verdict buttons remain available (never disabled by the result).
    const approveBtn = screen.getByRole('button', { name: /Đúng — xác nhận/ });
    expect(approveBtn).toBeEnabled();
    expect(screen.getByRole('button', { name: /Sai — yêu cầu tạo lại/ })).toBeEnabled();

    // Clicking approve does NOT auto-approve — it asks for confirmation first.
    await user.click(approveBtn);
    expect(await screen.findByText('Hệ thống phát hiện thông tin không khớp. Bạn vẫn muốn xác nhận đúng?')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/approve') && (i as RequestInit).method === 'POST')).toBe(false);

    // Confirming proceeds with the real approval.
    await user.click(screen.getByRole('button', { name: 'Vẫn xác nhận đúng' }));
    expect(await screen.findByText('Đã xác nhận đúng. Đơn đã hoàn thành.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/approve') && (i as RequestInit).method === 'POST')).toBe(true);
  });
});
