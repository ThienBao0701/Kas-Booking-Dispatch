/**
 * MAY THIS SCREEN OFFER "HỦY" ON THIS RECORD? — the server's rule, mirrored for
 * display only (`voidReport` decides).
 *
 * A supervisor ("Xóa", 'reports.delete') may withdraw any live record of its
 * scope. The desk's "Hủy" is narrower: a record the receptionist entered ITSELF
 * on the shift it is still working — a mistake fixed before handover — never a
 * colleague's, a finished shift's, or a manager's late entry.
 */
import type { OperationalReport } from '../api/receptionReports';
import { can } from '../auth/capabilities';
import type { AuthUser } from '../auth/types';

export function mayVoidRecord(
  row: Pick<OperationalReport, 'voided' | 'createdBy' | 'shiftClosed' | 'shiftSessionId' | 'lateEntry'>,
  user: Pick<AuthUser, 'id' | 'role'> | null | undefined,
): boolean {
  if (!user || row.voided) return false;
  if (can(user.role, 'reports.delete')) return true;
  return (
    can(user.role, 'reports.voidOwnShiftEntry') &&
    row.createdBy?.id === user.id &&
    row.shiftSessionId !== null &&
    !row.shiftClosed &&
    !row.lateEntry
  );
}
