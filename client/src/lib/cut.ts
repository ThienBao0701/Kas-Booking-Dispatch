/**
 * CẮT — the receptionist lifting one value off an order.
 *
 * WHAT THE WORD MEANS HERE. "Cắt" is cut in the editing sense — COPY THEN
 * REMOVE, exactly like Ctrl+X. The value goes to the Windows clipboard and then
 * stops being displayed to the receptionist who took it, because a field still
 * on screen is a field that still looks like outstanding work, and this whole
 * feature exists so two people never do the same work twice.
 *
 * THE ORDER IS NOT NEGOTIABLE: clipboard first, hide second. A receptionist who
 * loses the value from the screen without gaining it in the clipboard cannot
 * create the reservation at all, and cannot get it back — the field is hidden
 * for the rest of the claim cycle. So a failed clipboard write aborts the whole
 * CẮT: nothing is hidden, and no claim is started.
 *
 * WHAT IT IS NOT. Nothing is deleted. The guest's name, the amount and the note
 * stay on the Booking row and stay fully visible to Admin. CẮT decides what
 * reception is shown; it never decides what the booking contains.
 *
 * Plain values and types live here rather than in a component file so Fast
 * Refresh keeps its boundary and tests can assert the real strings.
 */
import type { CutField } from '../api/bookings';

/** The button text on all three controls. */
export const CUT_LABEL = 'CẮT';

/** Shown in place of a value the receptionist has already taken. */
export const CUT_PLACEHOLDER = 'Thông tin đã được CẮT';

/**
 * Shown when the browser refused the clipboard write.
 *
 * It says plainly that nothing was taken, because the screen looks identical to
 * before and a receptionist needs to know whether to paste or to press again.
 */
export const CUT_CLIPBOARD_FAILED =
  'Không sao chép được vào clipboard. Chưa CẮT thông tin này — vui lòng thử lại.';

/** Accessible names, so a screen reader says which value is being taken. */
export const CUT_FIELD_LABELS: Record<CutField, string> = {
  CUSTOMER_NAME: 'tên khách hàng',
  TOTAL_AMOUNT: 'tổng tiền',
  PMS_NOTE: 'PMS Note',
};

/**
 * Everything the three controls need, produced once per booking.
 *
 * Passed down as one object rather than six props so a screen that has no claim
 * concept (every Admin screen, and every list that is not a dispatch queue)
 * simply passes nothing and keeps its existing copy buttons untouched.
 */
export interface CutController {
  /** True once this field has been taken in the current cycle. */
  isCut: (field: CutField) => boolean;
  /**
   * Take the field: copy `value` to the system clipboard, then hide it.
   *
   * The value is passed in by the control that owns it rather than looked up
   * here, so what lands in the clipboard is exactly the string the receptionist
   * was looking at — including the PMS note's line breaks.
   *
   * The first successful call also claims the order and starts the timer.
   */
  cut: (field: CutField, value: string) => void;
  /** The field currently in flight, so only its own button shows a pending state. */
  pending: CutField | null;
  /** Server refusal, already turned into a sentence. */
  error: string | null;
  /**
   * Whether the CURRENT user holds the live claim — i.e. whether to show them a
   * countdown.
   *
   * Resolved here rather than inside the detail view so that view needs no auth
   * context of its own. It is rendered standalone all over the test suite and by
   * screens that have no claim concept, and making it depend on an AuthProvider
   * would be a new requirement on every one of them.
   */
  claimIsMine: boolean;
}
