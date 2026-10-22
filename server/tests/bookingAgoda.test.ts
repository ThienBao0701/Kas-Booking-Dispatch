import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { parseAgodaBooking, AGODA_PARSER_VERSION } from '../src/booking/agoda';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'agoda');

function load(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}
function parse(name: string): ParsedBooking {
  return parseAgodaBooking(load(name), branches);
}

/**
 * The Agoda adapter reuses the shared extraction engine and must return the exact
 * same normalized structure as Booking.com — only the Agoda-specific labels,
 * prepaid phrases, "VND 1,050,000" money format and the parser-version stamp
 * differ. Each fixture is anonymized text shaped like an Agoda confirmation page.
 */
describe('Agoda raw-text parser adapter', () => {
  it('01 — one room, one night, fully prepaid', () => {
    const r = parse('01-en-one-room-prepaid.txt');
    expect(r.suggestedBranch?.address).toBe('260 Lý Tự Trọng');
    expect(r.branchConfident).toBe(true);
    expect(r.guestName).toBe('Nguyen Van An');
    expect(r.bookingCode).toBe('895647312');
    expect(r.checkIn).toBe('2026-07-10');
    expect(r.checkOut).toBe('2026-07-11');
    expect(r.totalAmount).toBe(920_000);
    expect(r.currency).toBe('VND');
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Superior Double Room');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([920_000]);
    expect(r.parserVersion).toBe(AGODA_PARSER_VERSION);
    expect(r.warnings).toEqual([]);
  });

  it('02 — one room, three nights with a price step-up, prepaid via policy', () => {
    const r = parse('02-en-multi-night.txt');
    expect(r.suggestedBranch?.address).toBe('170-172-174 Nguyễn Thái Bình');
    expect(r.guestName).toBe('Tran Thi Bich');
    expect(r.bookingCode).toBe('761203948');
    expect(r.checkIn).toBe('2026-07-13');
    expect(r.checkOut).toBe('2026-07-16');
    const room = r.rooms[0]!;
    expect(room.roomName).toBe('Deluxe King Room');
    expect(room.nights.map((n) => n.stayDate)).toEqual(['2026-07-13', '2026-07-14', '2026-07-15']);
    expect(room.nights.map((n) => n.amount)).toEqual([1_050_000, 1_050_000, 1_150_000]);
    expect(r.totalAmount).toBe(3_250_000);
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.warnings).toEqual([]);
  });

  it('03 — two rooms via "Rooms booked", prepaid', () => {
    const r = parse('03-en-two-rooms.txt');
    expect(r.suggestedBranch?.address).toBe('278 Lê Thánh Tôn');
    expect(r.bookingCode).toBe('548812097');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.every((rm) => rm.roomName === 'Superior Twin Room')).toBe(true);
    expect(r.totalAmount).toBe(1_560_000);
    expect(r.paymentStatus).toBe('PAY_BEFORE');
  });

  it('04 — pay at the property (no prepaid signal) resolves to PAY_AFTER', () => {
    const r = parse('04-en-pay-at-hotel.txt');
    expect(r.suggestedBranch?.address).toBe('191 Lê Thánh Tôn');
    expect(r.guestName).toBe('Le Minh Chau');
    expect(r.bookingCode).toBe('330945172');
    expect(r.totalAmount).toBe(640_000);
    expect(r.paymentStatus).toBe('PAY_AFTER');
    expect(r.rooms[0]!.roomName).toBe('Standard Double Room');
  });

  it('stamps the Agoda parser version, never the Booking.com one', () => {
    const r = parse('01-en-one-room-prepaid.txt');
    expect(r.parserVersion).toBe(AGODA_PARSER_VERSION);
    expect(r.parserVersion).not.toBe(parseBooking(load('01-en-one-room-prepaid.txt'), branches).parserVersion);
  });
});
