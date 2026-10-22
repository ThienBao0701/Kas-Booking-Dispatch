import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'booking');

function parse(name: string): ParsedBooking {
  return parseBooking(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'), branches);
}

function codes(r: ParsedBooking): string[] {
  return r.warnings.map((w) => w.code);
}

/**
 * Room quantity aggregation and Vietnamese room-type detection. Every physical
 * room from a quantity section must keep a distinct index, preserve its type
 * name, cover every stay date, and never receive a divided or copied ambiguous
 * price.
 */
describe('room quantity aggregation', () => {
  it('16 — "x2" with explicit per-room nightly prices copies to each room', () => {
    const r = parse('16-qty-x2-per-room-prices.txt');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((x) => x.roomIndex)).toEqual([1, 2]);
    expect(r.rooms.map((x) => x.roomName)).toEqual(['Deluxe Double Room', 'Deluxe Double Room']);
    // Explicit per-room price: each room fully priced, not estimated.
    for (const room of r.rooms) {
      expect(room.nights.map((n) => n.amount)).toEqual([900_000, 900_000]);
      expect(room.nights.every((n) => n.isEstimated === false)).toBe(true);
      expect(room.roomTotal).toBe(1_800_000);
    }
    expect(r.rooms[0]!.nights).not.toBe(r.rooms[1]!.nights);
    expect(r.totalAmount).toBe(3_600_000);
    expect(codes(r)).not.toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
  });

  it('17 — "2 phòng" with only a combined total keeps nightly amounts null', () => {
    const r = parse('17-qty-2phong-combined-total.txt');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((x) => x.roomIndex)).toEqual([1, 2]);
    // The combined total is NOT divided by two or duplicated into the rooms.
    for (const room of r.rooms) {
      expect(room.nights.every((n) => n.amount === null)).toBe(true);
      expect(room.roomTotal).toBeNull();
    }
    // The combined amount is preserved on the booking.
    expect(r.totalAmount).toBe(2_400_000);
    expect(codes(r)).toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
  });

  it('18 — a guest count near the room is not treated as room quantity', () => {
    const r = parse('18-qty-guest-count-not-rooms.txt');
    // "2 người lớn, 1 trẻ em" must not expand the booking into extra rooms.
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Deluxe Double Room');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([950_000, 950_000]);
    expect(codes(r)).not.toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
  });

  it('23 — an ambiguous quantity price stays null and is flagged', () => {
    const r = parse('23-qty-ambiguous-null-prices.txt');
    expect(r.rooms).toHaveLength(2);
    // Per-night list present but not marked per-room or combined: never guess.
    for (const room of r.rooms) {
      expect(room.nights.every((n) => n.amount === null)).toBe(true);
      expect(room.roomTotal).toBeNull();
    }
    expect(codes(r)).toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
    expect(codes(r)).toContain('AMBIGUOUS_NIGHTLY_PRICE');
    // The combined total is still preserved on the booking, undivided.
    expect(r.totalAmount).toBe(4_000_000);
  });

  it('expanded rooms cover every stay date and exclude check-out', () => {
    for (const file of ['16-qty-x2-per-room-prices.txt', '17-qty-2phong-combined-total.txt', '23-qty-ambiguous-null-prices.txt']) {
      const r = parse(file);
      expect(r.rooms.length).toBeGreaterThanOrEqual(2);
      for (const room of r.rooms) {
        const dates = room.nights.map((n) => n.stayDate);
        expect(dates).toEqual([r.checkIn, addDay(r.checkIn!)]);
        expect(dates).not.toContain(r.checkOut);
      }
    }
  });
});

describe('Vietnamese room-type detection', () => {
  it('19 — "Phòng Deluxe Giường Đôi" is detected with its accented name', () => {
    const r = parse('19-vi-room-deluxe.txt');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Phòng Deluxe Giường Đôi');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([880_000, 880_000]);
  });

  it('20 — "Phòng Superior 2 Giường Đơn": bed count is not a room quantity', () => {
    const r = parse('20-vi-room-twin.txt');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Phòng Superior 2 Giường Đơn');
    expect(r.rooms[0]!.roomTotal).toBe(1_520_000);
  });

  it('21 — two different Vietnamese room types stay separate', () => {
    const r = parse('21-vi-two-room-types.txt');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((x) => x.roomName)).toEqual(['Phòng Tiêu Chuẩn', 'Phòng Gia Đình']);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([650_000, 650_000]);
    expect(r.rooms[1]!.nights.map((n) => n.amount)).toEqual([1_250_000, 1_250_000]);
    expect(r.rooms[0]!.roomTotal).toBe(1_300_000);
    expect(r.rooms[1]!.roomTotal).toBe(2_500_000);
  });

  it('22 — a Vietnamese room name survives surrounding wrapped UI text', () => {
    const r = parse('22-vi-room-wrapped-text.txt');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Phòng Deluxe Nhìn Ra Thành Phố');
    // The wrapped cancellation line and breakfast note are not mistaken for
    // nights or a room quantity.
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_150_000, 1_150_000]);
    expect(codes(r)).not.toContain('AMBIGUOUS_ROOM_QUANTITY_PRICE');
  });
});

function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
