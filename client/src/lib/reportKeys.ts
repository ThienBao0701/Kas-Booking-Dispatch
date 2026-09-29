/**
 * React Query keys for "Báo cáo vấn đề".
 *
 * IN THEIR OWN MODULE so that the components which use them stay
 * component-only files — a file that exports both a component and a constant
 * loses Fast Refresh for the whole module, which in practice means losing the
 * form state you had just typed in every time you edit the component.
 *
 * THE TWO ARE INVALIDATED TOGETHER. Every write that changes a payment row also
 * changes the drawer, and forgetting the second is how a screen ends up showing
 * a new row above a stale "Tiền cuối ca" — the exact discrepancy this feature
 * exists to make explainable.
 */
export const REPORTS_KEY = ['reception', 'reports'];
export const CASH_KEY = ['reception', 'reports', 'cash'];
/**
 * "Giao nhận hàng hóa" as the delivery lists read it (`/hotel-deliveries`) — the
 * branch-wide active/archived split, NOT the shift-scoped journal. A delivery
 * written through the journal moves this too, so a write invalidates both.
 */
export const DELIVERIES_KEY = ['reception', 'deliveries'];

/**
 * II and IV across shifts, and "Hoàn thành vấn đề" — both UNDER `REPORTS_KEY`,
 * so every write that refreshes the journal refreshes them with it.
 */
export const ACTIVE_REPORTS_KEY = ['reception', 'reports', 'active'];
export const ARCHIVED_REPORTS_KEY = ['reception', 'reports', 'archive'];

/** The facility board's and the archive's own reads of the incidents (III). */
export const FACILITY_BOARD_KEY = ['reception', 'facility-board'];
