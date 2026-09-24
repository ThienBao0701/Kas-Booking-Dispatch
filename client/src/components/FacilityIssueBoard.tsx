/**
 * "SỰ CỐ VẬT CHẤT ĐANG XỬ LÝ" — a MONITOR, not a second incident form.
 *
 * WHY THIS REPLACED A DROPDOWN
 *
 * The category used to ask the receptionist to pick an incident from a
 * `<select>` before showing anything — so the one question this screen exists to
 * answer, "what is broken right now and who has it?", was hidden behind an empty
 * form. This board answers it the moment the category opens: it reads the SAME
 * `issuesApi.list({ outstanding: true })` the Technical queue and the Admin
 * monitor read, which is NEW + IN_PROGRESS regardless of when they were
 * reported — exactly "tồn đọng hiện tại", the existing semantics for "still
 * needs doing", not a rule invented for this screen.
 *
 * NO SECOND INCIDENT SYSTEM. This renders `HotelIssue` rows through the same
 * `IssueStatusBadge` / `IssueTimeline` the rest of the app uses; nothing here
 * stores a status, an area or a technician of its own.
 *
 * REPORTING A NEW FAULT HAPPENS HERE NOW, through the SAME dialog the old
 * standalone "Báo cáo sự cố" screen used — `NewIssueModal`, in
 * IncidentReporting. Reception used to have two sidebar entries for one job:
 * report a fault in one place, watch it in another. There is one entry now, and
 * exactly one issue form, one issue API and one issue model behind it.
 *
 * THE JOURNAL ACTION IS SECONDARY, ON PURPOSE. Recording that an EXISTING
 * incident is part of this shift's journal — for the official report — is one
 * quiet button per row, not the page's primary interaction, and it
 * never asks the receptionist to identify the incident: they are looking at it.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Wrench } from 'lucide-react';
import { issuesApi } from '../api/issues';
import { reportsApi, type OperationalReport } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { RowAction } from './DataTable';
import { IncidentTable, NewIssueModal } from './IncidentReporting';

export function FacilityIssueBoard({
  currentShiftFacilityReports,
  onLogged,
  onToast,
  reportOpen,
  onCloseReport,
}: {
  /** This shift's own FACILITY_ISSUE journal rows — decides "Đã thêm" per row. */
  currentShiftFacilityReports: OperationalReport[];
  onLogged: () => void | Promise<void>;
  onToast: (message: string) => void;
  /** "+ Báo cáo sự cố", owned by the category header above this board. */
  reportOpen: boolean;
  onCloseReport: () => void;
}) {
  const issues = useQuery({
    queryKey: ['reception', 'facility-board', 'outstanding'],
    queryFn: () => issuesApi.list({ outstanding: true, pageSize: 100 }),
    // Technicians update these independently of anything on this screen, so a
    // receptionist watching this board should see a status change without
    // having to leave the tab.
    refetchInterval: 30_000,
  });

  const loggedIssueIds = new Set(
    currentShiftFacilityReports.filter((r) => !r.voided).map((r) => r.facility?.issueId),
  );

  const logToJournal = useMutation({
    mutationFn: (issueId: string) =>
      reportsApi.create({ category: 'FACILITY_ISSUE', facility: { issueId } }),
    onSuccess: async () => {
      await onLogged();
      onToast('Đã thêm vào nhật ký ca.');
    },
    onError: (e) => onToast(toUserMessage(e)),
  });

  const rows = issues.data?.issues ?? [];

  return (
    <>
      {reportOpen ? (
        <NewIssueModal
          onClose={onCloseReport}
          onCreated={() => {
            // The board reads its own query, which `NewIssueModal` does not know
            // about — it invalidates `['issues']`. Refetch so the incident the
            // receptionist just reported is on screen before they look for it.
            void issues.refetch();
            onToast('Đã gửi báo cáo sự cố cho bộ phận kỹ thuật.');
          }}
        />
      ) : null}
      <IncidentTable
        testId="facility-board"
        title="Sự cố đang xử lý"
        rows={rows}
        isLoading={issues.isLoading}
        isError={issues.isError}
        error={issues.error}
        onRetry={() => void issues.refetch()}
        emptyTitle="Không có sự cố nào đang chờ xử lý"
        emptyMessage="Mọi sự cố cơ sở vật chất của chi nhánh đã được xử lý xong."
        actions={(issue) =>
          loggedIssueIds.has(issue.id) ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Đã thêm
            </span>
          ) : (
            <RowAction
              onClick={() => logToJournal.mutate(issue.id)}
              disabled={logToJournal.isPending}
              testId={`facility-log-${issue.id}`}
            >
              <Wrench className="h-3 w-3" aria-hidden="true" />
              Thêm vào nhật ký ca
            </RowAction>
          )
        }
      />
    </>
  );
}
