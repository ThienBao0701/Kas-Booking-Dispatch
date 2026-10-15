import fs from 'node:fs';
import { fixtureBranches } from './helpers/branchFixtures';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import type { ParsedBooking } from '../src/booking/types';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'booking');

/** Fixtures that may only ever SUGGEST a branch, never auto-assign one. */
/**
 * Fixtures whose hotel line the resolver still cannot assign on its own.
 *
 * Since the 5.1 hotfix this is ONE file. The three real extranet samples used
 * to sit here too: their hotel line is the internal name with the property id
 * glued on, which now resolves by containment. 09 stays because its name is
 * genuinely truncated mid-word — a fragment that half-spells a property is
 * exactly what should reach an operator rather than be guessed.
 */
const NON_EXACT_HOTEL_FIXTURES = new Set(['09-hotel-name-truncated.txt']);

function load(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function parse(name: string): ParsedBooking {
  return parseBooking(load(name), branches);
}

function codes(result: ParsedBooking): string[] {
  return result.warnings.map((w) => w.code);
}

/**
 * Regression suite over realistic, anonymized raw text copied from Booking.com
 * reservation-detail pages (navigation chrome, weekday dates, values on the next
 * line, duplicated labels, policy text). Every fixture is asserted end to end.
 */
describe('raw Booking.com fixtures', () => {
  it('01 — Vietnamese, one room, one night', () => {
    const r = parse('01-vi-one-room-one-night.txt');
    expect(r.suggestedBranch?.address).toBe('05 Trương Định');
    expect(r.branchConfident).toBe(true);
    expect(r.guestName).toBe('Lê Thị Hoa');
    expect(r.phone).toBe('0905112233');
    expect(r.bookingCode).toBe('1029384756');
    expect(r.checkIn).toBe('2026-07-10');
    expect(r.checkOut).toBe('2026-07-11');
    expect(r.totalAmount).toBe(780_000);
    expect(r.paymentStatus).toBe('PAY_AFTER');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.roomName).toBe('Deluxe Double Room');
    expect(r.rooms[0]!.nights.map((n) => n.stayDate)).toEqual(['2026-07-10']);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([780_000]);
    expect(r.warnings).toEqual([]);
  });

  it('02 — one room, multiple nights with different prices', () => {
    const r = parse('02-vi-one-room-multi-night.txt');
    expect(r.bookingCode).toBe('2048571639');
    expect(r.checkIn).toBe('2026-07-12');
    expect(r.checkOut).toBe('2026-07-15');
    const room = r.rooms[0]!;
    expect(room.nights.map((n) => n.stayDate)).toEqual([
      '2026-07-12', '2026-07-13', '2026-07-14',
    ]);
    // Different prices across nights are preserved, never averaged.
    expect(room.nights.map((n) => n.amount)).toEqual([820_000, 820_000, 990_000]);
    expect(room.roomTotal).toBe(2_630_000);
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.warnings).toEqual([]);
  });

  it('03 — two rooms of the same type stay separate', () => {
    const r = parse('03-vi-two-rooms-same-type.txt');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((x) => x.roomName)).toEqual(['Deluxe Double Room', 'Deluxe Double Room']);
    // Same name, but two independent rooms with their own night arrays.
    expect(r.rooms[0]!.nights).not.toBe(r.rooms[1]!.nights);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([700_000, 700_000]);
    expect(r.rooms[1]!.nights.map((n) => n.amount)).toEqual([700_000, 700_000]);
    expect(r.warnings).toEqual([]);
  });

  it('04 — two rooms of different types', () => {
    const r = parse('04-vi-two-rooms-diff-type.txt');
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms[0]!.roomName).toBe('Superior Twin Room');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([760_000, 760_000]);
    expect(r.rooms[1]!.roomName).toBe('Deluxe King Room');
    expect(r.rooms[1]!.nights.map((n) => n.amount)).toEqual([1_050_000, 1_050_000]);
    expect(r.rooms[0]!.roomTotal).toBe(1_520_000);
    expect(r.rooms[1]!.roomTotal).toBe(2_100_000);
    expect(r.warnings).toEqual([]);
  });

  it('05 — English labels', () => {
    const r = parse('05-en-labels.txt');
    expect(r.suggestedBranch?.address).toBe('13 Bùi Thị Xuân');
    expect(r.guestName).toBe('John A. Smith');
    expect(r.phone).toBe('+84 909 556 677');
    expect(r.bookingCode).toBe('5590182734');
    expect(r.checkIn).toBe('2026-08-03');
    expect(r.checkOut).toBe('2026-08-05');
    expect(r.totalAmount).toBe(1_800_000);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([900_000, 900_000]);
    expect(r.warnings).toEqual([]);
  });

  it('06 — phone hidden / unavailable resolves to null', () => {
    const r = parse('06-phone-hidden.txt');
    expect(r.phone).toBeNull();
    expect(r.bookingCode).toBe('6612093847');
    expect(r.fieldConfidence.phone).toBe('MISSING');
    // A missing phone is not an error — the rest still extracts cleanly.
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_150_000]);
  });

  it('07 — PAY_BEFORE trigger present', () => {
    const r = parse('07-pay-before-trigger.txt');
    expect(r.paymentStatus).toBe('PAY_BEFORE');
    expect(r.paymentStatusKnown).toBe(true);
    // The dated cancellation deadline must not become a nightly price.
    expect(r.rooms[0]!.nights).toHaveLength(1);
    expect(r.rooms[0]!.nights[0]!.amount).toBe(860_000);
  });

  it('08 — PAY_AFTER when the trigger is absent', () => {
    const r = parse('08-pay-after-no-trigger.txt');
    expect(r.paymentStatus).toBe('PAY_AFTER');
    expect(r.paymentStatusKnown).toBe(true);
  });

  it('09 — a truncated hotel name is SUGGESTED only and blocks automatic assignment', () => {
    // 'Luxury Elegance Hotel Ben Tha' is neither the branch's current Booking.com
    // identity nor its internal name. A high similarity score is still reported,
    // and the branch is still offered — but it is never assigned automatically,
    // so an Admin has to confirm before the booking can be dispatched.
    const r = parse('09-hotel-name-truncated.txt');
    expect(r.suggestedBranch?.address).toBe('260 Lý Tự Trọng');
    expect(r.branchMatchScore).toBeGreaterThanOrEqual(0.85);
    expect(r.branchConfident).toBe(false);
    expect(r.requiresManualConfirmation).toBe(true);
    expect(codes(r)).toContain('LOW_BRANCH_CONFIDENCE');
  });

  it('10 — duplicated navigation/policy text does not change values', () => {
    const r = parse('10-duplicated-nav-policy.txt');
    expect(r.suggestedBranch?.address).toBe('40-42 Bùi Thị Xuân');
    expect(r.guestName).toBe('Lý Gia Huy');
    expect(r.bookingCode).toBe('1122334455');
    expect(r.checkIn).toBe('2026-08-17');
    expect(r.checkOut).toBe('2026-08-19');
    expect(r.totalAmount).toBe(1_960_000);
    // Two nights at 980k; the 980k cancellation fee in the policy is excluded.
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([980_000, 980_000]);
    // Duplicated labels agree, so no conflict warning is raised.
    expect(codes(r)).not.toContain('DUPLICATED_LABEL_CONFLICT');
    expect(r.warnings).toEqual([]);
  });

  it('11 — a missing nightly price stays null and is flagged', () => {
    const r = parse('11-missing-one-nightly-price.txt');
    const room = r.rooms[0]!;
    expect(room.nights.map((n) => n.stayDate)).toEqual([
      '2026-08-21', '2026-08-22', '2026-08-23',
    ]);
    expect(room.nights.map((n) => n.amount)).toEqual([900_000, null, 900_000]);
    expect(room.roomTotal).toBeNull();
    expect(codes(r)).toContain('MISSING_NIGHTLY_PRICE');
    // The booking total is still read from its label, never divided by nights.
    expect(r.totalAmount).toBe(2_700_000);
  });

  it('12 — nightly prices and booking total both present, crossed-out ignored', () => {
    const r = parse('12-nightly-and-total.txt');
    // "Giá gốc" (original, crossed-out) must not become the total.
    expect(r.totalAmount).toBe(2_000_000);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_000_000, 1_000_000]);
    expect(r.rooms[0]!.roomTotal).toBe(2_000_000);
    expect(codes(r)).not.toContain('AMBIGUOUS_TOTAL');
  });

  it('13 — taxes and fees are not mistaken for nightly prices', () => {
    const r = parse('13-taxes-and-fees-separate.txt');
    // Nightly amounts are the room rate only; tax (200k) is not a night.
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_000_000, 1_000_000]);
    expect(r.rooms[0]!.roomTotal).toBe(2_000_000);
    // The booking total includes tax and comes from its own label.
    expect(r.totalAmount).toBe(2_200_000);
  });

  it('14 — Vietnamese weekday date text parses correctly', () => {
    const r = parse('14-vietnamese-weekday-dates.txt');
    expect(r.checkIn).toBe('2026-08-27');
    expect(r.checkOut).toBe('2026-08-29');
    expect(r.rooms[0]!.nights.map((n) => n.stayDate)).toEqual(['2026-08-27', '2026-08-28']);
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_080_000, 1_080_000]);
  });

  it('15 — the booking code is found among unrelated numbers', () => {
    const r = parse('15-booking-code-among-numbers.txt');
    // Not the rating (8.9), review count (1250), room no. (402), PIN (2049),
    // year (2026) or phone (0912888777).
    expect(r.bookingCode).toBe('8817263540');
    expect(r.checkIn).toBe('2026-08-31');
    expect(r.checkOut).toBe('2026-09-02');
    expect(r.phone).toBe('0912888777');
    expect(r.rooms[0]!.nights.map((n) => n.amount)).toEqual([1_100_000, 1_100_000]);
  });

  it('every fixture yields a confident branch and never invents nightly money', () => {
    const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();
    expect(files.length).toBeGreaterThanOrEqual(23);
    for (const file of files) {
      const r = parse(file);
      // Every fixture still resolves to A branch candidate. Only an EXACT
      // identity / internal-name match may be assigned automatically, so the
      // truncated fixture is deliberately the one that requires confirmation.
      expect(r.suggestedBranch, file).not.toBeNull();
      // Fixtures whose hotel line is neither the branch's CURRENT platform
      // identity nor its internal name: a truncated name, plus the real extranet
      // samples that glue the property id onto the name.
      const needsConfirmation = NON_EXACT_HOTEL_FIXTURES.has(file);
      expect(r.branchConfident, file).toBe(!needsConfirmation);
      expect(r.requiresManualConfirmation, file).toBe(needsConfirmation);
      // Check-out is always excluded from the generated nights.
      for (const room of r.rooms) {
        for (const night of room.nights) {
          expect(night.stayDate < r.checkOut!, `${file} ${night.stayDate}`).toBe(true);
          expect(night.stayDate >= r.checkIn!, `${file} ${night.stayDate}`).toBe(true);
          // The engine never estimates money.
          expect(night.isEstimated).toBe(false);
        }
      }
    }
  });
});
