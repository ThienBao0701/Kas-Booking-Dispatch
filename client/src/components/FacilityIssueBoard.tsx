/**
 * "SỰ CỐ CƠ SỞ VẬT CHẤT ĐANG XỬ LÝ" — a MONITOR, not a second incident form.
 *
 * WHY THIS REPLACED A DROPDOWN
 *
 * The category used to ask the receptionist to pick an incident from a
 * `<select>` before showing anything — so the one question this screen exists to
 * answer, "what is broken right now and who has it?", was hidden behind an empty
 * form. This board answers it the moment the category opens.
 *
 * WHAT IT SHOWS: THE ACTIVE SET, decided by the server clock —
 * `issuesApi.list({ scope: 'active' })`. Every incident of the branch that is
 * still outstanding, however old, plus those finished within 12 hours of being
 * reported, so "Đã hoàn thành" is something the desk actually sees. Once a
 * finished incident is 12 hours past its report it is matched by "Hoàn thành
 * vấn đề" instead; nothing is moved or rewritten.
 *
 * NO SECOND INCIDENT SYSTEM. This renders `HotelIssue` rows through the same
 * `IssueStageBadge` / `IssueTimeline` the rest of the app uses; nothing here
 * stores a status, an area or a technician of its own.
 *
 * REPORTING A NEW FAULT HAPPENS HERE, through the SAME dialog the old standalone
 * "Báo cáo sự cố" screen used — `NewIssueModal`, in IncidentReporting — and the
 * incident is then recorded in this shift's journal in the same step.
 *
 * THE PER-ROW ACTIONS: "Chuyển về chờ giao" (assigned, not yet accepted) and
 * "Xóa" (a void; the record stays) — and "SỬA VẤN ĐỀ": correct what the report says while the
 * incident is still open. It runs through the same `EditIssueModal` field set as
 * the report form and the server keeps the old words, the report time, the status
 * and the whole repair history. Reception still operates no repair — accepting,
 * finishing and giving up a job remain the technical department's alone.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, Trash2, Undo2 } from 'lucide-react';
import { issuesApi, type Issue } from '../api/issues';
import { reportsApi } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { FACILITY_BOARD_KEY } from '../lib/reportKeys';
import { RowAction } from './DataTable';
import { EditIssueModal, IncidentTable, NewIssueModal } from './IncidentReporting';
import { MoreNote } from './MoreNote';
import { DeleteIssueDialog, UnassignIssueDialog } from './IssueManageDialogs';
import type { SectionFrame } from './ReportSection';

export function FacilityIssueBoard({
  onLogged,
  onToast,
  reportOpen,
  onCloseReport,
  title = 'Sự cố đang xử lý',
  summary = false,
  compact,
  section,
}: {
  onLogged: () => void | Promise<void>;
  onToast: (message: string) => void;
  /** "+ Báo cáo sự cố", owned by the category header above this board. */
  reportOpen: boolean;
  onCloseReport: () => void;
  title?: string;
  /** The overview's compact form: STT, Khu vực, Sự cố, Nguyên nhân, Trạng thái. */
  summary?: boolean;
  compact?: boolean;
  section?: SectionFrame;
}) {
  const issues = useQuery({
    queryKey: [...FACILITY_BOARD_KEY, 'active'],
    queryFn: () => issuesApi.list({ scope: 'active', pageSize: 100 }),
    // Technicians update these independently of anything on this screen, so a
    // receptionist watching this board should see a status change without
    // having to leave the tab.
    refetchInterval: 30_000,
  });

  const [editing, setEditing] = useState<Issue | null>(null);
  const [returning, setReturning] = useState<Issue | null>(null);
  const [deleting, setDeleting] = useState<Issue | null>(null);

  const logToJournal = useMutation({
    mutationFn: (issueId: string) =>
      reportsApi.create({ category: 'FACILITY_ISSUE', facility: { issueId } }),
    onSuccess: async () => {
      await onLogged();
      onToast('Đã gửi báo cáo sự cố cho bộ phận kỹ thuật.');
    },
    // The incident itself exists either way; only the journal entry is missing.
    onError: (e) =>
      onToast(`Đã gửi báo cáo sự cố, nhưng chưa ghi được vào nhật ký ca: ${toUserMessage(e)}`),
  });

  const rows = issues.data?.issues ?? [];

  return (
    <div>
      {reportOpen ? (
        <NewIssueModal
          onClose={onCloseReport}
          onCreated={(issue) => {
            // The board reads its own query, which `NewIssueModal` does not know
            // about — it invalidates `['issues']`. Refetch so the incident the
            // receptionist just reported is on screen before they look for it.
            void issues.refetch();
            logToJournal.mutate(issue.id);
          }}
        />
      ) : null}
      <IncidentTable
        testId="facility-board"
        title={title}
        rows={rows}
        receptionView
        summary={summary}
        compact={compact}
        section={section}
        isLoading={issues.isLoading}
        isError={issues.isError}
        error={issues.error}
        onRetry={() => void issues.refetch()}
        emptyTitle="Không có sự cố nào đang chờ xử lý"
        emptyMessage="Mọi sự cố cơ sở vật chất của chi nhánh đã được xử lý xong."
        actions={(issue) =>
          // A finished incident is a closed record: nothing left to correct.
          issue.status !== 'NEW' && issue.status !== 'IN_PROGRESS' ? (
            <span className="text-xs text-slate-300">—</span>
          ) : (
            <div className="flex flex-wrap justify-end gap-1.5">
              <RowAction onClick={() => setEditing(issue)} testId={`edit-issue-${issue.id}`}>
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Sửa vấn đề
              </RowAction>
              {/* Assigned but not taken up yet: back to "Chờ giao kỹ thuật". */}
              {issue.status === 'NEW' && issue.assignedTechnician ? (
                <RowAction onClick={() => setReturning(issue)} testId={`unassign-${issue.id}`}>
                  <Undo2 className="h-3 w-3" aria-hidden="true" />
                  Chuyển về chờ giao
                </RowAction>
              ) : null}
              <RowAction onClick={() => setDeleting(issue)} testId={`delete-issue-${issue.id}`}>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Xóa
              </RowAction>
            </div>
          )
        }
      />
      {editing ? (
        <EditIssueModal
          issue={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void issues.refetch();
            void onLogged();
            onToast('Đã lưu chỉnh sửa sự cố.');
          }}
        />
      ) : null}
      {returning ? (
        <UnassignIssueDialog
          issue={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            void issues.refetch();
            onToast('Đã chuyển sự cố về chờ giao kỹ thuật.');
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteIssueDialog
          issue={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            void issues.refetch();
            void onLogged();
            onToast('Đã xóa sự cố.');
          }}
        />
      ) : null}
      {/* A page of the newest 100: said so when there are more. */}
      <MoreNote shown={rows.length} total={issues.data?.pagination.total} />
    </div>
  );
}
