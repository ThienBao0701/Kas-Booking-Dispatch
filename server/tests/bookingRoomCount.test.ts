import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

function parse(text: string): ParsedBooking {
  return parseBooking(text, branches);
}
function codes(r: ParsedBooking): string[] {
  return r.warnings.map((w) => w.code);
}

const HEAD = `Saigon Hotel & Ben Thanh
Mã đặt phòng: 1029384756
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-20`;

describe('authoritative room count', () => {
  it('1. "Tổng số căn" = 1 wins over total guests = 2', () => {
    const r = parse(`${HEAD}
Tổng số khách
2 người lớn
Tổng số căn
1
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND`);
    expect(r.rooms).toHaveLength(1);
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('2. "Tổng số căn" = 1 wins over maximum occupancy = 2', () => {
    const r = parse(`${HEAD}
Sức chứa tối đa
2 người
Tổng số căn
1
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND`);
    expect(r.rooms).toHaveLength(1);
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('3. a repeated room heading in the policy section does not create a second room', () => {
    const r = parse(`${HEAD}
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND
Chính sách phòng
Phòng Tiêu Chuẩn Giường Đôi
Hủy đặt phòng
Trả trước
Internet
Trẻ em
Đỗ xe
Vật nuôi`);
    expect(r.rooms).toHaveLength(1);
  });

  it('4. "Tổng số căn" = 2 with one quantity-based section expands to two rooms (prices left null)', () => {
    const r = parse(`${HEAD}
Tổng số căn
2
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND`);
    expect(r.rooms).toHaveLength(2);
    // Never divide or duplicate the single price — both rooms' nights stay null.
    expect(r.rooms.every((room) => room.nights.every((n) => n.amount === null))).toBe(true);
    expect(codes(r)).toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
    // Count matches the expansion, so no mismatch is raised.
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('5. "Total rooms" = 2 with two separate sections preserves both, no warning', () => {
    const r = parse(`${HEAD}
Total rooms
2
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND
Phòng Gia Đình
2026-07-19: 900.000 VND`);
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((room) => room.nights[0]!.amount)).toEqual([700_000, 900_000]);
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('6. an authoritative count that conflicts with explicit sections emits ROOM_COUNT_MISMATCH', () => {
    const r = parse(`${HEAD}
Tổng số phòng
1
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND
Phòng Gia Đình
2026-07-19: 900.000 VND`);
    // Explicit rooms are preserved (never merged/deleted); the conflict is flagged.
    expect(r.rooms).toHaveLength(2);
    expect(codes(r)).toContain('ROOM_COUNT_MISMATCH');
  });

  it('7. a guest count is never used as the room count', () => {
    const r = parse(`${HEAD}
2 người lớn, 1 trẻ em
Tổng số căn
1
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND`);
    expect(r.rooms).toHaveLength(1);
  });

  it('8. a night count is never used as the room count', () => {
    const r = parse(`Saigon Hotel & Ben Thanh
Mã đặt phòng: 1029384756
Khách: Test Guest
Nhận phòng: 2026-07-19
Trả phòng: 2026-07-22
Tổng thời gian lưu trú: 3 đêm
Tổng số căn
1
Phòng Tiêu Chuẩn Giường Đôi
2026-07-19: 700.000 VND
2026-07-20: 700.000 VND
2026-07-21: 700.000 VND`);
    expect(r.rooms).toHaveLength(1);
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
  });

  it('9. the real Booking.com extranet sample still yields exactly one room', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'booking', '24-real-sample-extranet.txt'),
      'utf8',
    );
    const r = parse(raw);
    expect(r.rooms).toHaveLength(1);
    expect(codes(r)).not.toContain('ROOM_COUNT_MISMATCH');
    expect(r.warnings).toEqual([]);
  });
});
