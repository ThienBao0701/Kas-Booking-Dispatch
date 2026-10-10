/**
 * Expanding OTA room lines into physical rooms, and dividing the nightly
 * aggregate across them.
 *
 * THE INVARIANT EVERY CASE CHECKS: the per-room shares of a night add up to
 * exactly the figure the platform stated. Rounding may never create or destroy
 * a đồng — an order whose room prices sum to one less than the total is an
 * order somebody has to reconcile by hand.
 *
 * Tested directly rather than through a dispatch, because the rule is pure
 * arithmetic and deserves assertions at the đồng rather than at the HTTP layer.
 */
import { describe, expect, it } from 'vitest';
import {
  allocatePhysicalRooms,
  splitAmount,
  type AggregateNight,
  type OtaRoomLine,
} from '../src/booking/otaRoomAllocation';

const line = (quantity: number, pmsCode: string): OtaRoomLine => ({
  quantity,
  pmsCode,
  otaRoomName: pmsCode,
});

const night = (stayDate: string, amount: number | null, isEstimated = false): AggregateNight => ({
  stayDate,
  amount,
  isEstimated,
});

/** Every night's shares must add back to the platform's own figure. */
function expectTotalsPreserved(
  rooms: ReturnType<typeof allocatePhysicalRooms>,
  nights: AggregateNight[],
): void {
  nights.forEach((n, nightIdx) => {
    if (n.amount === null) return;
    const summed = rooms.reduce((sum, room) => sum + (room.nights[nightIdx]!.amount ?? 0), 0);
    expect(summed, `night ${n.stayDate}`).toBe(n.amount);
  });
  const grand = nights.reduce((sum, n) => sum + (n.amount ?? 0), 0);
  const summedRooms = rooms.reduce((sum, room) => sum + (room.roomSubtotal ?? 0), 0);
  expect(summedRooms).toBe(grand);
}

/* ================================================================== */
/* splitAmount                                                         */
/* ================================================================== */

describe('splitAmount', () => {
  it('divides evenly when it can', () => {
    expect(splitAmount(2_243_112, 3)).toEqual([747_704, 747_704, 747_704]);
  });

  it('gives the remainder to the earliest rooms, never losing a đồng', () => {
    // The case that motivated this: 333.333 three times is 999.999.
    expect(splitAmount(1_000_000, 3)).toEqual([333_334, 333_333, 333_333]);
    expect(splitAmount(1_000_000, 3).reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it('is exact for every remainder from 0 to n-1', () => {
    for (let extra = 0; extra < 7; extra += 1) {
      const total = 700_000 + extra;
      const shares = splitAmount(total, 7);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(shares).toHaveLength(7);
    }
  });

  it('hands the whole amount to a single room', () => {
    expect(splitAmount(2_622_520, 1)).toEqual([2_622_520]);
  });

  it('is deterministic — the same input always splits the same way', () => {
    expect(splitAmount(1_000_000, 3)).toEqual(splitAmount(1_000_000, 3));
  });

  it('returns nothing when there are no rooms', () => {
    expect(splitAmount(100, 0)).toEqual([]);
  });
});

/* ================================================================== */
/* The reported case                                                   */
/* ================================================================== */

describe('D. three identical rooms over three nights — the reported bug', () => {
  const lines = [line(3, 'SUP')];
  const nights = [
    night('2026-08-13', 2_243_112),
    night('2026-08-14', 2_909_448),
    night('2026-08-15', 2_909_448),
  ];

  it('renders three rooms, not one', () => {
    const rooms = allocatePhysicalRooms(lines, nights);
    expect(rooms).toHaveLength(3);
    expect(rooms.map((r) => r.roomIndex)).toEqual([1, 2, 3]);
    expect(rooms.map((r) => r.roomType)).toEqual(['SUP', 'SUP', 'SUP']);
  });

  it('gives each room the exact per-room nightly figures', () => {
    const rooms = allocatePhysicalRooms(lines, nights);
    for (const room of rooms) {
      expect(room.nights.map((n) => n.amount)).toEqual([747_704, 969_816, 969_816]);
      expect(room.roomSubtotal).toBe(2_687_336);
    }
  });

  it('preserves the booking total exactly', () => {
    const rooms = allocatePhysicalRooms(lines, nights);
    expectTotalsPreserved(rooms, nights);
    expect(rooms.reduce((s, r) => s + (r.roomSubtotal ?? 0), 0)).toBe(8_062_008);
  });
});

/* ================================================================== */
/* The rest of the matrix                                              */
/* ================================================================== */

describe('room and night combinations', () => {
  it('A. one room, one night — unchanged from before', () => {
    const nights = [night('2026-08-13', 2_622_520)];
    const rooms = allocatePhysicalRooms([line(1, 'KING')], nights);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.roomType).toBe('KING');
    expect(rooms[0]!.nights.map((n) => n.amount)).toEqual([2_622_520]);
    expect(rooms[0]!.roomSubtotal).toBe(2_622_520);
    expectTotalsPreserved(rooms, nights);
  });

  it('B. one room, several nights — every night kept, nothing divided', () => {
    const nights = [night('2026-08-13', 1_000_000), night('2026-08-14', 1_100_000)];
    const rooms = allocatePhysicalRooms([line(1, 'DLX')], nights);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.nights.map((n) => n.amount)).toEqual([1_000_000, 1_100_000]);
    expect(rooms[0]!.roomSubtotal).toBe(2_100_000);
  });

  it('C. three identical rooms, one night', () => {
    const nights = [night('2026-08-13', 3_000_000)];
    const rooms = allocatePhysicalRooms([line(3, 'SUP')], nights);

    expect(rooms).toHaveLength(3);
    expect(rooms.every((r) => r.nights[0]!.amount === 1_000_000)).toBe(true);
    expectTotalsPreserved(rooms, nights);
  });

  it('E. several room types expand in line order, each keeping its own code', () => {
    const nights = [night('2026-08-13', 6_000_000)];
    const rooms = allocatePhysicalRooms(
      [line(3, 'SUP'), line(2, 'DLX'), line(1, 'KING')],
      nights,
    );

    expect(rooms).toHaveLength(6);
    expect(rooms.map((r) => r.roomType)).toEqual(['SUP', 'SUP', 'SUP', 'DLX', 'DLX', 'KING']);
    expect(rooms.map((r) => r.roomIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expectTotalsPreserved(rooms, nights);
  });

  it('E2. a mixed reservation is an ALLOCATION of the aggregate, not a type price', () => {
    /*
      Agoda and CTrip state one figure for the whole night. They never say how it
      splits between a Superior and a Deluxe, so no ratio is invented: the shares
      are equal, and the only claim made is that they add up. A DLX reading the
      same as a SUP here is the honest consequence of the source, not a guess
      about relative value.
    */
    const nights = [night('2026-08-13', 5_000_000)];
    const rooms = allocatePhysicalRooms([line(3, 'SUP'), line(2, 'DLX')], nights);

    expect(rooms.map((r) => r.nights[0]!.amount)).toEqual([
      1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000,
    ]);
    expectTotalsPreserved(rooms, nights);
  });

  it('F. a price that divides evenly leaves no remainder anywhere', () => {
    const nights = [night('2026-08-13', 900_000), night('2026-08-14', 1_200_000)];
    const rooms = allocatePhysicalRooms([line(3, 'SUP')], nights);

    expect(rooms.map((r) => r.roomSubtotal)).toEqual([700_000, 700_000, 700_000]);
    expectTotalsPreserved(rooms, nights);
  });

  it('G/H. a price that does NOT divide evenly still sums to the original', () => {
    const nights = [night('2026-08-13', 1_000_000), night('2026-08-14', 1_000_001)];
    const rooms = allocatePhysicalRooms([line(3, 'SUP')], nights);

    // Night one: 333.334 / 333.333 / 333.333. Night two: 333.334 / 333.334 / 333.333.
    expect(rooms[0]!.nights.map((n) => n.amount)).toEqual([333_334, 333_334]);
    expect(rooms[2]!.nights.map((n) => n.amount)).toEqual([333_333, 333_333]);
    expectTotalsPreserved(rooms, nights);
    expect(rooms.reduce((s, r) => s + (r.roomSubtotal ?? 0), 0)).toBe(2_000_001);
  });

  it('carries the estimated flag onto every room', () => {
    // CTrip nights derived from a bare total stay marked as estimates.
    const nights = [night('2026-08-13', 900_000, true)];
    const rooms = allocatePhysicalRooms([line(3, 'SUP')], nights);
    expect(rooms.every((r) => r.nights[0]!.isEstimated)).toBe(true);
  });

  it('keeps a night with no stated figure as null for every room', () => {
    const nights = [night('2026-08-13', null)];
    const rooms = allocatePhysicalRooms([line(2, 'SUP')], nights);

    expect(rooms.map((r) => r.nights[0]!.amount)).toEqual([null, null]);
    expect(rooms.map((r) => r.roomSubtotal)).toEqual([null, null]);
  });

  it('still yields a room when the quantity is missing or nonsensical', () => {
    // Losing the count is survivable; losing the room is not.
    for (const quantity of [0, -2, Number.NaN, 1.5]) {
      const rooms = allocatePhysicalRooms(
        [{ quantity, pmsCode: 'SUP', otaRoomName: 'Superior' }],
        [night('2026-08-13', 500_000)],
      );
      expect(rooms, `quantity=${quantity}`).toHaveLength(1);
      expect(rooms[0]!.nights[0]!.amount).toBe(500_000);
    }
  });

  it('falls back to the OTA name when no PMS code was resolved', () => {
    const rooms = allocatePhysicalRooms(
      [{ quantity: 2, pmsCode: null, otaRoomName: 'Superior Double' }],
      [night('2026-08-13', 400_000)],
    );
    expect(rooms.map((r) => r.roomType)).toEqual(['Superior Double', 'Superior Double']);
  });

  it('returns no rooms when there are no lines at all', () => {
    expect(allocatePhysicalRooms([], [night('2026-08-13', 100)])).toEqual([]);
  });

  it('handles a reservation with rooms but no nightly data', () => {
    const rooms = allocatePhysicalRooms([line(2, 'SUP')], []);
    expect(rooms).toHaveLength(2);
    expect(rooms.every((r) => r.nights.length === 0 && r.roomSubtotal === null)).toBe(true);
  });
});
