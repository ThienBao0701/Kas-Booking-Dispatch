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
 * PLUS THIS SHIFT'S OWN INCIDENTS, EVEN ONCE FIXED. An incident this shift
 * recorded stays on the board after the technician completes it, read live
 * through the journal row, so "Thời gian hoàn thành" is something the desk can
 * actually see rather than a column that is empty by definition.
 *
 * NO SECOND INCIDENT SYSTEM. This renders `HotelIssue` rows through the same
 * `IssueStatusBadge` / `IssueTimeline` the rest of the app uses; nothing here
 * stores a status, an area or a technician of its own.
 *
 * REPORTING A NEW FAULT HAPPENS HERE, through the SAME dialog the old standalone
 * "Báo cáo sự cố" screen used — `NewIssueModal`, in IncidentReporting — and the
 * incident is then recorded in this shift's journal in the same step. Reception
 * sees progress here and operates nothing: there is no per-row action.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { issuesApi, type Issue } from '../api/issues';
import { reportsApi, type OperationalReport } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { IncidentTable, NewIssueModal } from './IncidentReporting';
import type { SectionFrame } from './ReportSection';

export function FacilityIssueBoard({
  currentShiftFacilityReports,
  onLogged,
  onToast,
  reportOpen,
  onCloseReport,
  title = 'Sự cố đang xử lý',
  compact,
  section,
}: {
  /** This shift's own FACILITY_ISSUE journal rows. */
  currentShiftFacilityReports: OperationalReport[];
  onLogged: () => void | Promise<void>;
  onToast: (message: string) => void;
  /** "+ Báo cáo sự cố", owned by the category header above this board. */
  reportOpen: boolean;
  onCloseReport: () => void;
  title?: string;
  compact?: boolean;
  section?: SectionFrame;
}) {
  const issues = useQuery({
    queryKey: ['reception', 'facility-board', 'outstanding'],
    queryFn: () => issuesApi.list({ outstanding: true, pageSize: 100 }),
    // Technicians update these independently of anything on this screen, so a
    // receptionist watching this board should see a status change without
    // having to leave the tab.
    refetchInterval: 30_000,
  });

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

  const outstanding = issues.data?.issues ?? [];
  const seen = new Set(outstanding.map((i) => i.id));
  const loggedThisShift: Issue[] = [];
  for (const r of currentShiftFacilityReports) {
    const issue = r.facility?.issue;
    if (r.voided || !issue || seen.has(issue.id)) continue;
    seen.add(issue.id);
    loggedThisShift.push(issue);
  }
  const rows = [...outstanding, ...loggedThisShift];

  return (
    <>
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
        compact={compact}
        section={section}
        isLoading={issues.isLoading}
        isError={issues.isError}
        error={issues.error}
        onRetry={() => void issues.refetch()}
        emptyTitle="Không có sự cố nào đang chờ xử lý"
        emptyMessage="Mọi sự cố cơ sở vật chất của chi nhánh đã được xử lý xong."
      />
    </>
  );
}
