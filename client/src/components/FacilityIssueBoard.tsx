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
 * incident is then recorded in this shift's journal in the same step. Reception
 * sees progress here and operates nothing: there is no per-row action.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { issuesApi } from '../api/issues';
import { reportsApi } from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { FACILITY_BOARD_KEY } from '../lib/reportKeys';
import { IncidentTable, NewIssueModal } from './IncidentReporting';
import { MoreNote } from './MoreNote';
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
      />
      {/* A page of the newest 100: said so when there are more. */}
      <MoreNote shown={rows.length} total={issues.data?.pagination.total} />
    </div>
  );
}
