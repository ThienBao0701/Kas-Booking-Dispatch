import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { resolvePaymentStatus } from '../src/booking/paymentStatus';
import { extractSpecialRequest } from '../src/booking/arrivalNote';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'booking', '24-real-sample-extranet.txt'),
  'utf8',
);

function parse(): ParsedBooking {
  return parseBooking(RAW, branches);
}

describe('real Booking.com extranet sample — operational fields', () => {
  const r = parse();

  it('matches the guest to the correct branch (not the property ID name noise)', () => {
    expect(r.suggestedBranch?.address).toBe('40-42 Bùi Thị Xuân');
    expect(r.branchConfident).toBe(true);
  });

  it('takes the guest name, not chat/greeting/signature text', () => {
    expect(r.guestName).toBe('Iwan Jenkins');
  });

  it('takes the guest phone, not the hotel hotline', () => {
    expect(r.phone).toBe('+64 210 812 1300');
    expect(r.phone).not.toContain('3822'); // the hotline +84 28 3822 9999
  });

  it('takes the booking code, not the property ID', () => {
    expect(r.bookingCode).toBe('6339476198');
    expect(r.bookingCode).not.toBe('16774030');
  });

  it('takes the total room price, not the commission', () => {
    expect(r.totalAmount).toBe(510138);
    expect(r.currency).toBe('VND');
    // The commission amount (76.520) must never surface anywhere in the output.
    expect(JSON.stringify(r)).not.toContain('76520');
  });

  it('reads room count = 1 (one room), not the adult count = 2', () => {
    expect(r.rooms).toHaveLength(1);
  });

  it('parses Vietnamese weekday-abbreviated check-in/check-out', () => {
    expect(r.checkIn).toBe('2026-07-21');
    expect(r.checkOut).toBe('2026-07-22');
  });

  it('generates exactly one stay night (check-out excluded)', () => {
    const nights = r.rooms[0]!.nights;
    expect(nights).toHaveLength(1);
    expect(nights[0]!.stayDate).toBe('2026-07-21');
    expect(nights.some((n) => n.stayDate === '2026-07-22')).toBe(false);
  });

  it('uses the room price as the single nightly amount (not transfer/early-check-in fees)', () => {
    expect(r.rooms[0]!.nights[0]!.amount).toBe(510138);
    // 200.000 (early check-in fee) and 350.000 (transfer) must not be a night price.
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([510138]);
  });

  it('keeps the Vietnamese room type, dropping the English parenthetical', () => {
    expect(r.rooms[0]!.roomName).toBe('Phòng Tiêu Chuẩn Giường Đôi');
  });

  it('sets PAY_BEFORE from the prepayment policy', () => {
    expect(r.paymentStatus).toBe('PAY_BEFORE');
  });

  it('builds a concise special request from the guest chat (arrival + early check-in + luggage)', () => {
    expect(r.specialRequest).toBe(
      'Khách dự kiến đến khoảng 13:00. Khách hỏi nhận phòng sớm. Có thể gửi hành lý nếu phòng chưa sẵn sàng.',
    );
  });

  it('does not expose email, nationality, commission or IATA in the operational output', () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain('example.com');
    expect(json).not.toContain('New Zealand');
    expect(json).not.toContain('IATA');
    expect(json).not.toContain('hoa hong');
    expect(Object.keys(r as object)).not.toContain('email');
    expect(Object.keys(r as object)).not.toContain('nationality');
  });

  it('produces no warnings for the fully-extracted sample', () => {
    expect(r.warnings).toEqual([]);
  });
});

describe('payment status triggers', () => {
  it('PAY_BEFORE from the credit-card-hidden sentence', () => {
    expect(
      resolvePaymentStatus('… Quý vị không có quyền xem chi tiết thẻ tín dụng này. …', null),
    ).toBe('PAY_BEFORE');
  });

  it('PAY_BEFORE from an explicit prepayment policy', () => {
    expect(
      resolvePaymentStatus('Khách sẽ phải thanh toán trước toàn bộ tiền phòng bất kỳ lúc nào.', null),
    ).toBe('PAY_BEFORE');
    expect(resolvePaymentStatus('The guest will be charged the total price in advance.', null)).toBe(
      'PAY_BEFORE',
    );
  });

  it('PAY_AFTER when no prepayment signal is present (and "no prepayment" is not a false trigger)', () => {
    expect(resolvePaymentStatus('Không cần thanh toán trước. Thanh toán tại chỗ nghỉ.', null)).toBe(
      'PAY_AFTER',
    );
  });
});

describe('special-request extraction', () => {
  it('ignores hotel messages and returns null without a guest request', () => {
    const text = [
      'Khách sạn - 09:20',
      'Dear guest, early check-in before 14:00 costs 200.000 VND. Transfer at 350.000 VND per car.',
    ].join('\n');
    expect(extractSpecialRequest(text)).toBeNull();
  });

  it('extracts a guest arrival time only', () => {
    const text = ['Khách - 10:00', 'Hello, I will arrive around 3pm today.'].join('\n');
    expect(extractSpecialRequest(text)).toBe('Khách dự kiến đến khoảng 15:00.');
  });
});
