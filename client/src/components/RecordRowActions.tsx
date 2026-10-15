/**
 * The shared "Sửa" / "Hủy" pair of a reception record row.
 *
 * Edit is visually secondary and void is destructive-but-quiet: neither should
 * compete with "Thêm", which is the action being used forty times a shift. One
 * component so the guest-request, complaint, room-service and delivery tables
 * cannot drift into four slightly different pairs.
 */
import { Pencil, Trash2 } from 'lucide-react';
import type { OperationalReport } from '../api/receptionReports';
import { RowAction } from './DataTable';
import { useAuth } from '../auth/AuthProvider';
import { mayVoidRecord } from '../lib/deskVoid';

export function Actions({
  row,
  canEdit,
  onEdit,
  onVoid,
}: {
  row: OperationalReport;
  canEdit: boolean;
  onEdit: () => void;
  onVoid: () => void;
}) {
  const { user } = useAuth();
  if (!canEdit || row.voided) return <span className="text-xs text-slate-300">—</span>;
  return (
    <>
      <RowAction onClick={onEdit} testId={`edit-${row.id}`}>
        <Pencil className="h-3 w-3" aria-hidden="true" />
        Sửa
      </RowAction>
      {/* The desk withdraws only its own entry of the shift still running. */}
      {mayVoidRecord(row, user) ? (
        <RowAction onClick={onVoid} tone="danger" testId={`void-${row.id}`}>
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          Hủy
        </RowAction>
      ) : null}
    </>
  );
}
