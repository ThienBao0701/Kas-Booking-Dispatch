/**
 * Turning OTA room LINES into PHYSICAL ROOMS.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────
 * An OTA reservation is stated as lines — "SUP × 3" is one line with a
 * quantity — while `BookingRoom` has no quantity column and represents ONE
 * physical room. Persisting the line as a single row lost the count, and the
 * nightly figures (which cover the whole reservation) ended up under that one
 * row, so a three-room booking rendered as one room priced for three.
 *
 * Booking.com's parser already expands quantity into one room per physical
 * room. This makes the OTA path produce the SAME canonical shape, so nothing
 * downstream — the room cards, "Sao chép giá", the room count — needs to know
 * which platform a booking came from.
 *
 * ── WHAT A PER-ROOM AMOUNT HERE DOES AND DOES NOT MEAN ────────────────────
 * Agoda and CTrip state ONE nightly figure for the whole reservation. When the
 * reservation has a single room type, dividing it by the quantity is the real
 * per-room price. When it has SEVERAL types, it is not: the platform never said
 * how a night splits between a Superior and a Deluxe, and no ratio is invented
 * here. The even split is an ALLOCATION OF THE AGGREGATE, chosen because it is
 * the only division that adds up without fabricating a price relationship.
 *
 * The one guarantee, in both cases:
 *
 *     sum(per-room amounts for a night) === the OTA's aggregate for that night
 *
 * Pure and total: no database, no clock, no platform branching. Every rule here
 * is exercised directly in `otaRoomAllocation.test.ts`.
 */

/** One line as the review states it: a room type and how many of them. */
export interface OtaRoomLine {
  quantity: number;
  pmsCode: string | null;
  otaRoomName: string | null;
}

/** One night as the platform stated it, covering the whole reservation. */
export interface AggregateNight {
  stayDate: string;
  amount: number | null;
  isEstimated: boolean;
}

export interface AllocatedNight {
  stayDate: string;
  /** This room's share. Null when the platform stated no figure for the night. */
  amount: number | null;
  isEstimated: boolean;
}

export interface AllocatedRoom {
  roomIndex: number;
  roomType: string;
  /** Sum of this room's nightly shares; null when no night carried a figure. */
  roomSubtotal: number | null;
  nights: AllocatedNight[];
}

/**
 * Splits one whole-reservation amount across `roomCount` rooms, exactly.
 *
 * Largest-remainder, with the remainder going to the earliest rooms. Integer
 * đồng throughout — `Math.floor` then hand out what is left one at a time —
 * because the alternative, rounding each share independently, does not add up:
 * 1.000.000 across three rooms rounds to 333.333 three times and loses a đồng.
 *
 * Deterministic on purpose: the same booking allocates the same way on every
 * dispatch, so a re-read never shows different figures than the write.
 */
export function splitAmount(amount: number, roomCount: number): number[] {
  if (roomCount <= 0) return [];
  const base = Math.floor(amount / roomCount);
  const remainder = amount - base * roomCount;
  return Array.from({ length: roomCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Expands review lines into physical rooms and allocates the nightly aggregate.
 *
 * Rooms come out in line order — every SUP before every DLX — and are numbered
 * from 1, so `roomIndex` stays the stable, human-facing "PHÒNG n".
 *
 * A line with a missing or nonsensical quantity still yields one room: a
 * reservation that lost its count is worth strictly more than a reservation
 * that lost its room.
 */
export function allocatePhysicalRooms(
  lines: readonly OtaRoomLine[],
  nights: readonly AggregateNight[],
): AllocatedRoom[] {
  const types: string[] = [];
  for (const line of lines) {
    const count =
      Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1;
    const roomType = line.pmsCode ?? line.otaRoomName ?? '';
    for (let i = 0; i < count; i += 1) types.push(roomType);
  }
  if (types.length === 0) return [];

  // One split per night, reused across rooms — the shares of a single night
  // must come from one division or they cannot be guaranteed to add up.
  const perNight = nights.map((night) => ({
    night,
    shares: night.amount === null ? null : splitAmount(night.amount, types.length),
  }));

  return types.map((roomType, roomIdx) => {
    const roomNights: AllocatedNight[] = perNight.map(({ night, shares }) => ({
      stayDate: night.stayDate,
      amount: shares === null ? null : shares[roomIdx]!,
      isEstimated: night.isEstimated,
    }));

    const stated = roomNights.filter((n) => n.amount !== null);
    return {
      roomIndex: roomIdx + 1,
      roomType,
      roomSubtotal:
        stated.length === 0 ? null : stated.reduce((sum, n) => sum + (n.amount ?? 0), 0),
      nights: roomNights,
    };
  });
}
