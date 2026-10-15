import { describe, expect, it } from 'vitest';
import type { BookingDetail } from '../api/bookings';
import { buildCopyAll, copyMoney, copyPhone, roomBlock, roomNightsText } from './copyText';

function booking(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return {
    id: 'b1',
    status: 'NEW',
    sourcePlatform: 'BOOKING_COM',
    verificationStatus: 'NOT_SUBMITTED',
    // Unclaimed: these fixtures are about text formatting, not ownership.
    claimedBy: null,
    claimedByUserId: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimCycle: 0,
    businessType: 'DIRECT',
    businessTypeManuallyConfirmed: false,
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
    // 5.2b: a Booking.com fixture collects no Admin note, so both are null.
    adminPmsNote: null,
    reviewedPaymentMode: null,
    // Phase 5 operational blocks — a Booking.com fixture stores none of the
    // OTA metadata, exactly as the database does.
    ota: { paymentType: null },
    operational: {
      receivedAt: null,
      receivedBy: null,
      actualCheckInAt: null,
      checkedInBy: null,
      actualCheckOutAt: null,
      checkedOutBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    },
    proofs: [],
    createdBy: null,
    sentBy: null,
    completedBy: null,
    reviewedBy: null,
    createdAt: '2026-07-15T02:00:00.000Z',
    updatedAt: '2026-07-15T02:00:00.000Z',
    sentAt: '2026-07-15T02:00:00.000Z',
    completedAt: null,
    completionNote: null,
    reviewedAt: null,
    ...overrides,
  };
}

describe('copy helpers', () => {
  it('formats VND with grouping and a dash placeholder', () => {
    expect(copyMoney(850_000)).toBe('850.000 ₫');
    expect(copyMoney(null)).toBe('Chưa xác định');
  });

  it('uses the phone placeholder when hidden', () => {
    expect(copyPhone('0901234567')).toBe('0901234567');
    expect(copyPhone(null)).toBe('(Hiển thị số điện thoại)');
    expect(copyPhone('  ')).toBe('(Hiển thị số điện thoại)');
  });

  it('copies all nightly prices for a room', () => {
    expect(roomNightsText(booking().rooms[0]!)).toBe('* Đêm 19/07/2026: 850.000 ₫\n* Đêm 20/07/2026: 850.000 ₫');
  });

  it('copies a full room block with subtotal', () => {
    expect(roomBlock(booking().rooms[0]!, 1)).toBe(
      ['PHÒNG 1:', 'HẠNG PHÒNG: Deluxe Double Room', '* Đêm 19/07/2026: 850.000 ₫', '* Đêm 20/07/2026: 850.000 ₫', 'TẠM TÍNH PHÒNG: 1.700.000 ₫'].join('\n'),
    );
  });
});

describe('buildCopyAll — exact format', () => {
  it('produces the agreed plain-text layout', () => {
    const expected = [
      'CHI NHÁNH: 05 Trương Định',
      'NAME: Nguyễn Văn A',
      'SDT: 0901234567',
      'MÃ BOOKING: 489234523',
      'GIÁ TIỀN TỔNG: 1.700.000 ₫',
      'NGÀY CHECK IN: Chủ Nhật, 19/07/2026',
      'NGÀY CHECK OUT: Thứ Ba, 21/07/2026',
      'GIÁ TIỀN CHO TỪNG ĐÊM CỦA TỪNG PHÒNG:',
      '',
      'PHÒNG 1:',
      'HẠNG PHÒNG: Deluxe Double Room',
      '* Đêm 19/07/2026: 850.000 ₫',
      '* Đêm 20/07/2026: 850.000 ₫',
      '',
      'TRẠNG THÁI: PAY AFTER CHECK-IN',
    ].join('\n');
    expect(buildCopyAll(booking())).toBe(expected);
  });

  it('renders placeholders for a missing phone and a missing nightly amount', () => {
    const b = booking({ phone: null });
    b.rooms[0]!.nights[1]!.amount = null;
    const text = buildCopyAll(b);
    expect(text).toContain('SDT: (Hiển thị số điện thoại)');
    expect(text).toContain('* Đêm 20/07/2026: Chưa xác định');
  });

  it('lists every room in a multi-room booking', () => {
    const b = booking();
    b.rooms.push({
      ...b.rooms[0]!,
      id: 'r2',
      roomIndex: 2,
      roomType: 'Superior Twin Room',
    });
    const text = buildCopyAll(b);
    expect(text).toContain('PHÒNG 1:');
    expect(text).toContain('PHÒNG 2:');
    expect(text).toContain('HẠNG PHÒNG: Superior Twin Room');
  });
});
