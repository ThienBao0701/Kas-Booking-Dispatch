/**
 * Phase 5.2 pilot hotfixes, as behaviour.
 *
 * These are the frictions the pilot found. Each one is a case where the screen
 * told a receptionist something the source never said, or buried something
 * they need on every booking:
 *
 *   PAY BEFORE CHECK-IN shown for an Agoda reservation whose mail says "CN";
 *   an empty phone field for a source that never sends phone numbers;
 *   nightly rates behind a disclosure that must be opened for every guest;
 *   developer-facing history on the screen reception works from.
 *
 * The most important assertions here are the negative ones — Booking.com must
 * be untouched, because it is the certified path the hotel already runs on.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BookingDetailView } from './BookingDetailView';
import { EMPTY_OPERATIONAL_BLOCKS } from '../test/utils';
import type { BookingDetail, BookingSource } from '../api/bookings';

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

/** An OTA booking with its parsed payment wording, as dispatch stored it. */
function otaBooking(source: BookingSource, paymentType: string | null, over: Partial<BookingDetail> = {}) {
  return booking({
    sourcePlatform: source,
    phone: null,
    ota: { paymentType },
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
    { id: 'n2', stayDate: '2026-08-11', amount: 500_000, currency: 'VND', manuallyCorrected: false, isEstimated: false },
  ],
};

/* ================================================================== */
/* H1 — payment wording per source (ADMIN card)                        */
/* ================================================================== */
/**
 * H1 was "PAY BEFORE CHECK-IN shown for an Agoda reservation whose mail says
 * CN": the wrong payment wording reaching a branch. The field now lives on the
 * ADMIN card only, so every assertion here mounts as an Admin — that is where
 * the behaviour H1 fixed still has to hold. Reception's own (empty) case is
 * covered in receptionDetailFields.test.tsx.
 */
describe('H1 payment display', () => {
  it('keeps PAY BEFORE CHECK-IN for Booking.com', () => {
    mount(booking({ paymentStatus: 'PAY_BEFORE' }), true);
    expect(screen.getByText('PAY BEFORE CHECK-IN')).toBeInTheDocument();
  });

  it('keeps PAY AFTER CHECK-IN for Booking.com', () => {
    mount(booking({ paymentStatus: 'PAY_AFTER' }), true);
    expect(screen.getByText('PAY AFTER CHECK-IN')).toBeInTheDocument();
  });

  it('shows the Agoda wording exactly as the parser produced it', () => {
    mount(otaBooking('AGODA', 'CN'), true);
    expect(screen.getByText('CN')).toBeInTheDocument();
    // Never translated into the Booking.com vocabulary.
    expect(screen.queryByText('PAY BEFORE CHECK-IN')).toBeNull();
    expect(screen.queryByText('PAY AFTER CHECK-IN')).toBeNull();
  });

  it('shows a different Agoda wording verbatim too', () => {
    // Proves nothing is mapped: whatever the mail said is what appears.
    mount(otaBooking('AGODA', 'Pay at Hotel'), true);
    expect(screen.getByText('Pay at Hotel')).toBeInTheDocument();
  });

  it('shows no payment field for CTrip, which states none', () => {
    // The CTrip parser extracts no payment value. An invented one is exactly
    // the sort of thing a branch would act on.
    mount(otaBooking('CTRIP', null), true);
    expect(screen.queryByText('Thanh toán')).toBeNull();
    expect(screen.queryByText('PAY BEFORE CHECK-IN')).toBeNull();
  });

  it('shows no payment field for an Agoda mail that stated none', () => {
    mount(otaBooking('AGODA', null), true);
    expect(screen.queryByText('Thanh toán')).toBeNull();
  });

  it('shows a receptionist no payment field whatever the source said', () => {
    // The wording cannot be wrong on a screen that does not carry it.
    mount(otaBooking('AGODA', 'CN'), false);
    expect(screen.queryByText('Thanh toán')).toBeNull();
    expect(screen.queryByText('CN')).toBeNull();
  });
});

/* ================================================================== */
/* H2 — phone                                                          */
/* ================================================================== */
/**
 * H2 was about WHICH bookings get a phone field. The field itself is now
 * ADMIN-ONLY — reception reads the number off the PMS note instead — so the H2
 * rule is asserted where the field still exists, plus one case proving
 * reception never sees it whatever the source said.
 */
describe('H2 phone section', () => {
  it('hides the phone entirely for an OTA booking without one', () => {
    mount(otaBooking('AGODA', 'CN'), true);
    expect(screen.queryByText('Số điện thoại')).toBeNull();
    // No placeholder either — that would send someone looking for a number
    // that was never sent.
    expect(screen.queryByText('(Hiển thị số điện thoại)')).toBeNull();
  });

  it('shows the phone for an OTA booking that does have one', () => {
    mount(otaBooking('AGODA', 'CN', { phone: '0987654321' }), true);
    expect(screen.getByText('Số điện thoại')).toBeInTheDocument();
    expect(screen.getByText('0987654321')).toBeInTheDocument();
  });

  it('leaves Booking.com unchanged, placeholder and all', () => {
    mount(booking({ phone: null }), true);
    expect(screen.getByText('Số điện thoại')).toBeInTheDocument();
    expect(screen.getByText('(Hiển thị số điện thoại)')).toBeInTheDocument();
  });

  it('shows a receptionist no phone field at all', () => {
    mount(booking({ phone: '0987654321' }), false);
    expect(screen.queryByText('Số điện thoại')).toBeNull();
    expect(screen.queryByText('(Hiển thị số điện thoại)')).toBeNull();
  });
});

/* ================================================================== */
/* H5 / H10 — nightly rates                                            */
/* ================================================================== */
describe('H5/H10 nightly rates', () => {
  it('shows every night immediately, with nothing to expand', () => {
    mount(booking({ rooms: [ROOM] }));
    const section = screen.getByTestId('rooms-section');
    // Scoped to the section: the check-in date also appears in the sticky
    // header, which is correct and not what this asserts.
    expect(within(section).getByText('10/08/2026')).toBeInTheDocument();
    expect(within(section).getByText('11/08/2026')).toBeInTheDocument();
    // No disclosure control anywhere in the section.
    expect(section.querySelector('[aria-expanded]')).toBeNull();
  });

  it('shows every room when there are several', () => {
    mount(booking({ rooms: [ROOM, { ...ROOM, id: 'r2', roomIndex: 2, roomType: 'Superior' }] }));
    expect(screen.getByText(/Deluxe/)).toBeInTheDocument();
    expect(screen.getByText(/Superior/)).toBeInTheDocument();
  });

  it('hides the section entirely when there are no rooms', () => {
    mount(booking({ rooms: [] }));
    expect(screen.queryByTestId('rooms-section')).toBeNull();
  });
});

/* ================================================================== */
/* H6 — lifecycle UI is gone                                           */
/* ================================================================== */
describe('H6 lifecycle controls', () => {
  it('offers no lifecycle action to a receptionist', () => {
    mount(booking({ status: 'NEW' }), false);
    for (const label of ['Nhận đơn', 'Khách nhận phòng', 'Khách trả phòng', 'Hoàn tất', 'Huỷ đơn', 'Khách không đến']) {
      expect(screen.queryByRole('button', { name: label }), label).toBeNull();
    }
    expect(screen.queryByTestId('lifecycle-actions')).toBeNull();
  });

  it('offers none to an admin either', () => {
    mount(booking({ status: 'RECEIVED' }), true);
    expect(screen.queryByTestId('lifecycle-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Khách nhận phòng' })).toBeNull();
  });
});

/* ================================================================== */
/* H8 — reception sees only what it works from                         */
/* ================================================================== */
describe('H8 reception booking detail', () => {
  // 5.2d removed the corrections and timeline blocks from the response
  // entirely, so this fixture no longer carries them — the operational record
  // is what is left to withhold from reception.
  const rich = () =>
    booking({
      rooms: [ROOM],
      operational: {
        ...EMPTY_OPERATIONAL_BLOCKS.operational,
        receivedAt: '2026-08-02T03:00:00.000Z',
        receivedBy: { id: 2, fullName: 'Lễ tân Một' },
      },
    });

  it('hides operational history from reception', () => {
    mount(rich(), false);
    expect(screen.queryByTestId('operational-card')).toBeNull();
  });

  it('still shows reception the booking it must act on', () => {
    mount(rich(), false);
    expect(screen.getByText('Thông tin chính')).toBeInTheDocument();
    expect(screen.getByTestId('rooms-section')).toBeInTheDocument();
    expect(screen.getByTestId('pms-note-card')).toBeInTheDocument();
  });

  it('keeps the operational record for an admin', () => {
    mount(rich(), true);
    expect(screen.getByTestId('operational-card')).toBeInTheDocument();
  });

  it('never shows reception the admin dispatch block', () => {
    mount(rich(), false);
    expect(screen.queryByText(/Thông tin điều phối/)).toBeNull();
    expect(screen.queryByTestId('request-audit')).toBeNull();
  });
});

/* ================================================================== */
/* Booking.com is untouched                                            */
/* ================================================================== */
describe('Booking.com is unchanged by every hotfix', () => {
  it('renders the same four main fields it always did, for an Admin', () => {
    mount(booking({ rooms: [ROOM] }), true);
    for (const label of ['Tên khách', 'Số điện thoại', 'Mã Booking', 'Tổng tiền']) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('still generates its PMS note', () => {
    // Generated, not stored — Booking.com dispatch has never collected one, and
    // the builder that produces this line predates the OTA path entirely.
    mount(booking({ rooms: [ROOM], adminPmsNote: null }));
    expect(screen.getByTestId('pms-note-text')).toHaveTextContent(
      'BK A-1_1DLX_2 ĐÊM 1.000.000 PAY BEFORE CHECK-IN CI',
    );
  });
});

/** 5.2b chose WHICH wording the Admin card shows, so these mount as Admin. */
describe('5.2b reviewed payment', () => {
  it('shows the mode the Admin reviewed, not the mail wording', () => {
    mount(otaBooking('AGODA', 'Pay at Hotel', { reviewedPaymentMode: 'CN' }), true);
    expect(screen.getByText('CN')).toBeInTheDocument();
    expect(screen.queryByText('Pay at Hotel')).toBeNull();
  });

  it('shows the reviewed mode for CTrip, which used to show nothing', () => {
    mount(otaBooking('CTRIP', null, { reviewedPaymentMode: 'HOTEL_PAYMENT' }), true);
    expect(screen.getByText('THANH TOÁN TẠI KHÁCH SẠN')).toBeInTheDocument();
  });

  it('falls back to the mail wording for a booking dispatched before 5.2b', () => {
    mount(otaBooking('AGODA', 'CN', { reviewedPaymentMode: null }), true);
    expect(screen.getByText('CN')).toBeInTheDocument();
  });

  it('still shows nothing when neither exists', () => {
    mount(otaBooking('CTRIP', null, { reviewedPaymentMode: null }), true);
    expect(screen.queryByText('Thanh toán')).toBeNull();
  });

  it('leaves Booking.com on its own badge', () => {
    mount(booking({ paymentStatus: 'PAY_BEFORE', reviewedPaymentMode: null }), true);
    expect(screen.getByText('PAY BEFORE CHECK-IN')).toBeInTheDocument();
  });
});

/* ================================================================== */
/* 5.2c — one chip, no branch, delete for Admin only                   */
/* ================================================================== */
describe('5.2c single workflow chip', () => {
  it('shows exactly one workflow state to a receptionist', () => {
    mount(otaBooking('CTRIP', null, { verificationStatus: 'NOT_SUBMITTED' }), false);
    expect(screen.getAllByTestId('workflow-badge')).toHaveLength(1);
    expect(screen.getByTestId('workflow-badge')).toHaveTextContent('Chờ chi nhánh tạo');
  });

  it('names each workflow state', () => {
    for (const [status, label] of [
      ['PENDING_REVIEW', 'Chờ kiểm tra'],
      ['APPROVED', 'Đã xác nhận đúng'],
      ['REJECTED', 'Cần tạo lại'],
    ] as const) {
      const { unmount } = mount(otaBooking('AGODA', null, { verificationStatus: status }));
      expect(screen.getByTestId('workflow-badge')).toHaveTextContent(label);
      unmount();
    }
  });

  it('shows a receptionist no source or business-type chip beside it', () => {
    // Four chips at once left them working out which one meant "act on this".
    mount(otaBooking('CTRIP', null), false);
    expect(screen.queryByText('CTrip')).toBeNull();
    expect(screen.queryByText('ĐƠN THƯỜNG')).toBeNull();
  });

  it('still gives an Admin the source', () => {
    mount(otaBooking('CTRIP', null), true);
    expect(screen.getByText('CTrip')).toBeInTheDocument();
  });
});

describe('5.2c branch is not shown', () => {
  it('omits the branch address from the header', () => {
    // The receptionist is standing in the branch.
    mount(booking({ branch: { id: 1, code: 'X', hotelName: 'H', address: '05 Trương Định' } }), false);
    expect(screen.getByTestId('booking-sticky-header')).not.toHaveTextContent('05 Trương Định');
  });
});

describe('5.2c delete booking', () => {
  it('offers no delete control to a receptionist', () => {
    mount(booking(), false);
    expect(screen.queryByTestId('delete-booking')).toBeNull();
  });

  it('offers one to an Admin', () => {
    mount(booking(), true);
    expect(screen.getByTestId('delete-booking')).toBeInTheDocument();
  });

  it('asks before deleting, and says what survives', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mount(booking(), true);
    await userEvent.click(screen.getByTestId('delete-booking'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Nguyễn Văn A');
    // The operator is told the audit trail is kept, not left to assume it.
    expect(dialog).toHaveTextContent('vẫn được giữ lại');
  });
});
