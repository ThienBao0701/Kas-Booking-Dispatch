import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { extractSpecialRequest } from '../src/booking/arrivalNote';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const THREE_ROOM = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'booking', '26-real-sample-three-rooms.txt'),
  'utf8',
);

function guest(...lines: string[]): string {
  return ['Khách - 27 Tháng 7 2026 10:00', ...lines].join('\n');
}

describe('special-request composition (unit)', () => {
  it('normalizes an adjacent-rooms request', () => {
    const text = 'Thông tin quan trọng về khách hàng này\nKhách muốn các phòng nằm gần nhau nếu có thể.';
    expect(extractSpecialRequest(text)).toBe('Cần bố trí các phòng gần nhau.');
  });

  it('normalizes an English "adjacent rooms" request', () => {
    expect(extractSpecialRequest('Guest requests adjacent rooms if possible.')).toBe(
      'Cần bố trí các phòng gần nhau.',
    );
  });

  it('prefers the structured arrival range over chat', () => {
    const text = [
      'Thời gian đến dự kiến',
      'Từ 1:00 PM đến 2:00 PM',
      'Yêu cầu nhận phòng:',
      'Khách yêu cầu nhận phòng trong khoảng 13:00 - 14:00.',
      guest('I will arrive around 6pm.'),
    ].join('\n');
    expect(extractSpecialRequest(text)).toBe('Khách dự kiến đến trong khoảng 13:00 - 14:00.');
  });

  it('detects an explicit early-check-in request (not a mere arrival time)', () => {
    expect(extractSpecialRequest(guest('Is early check-in possible?'))).toBe('Khách hỏi nhận phòng sớm.');
    // A bare arrival time is not an early-check-in request.
    expect(extractSpecialRequest(guest('I will arrive around 3pm.'))).toBe('Khách dự kiến đến khoảng 15:00.');
  });

  it('detects two flights and their arrival times', () => {
    const text = guest('We arrive on two separate flights, around 8 AM and 11 AM respectively.');
    expect(extractSpecialRequest(text)).toBe(
      'Khách đến bằng 2 chuyến bay; các chuyến bay dự kiến đến khoảng 08:00 và 11:00.',
    );
  });

  it('merges a luggage request exactly once', () => {
    const text = guest('Can we store our luggage and leave our bags at reception?');
    expect(extractSpecialRequest(text)).toBe('Có thể gửi hành lý nếu phòng chưa sẵn sàng.');
  });

  it('ignores hotel replies, transfer prices, addresses and Maps links', () => {
    const text = [
      guest('Hello.'),
      'Khách sạn - 10:10',
      'Early check-in before 14:00 costs 200.000 VND. Airport transfer 350.000 VND per car.',
      'Địa chỉ: 05 Trương Định. Bản đồ: https://maps.google.com/?q=hotel',
    ].join('\n');
    expect(extractSpecialRequest(text)).toBeNull();
  });

  it('never includes phone numbers in the special request', () => {
    const text = guest('Call me at +84 964 934 713 when ready. I will arrive around 2pm.');
    const out = extractSpecialRequest(text)!;
    expect(out).toBe('Khách dự kiến đến khoảng 14:00.');
    expect(out).not.toContain('964');
  });

  it('returns null when there is no safe operational request', () => {
    expect(extractSpecialRequest(guest('Thanks, see you soon!'))).toBeNull();
    expect(extractSpecialRequest('No guest chat here at all.')).toBeNull();
  });

  it('composes fragments in priority order and deduplicates', () => {
    const text = [
      'Khách muốn các phòng gần nhau.',
      guest(
        'We arrive on two separate flights around 8 AM and 11 AM. Can we store our luggage? Can we store luggage again?',
      ),
    ].join('\n');
    expect(extractSpecialRequest(text)).toBe(
      'Cần bố trí các phòng gần nhau. Khách đến bằng 2 chuyến bay; các chuyến bay dự kiến đến khoảng 08:00 và 11:00. Có thể gửi hành lý nếu phòng chưa sẵn sàng.',
    );
  });

  it('caps the composed note to a safe operational length', () => {
    const out = extractSpecialRequest(
      'Khách muốn các phòng gần nhau. ' + guest('arrive around 2pm and store luggage'),
    );
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(500);
  });
});

describe('three numbered physical rooms + reservation-level guest protection', () => {
  const r: ParsedBooking = parseBooking(THREE_ROOM, branches);

  it('keeps the reservation-level customer name, not the room occupants', () => {
    expect(r.guestName).toBe('Thùy Chi Phan');
    expect(JSON.stringify(r.rooms)).not.toContain('Nguyễn Văn Huyên');
    expect(JSON.stringify(r.rooms)).not.toContain('Phan Thùy Chi');
  });

  it('raises no duplicate-label conflict from the room-level "Tên khách" labels', () => {
    expect(r.warnings.map((w) => w.code)).not.toContain('DUPLICATED_LABEL_CONFLICT');
  });

  it('keeps exactly three separate rooms of the same type (never merged)', () => {
    expect(r.rooms).toHaveLength(3);
    expect(r.rooms.map((rm) => rm.roomName)).toEqual([
      'Phòng Tiêu Chuẩn Giường Đôi',
      'Phòng Tiêu Chuẩn Giường Đôi',
      'Phòng Tiêu Chuẩn Giường Đôi',
    ]);
    expect(r.rooms.map((rm) => rm.roomIndex)).toEqual([1, 2, 3]);
  });

  it('does not create a fourth room from the repeated policy heading', () => {
    expect(r.rooms).toHaveLength(3);
  });

  it('keeps the booking-level total, not a room subtotal', () => {
    expect(r.totalAmount).toBe(2_100_000);
    expect(r.rooms.every((rm) => rm.roomTotal === 700_000)).toBe(true);
  });

  it('extracts the main guest-block phone', () => {
    expect(r.phone).toBe('+84 964 934 713');
  });

  it('composes the adjacent-rooms + flights + luggage request', () => {
    expect(r.specialRequest).toBe(
      'Cần bố trí các phòng gần nhau. Khách đến bằng 2 chuyến bay; các chuyến bay dự kiến đến khoảng 08:00 và 11:00. Có thể gửi hành lý nếu phòng chưa sẵn sàng.',
    );
  });

  it('produces no warnings at all', () => {
    // Since 5.1 the hotel name resolves outright, so the branch-confirmation
    // warning that used to be the only one left is gone too.
    expect(r.warnings.map((w) => w.code)).toEqual([]);
  });
});
