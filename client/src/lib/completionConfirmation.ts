/**
 * Who may press "Xác nhận hoàn thành" — for DISPLAY only. The server checks the
 * role, the branch, the state and the self-confirmation rule again.
 */
import type { Issue } from '../api/issues';
import { can } from '../auth/capabilities';
import type { UserRole } from '../auth/types';

export function mayConfirmCompletion(
  issue: Pick<Issue, 'status' | 'completedBy'>,
  role: UserRole | undefined,
  userId: number | undefined,
): boolean {
  return (
    issue.status === 'AWAITING_INSPECTION' &&
    can(role, 'technical.confirmCompletion') &&
    // Nobody signs off their own work.
    (issue.completedBy?.id ?? null) !== (userId ?? -1)
  );
}
