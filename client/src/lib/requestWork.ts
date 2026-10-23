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

/** The staff roles that work requests of a department — and may take one from its pool, or give one to themselves. */
const DEPARTMENT_OF_STAFF: Partial<Record<UserRole, 'RECEPTION' | 'BELL' | 'HOUSEKEEPING'>> = {
  RECEPTIONIST: 'RECEPTION',
  BELL: 'BELL',
  HOUSEKEEPING: 'HOUSEKEEPING',
  HOUSEKEEPING_MANAGER: 'HOUSEKEEPING',
};

/** May offer "Tự nhận việc" — a department's own staff. */
export function maySelfClaim(user: Pick<AuthUser, 'role'> | null | undefined): boolean {
  return !!user && DEPARTMENT_OF_STAFF[user.role] !== undefined;
}

/** "Nhận việc" from the pool: nobody holds it, it is for the viewer's department (the server checks the shift). */
export function mayClaimRequest(row: Pick<OperationalReport, 'voided' | 'guestRequest'>, user: Pick<AuthUser, 'role'> | null | undefined): boolean {
  const request = row.guestRequest;
  if (!user || !request || row.voided || request.completed || request.assignee) return false;
  return !!request.receivingDepartment && DEPARTMENT_OF_STAFF[user.role] === request.receivingDepartment;
}

/**
 * "Bộ phận nhận việc" in "Sửa": while open; by whoever gives work out at any
 * time, by the record's correctors only while nobody (else) holds it.
 */
export function mayChangeDepartment(row: Pick<OperationalReport, 'voided' | 'guestRequest'>, user: Pick<AuthUser, 'id' | 'role'> | null | undefined): boolean {
  const request = row.guestRequest;
  if (!user || !request || row.voided || request.completed) return false;
  if (REQUEST_ASSIGNER_ROLES.includes(user.role)) return true;
  return !request.assignee || request.assignee.id === user.id;
}

/** The department a role belongs to, as the tables name it ("Lễ tân", "Buồng phòng", "Bell"…). */
export function departmentLabelOfRole(role: UserRole | null | undefined): string | null {
  switch (role) {
    case 'RECEPTIONIST':
    case 'RECEPTION_MANAGER':
    case 'RECEPTION_GENERAL_MANAGER':
      return 'Lễ tân';
    case 'HOUSEKEEPING':
    case 'HOUSEKEEPING_MANAGER':
      return 'Buồng phòng';
    case 'BELL':
      return 'Bell';
    case 'TECHNICAL':
    case 'TECHNICAL_MANAGER':
    case 'TECHNICAL_GENERAL_MANAGER':
      return 'Kỹ thuật';
    case 'ADMIN':
      return 'Admin';
    case 'BOOKING_DEPARTMENT':
      return 'Bộ phận đặt phòng';
    default:
      return null;
  }
}

/** "Nhận việc": the assignee, once, while open. */
export function mayAcknowledgeRequest(row: Pick<OperationalReport, 'voided' | 'guestRequest'>, user: Pick<AuthUser, 'id'> | null | undefined): boolean {
  const request = row.guestRequest;
  return !!user && !!request && !row.voided && !request.completed && request.assignee?.id === user.id && !request.acknowledgedAt;
}
