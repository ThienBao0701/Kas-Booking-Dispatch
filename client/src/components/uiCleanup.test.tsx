/**
 * Phase 5.2d — what a receptionist is allowed to see, and the note itself.
 *
 * The pilot found a booking detail that had accumulated everything anyone ever
 * thought might be useful: what the OTA said, who edited what, a chronological
 * log, and the name of whoever created the reservation in the PMS. A
 * receptionist creating a reservation reads five things and acts on them. All
 * of the rest is deleted, not hidden — a role check is one line away from
 * putting it back, and the whole point is that these components no longer
 * exist.
 *
 * THE ASSERTION THAT MATTERS MOST is about the note. It is a string contract
 * with the hotel system: a receptionist pastes it, character for character,
 * into the PMS. For Agoda and CTrip it is STORED at dispatch and shown back
 * verbatim — it cannot be rebuilt on this screen, because its second line
 * carries the price the GUEST booked at and that figure is not on the booking.
 * Anything that re-derived it would be inventing money.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BookingDetailView } from './BookingDetailView';
import { EMPTY_OPERATIONAL_BLOCKS } from '../test/utils';
import type { BookingDetail, BookingSource } from '../api/bookings';

vi.mock('./ProofSection', () => ({ ProofSection: () => <div data-testid="proof-section" /> }));

/** The exact note dispatch stores for an Agoda CN reservation. */
const AGODA_NOTE = 'AGD 1757380288_1STAN_1DEM 750.945 CN\nGIÁ KHÁCH ĐẶT 1.050.000 KHÔNG ĂN SÁNG';

function booking(over: Partial<BookingDetail> = {}): BookingDetail {
  return {
    id: 'b1',
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    businessType: 'DIRECT',
    businessTypeManuallyConfirmed: false,
    hotelName: 'Saigon Hotel',
    branch: { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' },
    branchId: 1,
    customerName: 'Nguyễn Văn A',
    phone: '0901234567',
    bookingCode: 'A-1',
    checkInDate: '2026-08-10',
    checkOutDate: '2026-08-12',
    checkInTime: null,
    checkOutTime: null,
    totalAmount: 1_000_000,
    currency: 'VND',
    paymentStatus: 'PAY_BEFORE',
    specialRequest: null,
    parserVersion: '5.0.0',
    isLastMinute: false,
    rooms: [],
    warnings: [],
    proofs: [],
    createdBy: null,
    sentBy: null,
    completedBy: null,
    reviewedBy: null,
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-01T02:00:00.000Z',
    sentAt: '2026-08-01T02:00:00.000Z',
    completedAt: null,
    completionNote: null,
    reviewedAt: null,
    adminPmsNote: null,
    reviewedPaymentMode: null,
    ...EMPTY_OPERATIONAL_BLOCKS,
    ...over,
  } as BookingDetail;
}

/** An OTA booking as dispatch stored it: the note is on the row. */
function otaBooking(source: BookingSource, over: Partial<BookingDetail> = {}) {
  return booking({
    sourcePlatform: source,
    phone: null,
    adminPmsNote: AGODA_NOTE,
    reviewedPaymentMode: 'CN',
    ...over,
  });
}

function mount(b: BookingDetail, isAdmin = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BookingDetailView booking={b} isAdmin={isAdmin} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ROOM = {
  id: 'r1',
  roomIndex: 1,
  roomType: 'Deluxe',
  roomSubtotal: 1_000_000,
  taxAmount: null,
  feeAmount: null,
  nights: [
    { id: 'n1', stayDate: '2026-08-10', amount: 500_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
  ],
};

/* ================================================================== */
/* B — reception displays the PMS note, exactly as stored              */
/* ================================================================== */
describe('B the PMS note', () => {
  it('shows reception the stored note, character for character', () => {
    mount(otaBooking('AGODA'));
    expect(screen.getByTestId('pms-note-text').textContent).toBe(AGODA_NOTE);
  });

  it('preserves uppercase, spacing and the line break', () => {
    mount(otaBooking('AGODA'));
    const pre = screen.getByTestId('pms-note-text');
    // A `pre` with pre-wrap: the PMS expects two lines and gets two lines.
    expect(pre.tagName).toBe('PRE');
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.textContent).toContain('\n');
    expect(pre.textContent).toContain('GIÁ KHÁCH ĐẶT 1.050.000');
  });

  it('never rebuilds the note from the booking', () => {
    // The stored text wins even when every field needed to generate a
    // Booking.com-style note is present. Regeneration here would print a
    // different note than the Admin approved.
    mount(otaBooking('AGODA', { rooms: [ROOM], bookingCode: 'A-1' }));
    expect(screen.getByTestId('pms-note-text').textContent).toBe(AGODA_NOTE);
    expect(document.body.textContent).not.toContain('BK A-1');
  });

  it('is headed PMS NOTE and nothing else', () => {
    mount(otaBooking('AGODA'));
    expect(screen.getByText('PMS NOTE')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Ghi chú tạo đơn');
    expect(document.body.textContent).not.toContain('Người tạo PMS');
  });

  it('copies the note whole', async () => {
    // Both lines, in one action. Retyping is where a digit goes missing, and
    // every figure here is one a guest is charged for.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    mount(otaBooking('AGODA'));

    await userEvent.click(screen.getByRole('button', { name: /Sao chép PMS Note/ }));
    expect(writeText).toHaveBeenCalledWith(AGODA_NOTE);
    vi.unstubAllGlobals();
  });

  it('shows exactly one note card, never two', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM] }));
    expect(screen.getAllByTestId('pms-note-card')).toHaveLength(1);
  });

  it('says so plainly when an old OTA booking stored no note', () => {
    // Dispatched before the note was stored. It used to fall through to the
    // Booking.com builder and print PAY BEFORE CHECK-IN on an Agoda booking —
    // wording that source never uses.
    mount(otaBooking('AGODA', { adminPmsNote: null, rooms: [ROOM] }));
    expect(screen.queryByTestId('pms-note-text')).toBeNull();
    expect(screen.getByText(/trước khi hệ thống lưu ghi chú PMS/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PAY BEFORE CHECK-IN');
  });

  it('leaves the Booking.com generated note exactly as it was', () => {
    // Nights come from the dates (10th → 12th), not from the nightly rows.
    mount(booking({ rooms: [ROOM], adminPmsNote: null }));
    expect(screen.getByTestId('pms-note-text').textContent).toContain(
      'BK A-1_1DLX_2 ĐÊM 1.000.000 PAY BEFORE CHECK-IN CI',
    );
  });
});

/* ================================================================== */
/* C — branch                                                          */
/* ================================================================== */
describe('C branch display', () => {
  it('shows reception no branch field', () => {
    mount(otaBooking('AGODA'), false);
    expect(screen.queryByText('Chi nhánh')).toBeNull();
    expect(document.body.textContent).not.toContain('05 Trương Định');
  });

  it('keeps it for an Admin, who dispatches across all of them', () => {
    mount(otaBooking('AGODA'), true);
    expect(screen.getByText('Chi nhánh')).toBeInTheDocument();
  });

  it('keeps the branch on the booking, so filtering is unaffected', () => {
    // Only the DISPLAY went. The identifiers the queries use are untouched.
    const b = otaBooking('AGODA');
    mount(b, false);
    expect(b.branchId).toBe(1);
    expect(b.branch?.code).toBe('TRUONG_DINH_05');
  });
});

/* ================================================================== */
/* D/E/F/I — what reception is left with                               */
/* ================================================================== */
describe('I the reception booking detail', () => {
  const full = () =>
    otaBooking('AGODA', {
      rooms: [ROOM],
      operational: {
        ...EMPTY_OPERATIONAL_BLOCKS.operational,
        receivedAt: '2026-08-02T03:00:00.000Z',
        receivedBy: { id: 2, fullName: 'Lễ tân Một' },
      },
    });

  it('holds the five sections it is meant to hold', () => {
    mount(full(), false);
    expect(screen.getByTestId('booking-sticky-header')).toBeInTheDocument();
    expect(screen.getByText('Thông tin chính')).toBeInTheDocument();
    expect(screen.getByTestId('pms-note-card')).toBeInTheDocument();
    expect(screen.getByTestId('rooms-section')).toBeInTheDocument();
    expect(screen.getByTestId('proof-section')).toBeInTheDocument();
  });

  it('holds nothing else', () => {
    mount(full(), false);
    for (const testId of [
      'ota-metadata-card',
      'corrections-card',
      'timeline-card',
      'operational-card',
      'admin-pms-note-card',
      'request-audit',
    ]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
    expect(screen.queryByText(/Thông tin điều phối/)).toBeNull();
  });

  it('renders no empty card where a removed section used to be', () => {
    // A card that renders its heading and nothing else is worse than no card:
    // it reads as data that failed to load.
    mount(full(), false);
    for (const heading of ['Thông tin từ OTA', 'Lịch sử chỉnh sửa', 'Nhật ký', 'Diễn biến thực tế']) {
      expect(screen.queryByText(heading), heading).toBeNull();
    }
    expect(document.querySelectorAll('[data-testid$="-card"]').length).toBeGreaterThan(0);
  });

  it('still warns reception when the parser could not read a field', () => {
    // Kept deliberately against the five-section list: a warning is something
    // to act on, unlike the record-keeping the rest of this phase removed.
    mount(booking({ warnings: [{ code: 'X', message: 'Không đọc được ngày trả phòng.', severity: 'WARNING' }] }));
    expect(screen.getByText('Không đọc được ngày trả phòng.')).toBeInTheDocument();
  });
});

/* ================================================================== */
/* J — the Admin detail                                                */
/* ================================================================== */
describe('J the admin booking detail', () => {
  it('shows an Admin no edit history, activity log or creator note either', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM] }), true);
    expect(screen.queryByTestId('corrections-card')).toBeNull();
    expect(screen.queryByTestId('timeline-card')).toBeNull();
    expect(screen.queryByTestId('admin-pms-note-card')).toBeNull();
    expect(screen.queryByTestId('ota-metadata-card')).toBeNull();
  });

  it('keeps the operational information an Admin works from — minus the dispatch section', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM] }), true);
    expect(screen.getByTestId('pms-note-card')).toBeInTheDocument();
    expect(screen.getByTestId('rooms-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Xoá đơn/ })).toBeInTheDocument();
    // "Thông tin điều phối (Admin)" is gone as a section.
    expect(screen.queryByText(/Thông tin điều phối/)).toBeNull();
  });

  it('moves the internal details out of the main hierarchy, and deletes none of them', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM], parserVersion: 'p-9' }), true);
    // Collapsed by default: a native <details> that is not `open`.
    const internal = screen.getByTestId('booking-internal-more') as HTMLDetailsElement;
    expect(internal.open).toBe(false);
    expect(within(internal).getByText(/Chi tiết nội bộ/)).toBeInTheDocument();
    // …and everything the removed section held is still inside it.
    const times = within(internal).getByTestId('booking-internal-times');
    expect(times).toHaveTextContent('Gửi lúc (sentAt)');
    expect(times).toHaveTextContent('Xác nhận lúc (completedAt)');
    expect(times).toHaveTextContent('Phiên bản trích xuất: p-9');
    // The PMS note and the rooms are secondary for an Admin, one click down.
    const more = screen.getByTestId('booking-detail-more') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(within(more).getByTestId('pms-note-card')).toBeInTheDocument();
    expect(within(more).getByTestId('rooms-section')).toBeInTheDocument();
  });

  it('keeps the original booking content, on its own line and never collapsed away', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM], rawText: 'NỘI DUNG GỐC CỦA ĐƠN' }), true);
    const card = screen.getByTestId('raw-content-card');
    expect(within(card).getByText('Xem nội dung Booking.com gốc')).toBeInTheDocument();
    expect(card).toHaveTextContent('NỘI DUNG GỐC CỦA ĐƠN');
    // Not inside either of the collapsed groups.
    expect(screen.getByTestId('booking-detail-more').contains(card)).toBe(false);
    expect(screen.getByTestId('booking-internal-more').contains(card)).toBe(false);
  });

  it('puts the evidence and its actions above the secondary details', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM] }), true);
    const proof = screen.getByTestId('proof-section');
    const more = screen.getByTestId('booking-detail-more');
    expect(proof.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no raw-content card when the booking has no original text', () => {
    mount(otaBooking('AGODA', { rooms: [ROOM] }), true);
    expect(screen.queryByTestId('raw-content-card')).toBeNull();
  });
});
