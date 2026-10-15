/**
 * The reception order-detail header and main card.
 *
 * Two things are being protected here, and they pull in opposite directions:
 *
 *   The DATES are the booking's own and must never be constants. Every
 *   assertion about a date is made against TWO different bookings, because a
 *   hard-coded date passes a single-booking test perfectly.
 *
 *   The TIMES are hotel policy and are the same on every booking. They are
 *   deliberately not booking fields, so the test asserts they survive
 *   unchanged across bookings whose dates differ.
 *
 * The rest is subtraction: the booking code left the header (it is a value to
 * COPY, and the main card's copy button is the one place to do that), and
 * Payment / Check-in / Check-out left the main card.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BookingDetailView } from './BookingDetailView';
import { EMPTY_OPERATIONAL_BLOCKS } from '../test/utils';
import type { BookingDetail } from '../api/bookings';

vi.mock('./ProofSection', () => ({ ProofSection: () => null }));

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

/* ================================================================== */
/* The header: two stay lines                                          */
/* ================================================================== */
describe('the sticky header shows both ends of the stay', () => {
  it('labels a check-in and a check-out line', () => {
    mount(booking());
    const header = screen.getByTestId('booking-sticky-header');
    expect(within(header).getByText('Nhận phòng :')).toBeInTheDocument();
    expect(within(header).getByText('Trả phòng :')).toBeInTheDocument();
  });

  it('sets the whole of each line bold, icon included', () => {
    mount(booking());
    const header = screen.getByTestId('booking-sticky-header');
    const row = within(header).getByText('Nhận phòng :').closest('div')!;
    expect(row.className).toContain('font-bold');
    // Nothing inside the row lowers the weight again.
    for (const el of Array.from(row.querySelectorAll('*'))) {
      expect(el.className.toString()).not.toMatch(/font-(thin|light|normal|medium)/);
    }
    expect(row.querySelector('svg')).not.toBeNull();
  });

  it('takes both dates from the booking', () => {
    mount(booking({ checkInDate: '2026-08-10', checkOutDate: '2026-08-12' }));
    const header = screen.getByTestId('booking-sticky-header');
    expect(within(header).getByText('10/08/2026')).toBeInTheDocument();
    expect(within(header).getByText('12/08/2026')).toBeInTheDocument();
  });

  it('renders a DIFFERENT booking with its own dates', () => {
    // The assertion that catches a hard-coded date. Same component, other
    // booking, and nothing from the first one may survive.
    mount(booking({ checkInDate: '2027-01-03', checkOutDate: '2027-01-09' }));
    const header = screen.getByTestId('booking-sticky-header');
    expect(within(header).getByText('03/01/2027')).toBeInTheDocument();
    expect(within(header).getByText('09/01/2027')).toBeInTheDocument();
    expect(within(header).queryByText('10/08/2026')).toBeNull();
  });

  it('shows a dash rather than inventing a date the booking does not have', () => {
    mount(booking({ checkOutDate: null as unknown as string }));
    const header = screen.getByTestId('booking-sticky-header');
    expect(within(header).getByText('10/08/2026')).toBeInTheDocument();
    expect(within(header).getByText('—')).toBeInTheDocument();
  });

  it('keeps the policy times fixed no matter the booking', () => {
    for (const dates of [
      { checkInDate: '2026-08-10', checkOutDate: '2026-08-12' },
      { checkInDate: '2027-01-03', checkOutDate: '2027-01-09' },
    ]) {
      const { unmount } = mount(booking(dates));
      const header = screen.getByTestId('booking-sticky-header');
      expect(within(header).getByText('02:00PM (CHIỀU)')).toBeInTheDocument();
      expect(within(header).getByText('12:00PM (TRƯA)')).toBeInTheDocument();
      unmount();
    }
  });

  it('no longer prints the booking code beside the date', () => {
    mount(booking({ bookingCode: 'A-1' }));
    expect(within(screen.getByTestId('booking-sticky-header')).queryByText('A-1')).toBeNull();
  });

  it('still names the guest', () => {
    mount(booking({ customerName: 'Trần Thị B' }));
    expect(screen.getByRole('heading', { name: 'Trần Thị B' })).toBeInTheDocument();
  });
});

/* ================================================================== */
/* The main card: four fields, nothing else                            */
/* ================================================================== */
describe('the main information card', () => {
  it('keeps exactly two fields for RECEPTION: the guest and the amount', () => {
    mount(booking(), false);
    expect(screen.getByText('Tên khách')).toBeInTheDocument();
    expect(screen.getByText('Tổng tiền')).toBeInTheDocument();
    expect(screen.queryByText('Mã Booking')).toBeNull();
    expect(screen.queryByText('Số điện thoại')).toBeNull();
  });

  it('keeps all four for an ADMIN', () => {
    mount(booking(), true);
    for (const label of ['Tên khách', 'Số điện thoại', 'Mã Booking', 'Tổng tiền']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('still has the phone on the booking — it is only not displayed', () => {
    // The number feeds the PMS note below. Removing the field removed a
    // display, not the data, and the note is what proves it.
    mount(booking({ phone: '+84901234567', adminPmsNote: null, rooms: [] }), false);
    expect(screen.queryByText('Số điện thoại')).toBeNull();
    expect(screen.getByTestId('pms-note-text').textContent).toContain('+84901234567');
  });

  it('drops payment, check-in and check-out for RECEPTION', () => {
    mount(booking(), false);
    expect(screen.queryByText('Thanh toán')).toBeNull();
    expect(screen.queryByText('Check-in')).toBeNull();
    expect(screen.queryByText('Check-out')).toBeNull();
  });

  it('keeps the branch and the payment for an ADMIN, and states each date once', () => {
    // The Admin's card keeps the branch and the payment terms. The two dates are
    // NOT repeated in it any more: they are in the header stay line, where they
    // are read on every booking, and a second copy was the same value twice.
    mount(booking(), true);
    expect(screen.getByText('Thanh toán')).toBeInTheDocument();
    expect(screen.getByText('Chi nhánh')).toBeInTheDocument();
    expect(screen.getAllByText('05 Trương Định').length).toBeGreaterThan(0);
    expect(screen.queryByText('Check-in')).toBeNull();
    expect(screen.queryByText('Check-out')).toBeNull();
    const header = screen.getByTestId('booking-sticky-header');
    expect(within(header).getByText('Nhận phòng :')).toBeInTheDocument();
    expect(within(header).getByText('Trả phòng :')).toBeInTheDocument();
    // The hotel is part of who the booking is, so it is in the header too.
    expect(within(header).getByTestId('booking-header-branch')).toHaveTextContent('05 Trương Định');
  });

  it('gives an Admin the real dates, once each, in the header', () => {
    mount(booking({ checkInDate: '2027-01-03', checkOutDate: '2027-01-09' }), true);
    expect(screen.getAllByText('03/01/2027')).toHaveLength(1);
    expect(screen.getAllByText('09/01/2027')).toHaveLength(1);
    expect(within(screen.getByTestId('booking-sticky-header')).getByText('03/01/2027')).toBeInTheDocument();
  });

  it('leaves no empty supporting row for a receptionist', () => {
    // Every supporting field is Admin-only, so for a receptionist the whole
    // block must be absent — not an empty grid holding margin under the four
    // fields above it.
    mount(booking(), false);
    expect(screen.queryByText('Chi nhánh')).toBeNull();
    const card = screen.getByText('Thông tin chính').closest('div[class*="rounded"]');
    expect(card?.querySelectorAll('div.grid')).toHaveLength(1);
  });

  it('gives an Admin exactly one more grid than a receptionist', () => {
    const { unmount } = mount(booking(), false);
    const receptionGrids = screen
      .getByText('Thông tin chính')
      .closest('div[class*="rounded"]')!
      .querySelectorAll('div.grid').length;
    unmount();

    mount(booking(), true);
    const adminGrids = screen
      .getByText('Thông tin chính')
      .closest('div[class*="rounded"]')!
      .querySelectorAll('div.grid').length;

    expect(adminGrids).toBe(receptionGrids + 1);
  });

  it('keeps a special request when the booking carries one', () => {
    mount(booking({ specialRequest: 'Phòng tầng cao' }));
    expect(screen.getByText('Ghi chú / Yêu cầu đặc biệt')).toBeInTheDocument();
    expect(screen.getByText('Phòng tầng cao')).toBeInTheDocument();
  });
});
