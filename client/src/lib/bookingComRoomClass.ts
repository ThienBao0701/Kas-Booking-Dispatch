/**
 * The dispatch precondition for a Booking.com booking's room classes.
 *
 * Kept out of the component file so both the review card and the dispatch page
 * can use it without either importing the other's rendering.
 */
/**
 * Deliberately structural rather than `RoomView`: an unsent Booking.com review
 * has no booking, so its rooms carry no row id. The rule is about the code, and
 * `RoomView` still satisfies it.
 */
export interface MappableRoom {
  roomClassPmsCode?: string | null;
}

export const UNMAPPED_ROOM_MESSAGE =
  'Vui lòng chọn mã nội bộ cho tất cả hạng phòng trước khi gửi.';

/**
 * True when every room carries an internal PMS code.
 *
 * This is the condition the note depends on: `buildPmsNote` reads each room's
 * `roomClassPmsCode`, and a room without one silently falls back to the legacy
 * keyword abbreviation — a plausible-looking code that is not the branch's.
 * A booking with no rooms at all is not dispatchable either.
 */
export function everyRoomHasPmsCode(rooms: readonly MappableRoom[]): boolean {
  return rooms.length > 0 && rooms.every((r) => (r.roomClassPmsCode ?? '').trim().length > 0);
}
