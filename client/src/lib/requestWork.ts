/**
 * WHO WORKS A GUEST REQUEST, on screen — the server decides again on every action.
 *
 *   "Người xử lý" set     only that person completes it ("Hoàn thành"), and
 *                         only that person presses "Nhận việc"
 *   nobody set            the rule older requests always had: the department
 *                         whose journal it is
 */
import type { AuthUser, UserRole } from '../auth/types';
import type { OperationalReport } from '../api/receptionReports';
import { isForeignRecord } from './deskVoid';

/** Who gives a request out: the Admin, the reception managers, a Quản lý buồng phòng. */
export const REQUEST_ASSIGNER_ROLES: readonly UserRole[] = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'HOUSEKEEPING_MANAGER'];

/** A record of another department's journal, from where the viewer stands: followed, not worked. */
export function outsideViewerJournal(row: Pick<OperationalReport, 'originDepartment'>, user: Pick<AuthUser, 'role'> | null | undefined): boolean {
  if (isForeignRecord(row, user)) return true;
  const role = user?.role;
  return row.originDepartment !== 'HOUSEKEEPING' && (role === 'HOUSEKEEPING' || role === 'HOUSEKEEPING_MANAGER' || role === 'BELL');
}

export function mayCompleteRequest(
  row: Pick<OperationalReport, 'originDepartment' | 'voided' | 'guestRequest'>,
  user: Pick<AuthUser, 'id' | 'role'> | null | undefined,
): boolean {
  const request = row.guestRequest;
  if (!user || !request || request.completed || row.voided) return false;
  if (request.assignee) return request.assignee.id === user.id;
  return !outsideViewerJournal(row, user);
}

/** "Nhận việc": the assignee, once, while open. */
export function mayAcknowledgeRequest(row: Pick<OperationalReport, 'voided' | 'guestRequest'>, user: Pick<AuthUser, 'id'> | null | undefined): boolean {
  const request = row.guestRequest;
  return !!user && !!request && !row.voided && !request.completed && request.assignee?.id === user.id && !request.acknowledgedAt;
}
