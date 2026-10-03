/**
 * The pieces of an incident that several screens all have to render the same
 * way: Reception's own list, the Technical queues (technician and Quản lý kỹ
 * thuật) and the Admin monitor.
 *
 * They live here rather than being copied into each page because the status
 * names, the colours and the "where is it" line are the shared vocabulary of the
 * workflow — copies would drift, and an incident reading "Đang sửa" on one
 * screen and "Đang xử lý" on another is a support call.
 *
 * TWO BADGES, NEVER ONE
 *
 * "The technician finished" and "Quản lý kỹ thuật passed it" are different
 * events, so an incident carries two badges: its STAGE (where the work stands)
 * and its INSPECTION ("Nghiệm thu: …"). Both labels come from the server, which
 * computes them once for every screen and export.
 *
 * THE INFORMATION HIERARCHY
 *
 * An incident card used to be one paragraph of run-together text: branch,
 * location, category, description, reporter, technician, phone and two
 * timestamps, all at the same visual weight, wrapping wherever the column
 * happened to end. A technician scanning for "which room, and who has it" had to
 * read all of it. It is now labelled blocks in a fixed order —
 *
 *     WHERE      branch · location · status
 *     WHAT       category, description and cause
 *     REPORTED   who raised it, and when
 *     ASSIGNED   who is fixing it, their phone, when they took it
 *     OUTCOME    how it ended, how long it took, and the inspection
 *
 * — so the same question is always answered in the same place, and a block with
 * nothing true to say is not rendered at all rather than shown empty.
 */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Clock3, XCircle } from 'lucide-react';
import {
  REPAIR_OUTCOME_LABEL,
  currentVerdict,
  type InspectionState,
  type Issue,
  type IssueEdit,
  type IssueStage,
  type RepairAttempt,
} from '../api/issues';
import { formatDateTime } from '../lib/format';

/**
 * One colour per stage. "Cần sửa lại" gets its own BECAUSE IT IS NOT A NEW
 * STATUS: an incident sent back is `NEW` in the database, exactly like one
 * nobody has opened, and rendering both alike would hide the single most useful
 * thing a technician picking up the queue could know — somebody already went,
 * and it is still not right.
 */
const STAGE_STYLES: Record<IssueStage, string> = {
  WAITING: 'bg-amber-100 text-amber-800 ring-amber-300',
  REWORK: 'bg-rose-100 text-rose-800 ring-rose-300',
  IN_PROGRESS: 'bg-blue-100 text-blue-800 ring-blue-300',
  AWAITING_INSPECTION: 'bg-violet-100 text-violet-800 ring-violet-300',
  COMPLETED: 'bg-green-100 text-green-800 ring-green-300',
};

/** Where the work stands — "Chờ kỹ thuật", "Cần sửa lại", "Chờ nghiệm thu"… */
export function IssueStageBadge({ issue }: { issue: Pick<Issue, 'stage' | 'stageLabel'> }) {
  return (
    <span
      data-testid="issue-stage"
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STAGE_STYLES[issue.stage]}`}
    >
      {issue.stageLabel}
    </span>
  );
}

const INSPECTION_STYLES: Record<InspectionState, string> = {
  PENDING: 'border-violet-300 bg-white text-violet-800',
  PASSED: 'border-emerald-400 bg-emerald-50 text-emerald-800',
  FAILED: 'border-rose-400 bg-rose-50 text-rose-800',
  NO_DATA: 'border-line bg-white text-slate-600',
};

const INSPECTION_ICONS: Record<InspectionState, typeof CheckCircle2> = {
  PENDING: Clock3,
  PASSED: CheckCircle2,
  FAILED: XCircle,
  NO_DATA: CircleDashed,
};

/**
 * "Nghiệm thu: Đạt". Outlined, with an icon and the word "Nghiệm thu" spelled
 * out, so it can never be mistaken for the stage badge beside it.
 */
export function InspectionBadge({
  state,
  label,
  testId = 'attempt-inspection-badge',
}: {
  state: InspectionState;
  label: string;
  testId?: string;
}) {
  const Icon = INSPECTION_ICONS[state];
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${INSPECTION_STYLES[state]}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      Nghiệm thu: {label}
    </span>
  );
}

/** The issue's own inspection state, as the server labelled it. */
export function IssueInspectionBadge({
  issue,
}: {
  issue: Pick<Issue, 'inspectionState' | 'inspectionLabel'>;
}) {
  return <InspectionBadge state={issue.inspectionState} label={issue.inspectionLabel} testId="issue-inspection" />;
}

export function IssueThumb({ url }: { url: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className="mt-3 block overflow-hidden rounded-xl border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <img src={url} alt="Ảnh sự cố" className="h-20 w-20 object-cover" />
      </button>
      {zoom ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoom(false)}
        >
          <img
            src={url}
            alt="Ảnh sự cố phóng to"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * One labelled fact. Renders nothing when there is nothing true to say — unless
 * `empty` is given, for the facts whose absence IS the information
 * ("Nguyên nhân ban đầu: Chưa có").
 */
function Field({
  label,
  value,
  wrap = false,
  empty,
}: {
  label: string;
  value: ReactNode;
  wrap?: boolean;
  empty?: string;
}) {
  if (!value && !empty) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`text-sm ${value ? 'text-slate-800' : 'italic text-slate-500'} ${
          wrap ? 'whitespace-pre-line break-words' : 'truncate'
        }`}
      >
        {value || empty}
      </dd>
    </div>
  );
}

/**
 * Who worked the incident and when — the CURRENT assignment, plus how it ended.
 *
 * Shows nothing while the incident is NEW and has never been worked, because
 * there is nothing true to say. It does NOT hide itself merely because the
 * status is NEW: an incident sent back for rework is NEW and has a history, and
 * that history is the whole reason the card is worth reading.
 */
export function IssueWorkTrail({ issue }: { issue: Issue }) {
  const hasHistory = issue.attempts.length > 0;
  if (issue.status === 'NEW' && !hasHistory) return null;

  return (
    <div className="mt-3 space-y-3">
      {issue.technicianName || issue.acceptedAt ? (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Người xử lý
          </h4>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-3">
            <Field label="Người sửa" value={issue.technicianName} />
            <Field label="SĐT" value={issue.technicianPhone} />
            <Field label="Tiếp nhận" value={issue.acceptedAt ? formatDateTime(issue.acceptedAt) : null} />
          </dl>
        </section>
      ) : null}

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Kết quả
        </h4>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-3">
          <Field label="Trạng thái" value={issue.stageLabel} />
          <Field
            label="Hoàn thành"
            value={issue.completedAt ? formatDateTime(issue.completedAt) : null}
          />
          {/*
            The live elapsed time while a repair is running, the final one once
            it has finished. Both are computed by the SERVER — see
            `lib/duration.ts` — so this card, the Admin monitor and the exported
            PDF cannot round the same interval three different ways.
          */}
          <Field
            label={issue.status === 'IN_PROGRESS' ? 'Đã xử lý' : 'Thời gian xử lý'}
            value={issue.durationLabel}
          />
        </dl>
      </section>

      {hasHistory ? (
        <IssueTimeline attempts={issue.attempts} stage={issue.stage} showInspection={issue.inspectionEnabled} />
      ) : null}
    </div>
  );
}

/** A verdict on one attempt, or why there is none. */
function AttemptInspection({ attempt, pending }: { attempt: RepairAttempt; pending: boolean }) {
  const verdict = attempt.inspection;
  if (!verdict) {
    // Only a FINISHED repair can be judged; a running or abandoned one has
    // nothing to say here.
    if (attempt.outcome !== 'COMPLETED') return null;
    return (
      <div className="mt-1">
        <InspectionBadge
          state={pending ? 'PENDING' : 'NO_DATA'}
          label={pending ? 'Chưa nghiệm thu' : 'Chưa có dữ liệu'}
        />
      </div>
    );
  }
  const failed = verdict.result === 'FAILED';
  return (
    <div
      data-testid="attempt-inspection"
      className={`mt-1.5 rounded-lg border px-2.5 py-1.5 ${
        failed ? 'border-rose-300 bg-rose-50/60' : 'border-emerald-300 bg-emerald-50/60'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <InspectionBadge state={verdict.result} label={verdict.resultLabel} />
        <span className="text-xs text-slate-700">
          {verdict.inspectedByName ?? '—'}
          {verdict.inspectedAt ? ` · ${formatDateTime(verdict.inspectedAt)}` : ''}
        </span>
      </div>
      {verdict.note ? (
        <p className={`mt-1 text-xs ${failed ? 'font-medium text-rose-800' : 'text-slate-700'}`}>
          {failed ? 'Lý do không đạt' : 'Ghi chú'}: {verdict.note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Every attempt, oldest first, with what each one found, what it did, and what
 * Quản lý kỹ thuật said about it.
 *
 * WHY A TIMELINE AND NOT MORE FIELDS. An incident can be worked more than once,
 * and the fields above can only ever describe the CURRENT assignment — so a
 * second technician's acceptance replaces the first one's on the card exactly as
 * it does in the database. This is the only place that can show both, and it is
 * what "Lần 1: Bảo, 40 phút, không đạt — vẫn chưa lạnh" lives in.
 *
 * `stage` says whether the LAST finished repair is waiting to be judged
 * ("Chưa nghiệm thu") or was finished before inspection existed ("Chưa có dữ
 * liệu").
 */
export function IssueTimeline({
  attempts,
  stage,
  showInspection = true,
}: {
  attempts: RepairAttempt[];
  stage?: IssueStage;
  /**
   * False while inspection is dormant: the history then reads exactly as the
   * operational workflow does — who, when, the cause and the result — and says
   * nothing about a verdict. Recorded verdicts stay on the attempts.
   */
  showInspection?: boolean;
}) {
  if (attempts.length === 0) return null;
  const lastId = attempts[attempts.length - 1]?.id;
  return (
    <section data-testid="issue-timeline">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Lịch sử xử lý
      </h4>
      <ol className="space-y-3 border-l-2 border-line pl-3">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -left-[19px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
                attempt.inspection?.result === 'FAILED' || attempt.outcome === 'CANNOT_REPAIR'
                  ? 'bg-rose-500'
                  : attempt.outcome === 'COMPLETED'
                    ? 'bg-green-500'
                    : 'bg-blue-500'
              }`}
            />
            <p className="text-xs text-slate-800">
              <span className="font-semibold">Lần {attempt.attemptNumber}</span>
              {' · '}
              {attempt.technicianName}
              {attempt.technicianPhone ? ` · ${attempt.technicianPhone}` : ''}
            </p>
            <p className="text-xs text-slate-600">
              Tiếp nhận {formatDateTime(attempt.acceptedAt)}
              {attempt.outcomeAt ? (
                <>
                  {' · '}
                  {attempt.outcome ? REPAIR_OUTCOME_LABEL[attempt.outcome] : '—'}{' '}
                  {formatDateTime(attempt.outcomeAt)}
                </>
              ) : (
                ' · đang xử lý'
              )}
              {attempt.durationLabel ? ` · ${attempt.durationLabel}` : ''}
            </p>
            {attempt.cause ? (
              <p className="text-xs text-slate-700">
                <span className="text-slate-500">Nguyên nhân:</span> {attempt.cause}
              </p>
            ) : null}
            {attempt.result ? (
              <p className="text-xs text-slate-700">
                <span className="text-slate-500">Kết quả:</span> {attempt.result}
              </p>
            ) : null}
            {attempt.reason ? (
              <p className="text-xs text-rose-700">Lý do: {attempt.reason}</p>
            ) : null}
            {showInspection ? (
              <AttemptInspection
                attempt={attempt}
                pending={stage === 'AWAITING_INSPECTION' && attempt.id === lastId}
              />
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * What the desk corrected after filing the report — the words that were there,
 * the words that replaced them, who and when.
 *
 * SHOWN WHEREVER THE INCIDENT IS: the reception board, the Admin's monitor and
 * the technician's card all render it, so a technician on the way with the old
 * description is never the only person who cannot see that it changed. Renders
 * nothing for an incident that was never corrected.
 */
export function IssueEditHistory({ edits }: { edits: IssueEdit[] }) {
  if (edits.length === 0) return null;
  return (
    <section data-testid="issue-edit-history">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Lịch sử chỉnh sửa
      </h4>
      <ul className="space-y-1">
        {edits.map((e) => (
          <li key={e.id} className="text-xs text-slate-600">
            <span className="font-medium text-slate-700">{e.fieldLabel}</span>: {e.oldValue ?? '—'} →{' '}
            {e.newValue ?? '—'} · {e.actorName} · {formatDateTime(e.createdAt)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A one-line flag for an incident that has been corrected — for a card that has no room for the list. */
export function IssueEditedFlag({ issue }: { issue: Pick<Issue, 'edits'> }) {
  // `?? []`: an incident from a payload that predates the edit history has none.
  if ((issue.edits ?? []).length === 0) return null;
  return (
    <span
      data-testid="issue-edited-flag"
      className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
    >
      Đã chỉnh sửa
    </span>
  );
}

/** A titled block of the lifecycle panel. */
function LifecyclePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line-strong bg-white">
      <h4 className="border-b border-line bg-slate-100 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-700">
        {title}
      </h4>
      <dl className="grid gap-x-5 gap-y-3 px-4 py-3 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

/**
 * THE WHOLE LIFECYCLE OF ONE INCIDENT: the report, the repair and the
 * inspection, then every attempt.
 *
 * One component for the Admin's expanded record and for Quản lý kỹ thuật's
 * inspection dialog, so the person judging a repair and the person auditing it
 * later read the same facts laid out the same way.
 *
 * The repair block describes the LATEST attempt, read from the attempt itself:
 * after a failed inspection the incident's current-assignment columns are empty
 * (nobody is on it), but the last repair still happened and is still what the
 * rework is measured against. Incidents worked before attempts existed fall back
 * to those columns.
 */
export function IssueLifecycleDetail({ issue, showBranch = true }: { issue: Issue; showBranch?: boolean }) {
  const last = issue.attempts[issue.attempts.length - 1];
  const judged = currentVerdict(issue);
  const technician = last?.technicianName ?? issue.technicianName;
  const acceptedAt = last?.acceptedAt ?? issue.acceptedAt;
  const finishedAt = last ? (last.outcome === 'COMPLETED' ? last.outcomeAt : null) : issue.completedAt;
  const duration = last?.durationLabel ?? issue.durationLabel;

  return (
    /*
      THE DETAIL READS LARGER THAN THE CARDS. The same pieces render compact on
      the queue cards; here, opened on purpose, every label, value and history
      line steps up one size and gets more air — through these descendant rules,
      so the cards elsewhere stay exactly as they are.
    */
    <div
      data-testid="issue-lifecycle"
      className="space-y-4 [&_dd]:text-[15px] [&_dd]:leading-relaxed [&_dt]:text-xs [&_dt]:font-medium [&_h4]:text-xs [&_li]:text-sm [&_li]:leading-relaxed [&_li_p]:text-sm [&_section>p]:text-sm"
    >
      {/*
        Three across only from `xl`: at 1100 the Admin record is ~730px wide,
        and three panels of two columns each truncated dates and names. Every
        value here wraps rather than truncates — a lifecycle hides nothing.
      */}
      <div className={`grid gap-3 ${issue.inspectionEnabled ? 'xl:grid-cols-3' : 'lg:grid-cols-2'}`}>
        <LifecyclePanel title="Báo cáo">
          {showBranch ? (
            // The address, as every other incident screen names a branch — the
            // internal code truncated to "TRUONG_DINH_…" in this narrow panel.
            <Field label="Chi nhánh" value={issue.branch?.address} wrap />
          ) : null}
          <Field label="Người báo" value={issue.reporterName} wrap empty="—" />
          <Field label="Thời gian báo cáo" value={formatDateTime(issue.createdAt)} wrap />
          <Field label="Khu vực" value={issue.locationLabel} wrap />
          <div className="sm:col-span-2">
            <Field label="Sự cố" value={issue.description} wrap />
          </div>
          <div className="sm:col-span-2">
            <Field label="Nguyên nhân ban đầu" value={issue.reportedCause} wrap empty="Chưa có" />
          </div>
        </LifecyclePanel>

        <LifecyclePanel title="Sửa chữa">
          <div className="sm:col-span-2">
            <dt className="text-[11px] uppercase tracking-wide text-slate-500">Trạng thái</dt>
            <dd className="mt-0.5">
              <IssueStageBadge issue={issue} />
            </dd>
          </div>
          <Field label="Người sửa" value={technician} wrap empty="Chưa có" />
          <Field label="Số lần sửa" value={String(issue.attempts.length)} wrap />
          <Field label="Tiếp nhận" value={acceptedAt ? formatDateTime(acceptedAt) : null} wrap empty="—" />
          <Field label="Hoàn thành" value={finishedAt ? formatDateTime(finishedAt) : null} wrap empty="—" />
          {/* The account that pressed "Hoàn thành" — "Hệ thống" on an older record without one. */}
          {issue.status === 'COMPLETED' || issue.status === 'AWAITING_INSPECTION' ? (
            <Field label="Người hoàn thành" value={issue.completedByName ?? 'Hệ thống'} wrap />
          ) : null}
          <Field label="Thời gian xử lý" value={duration} wrap />
          <div className="sm:col-span-2">
            <Field label="Nguyên nhân" value={issue.cause} wrap empty="Chưa xác định" />
          </div>
          <div className="sm:col-span-2">
            <Field label="Kết quả sửa chữa" value={last?.result} wrap />
          </div>
          {/* "Hoàn thành": was the report right? */}
          {issue.reportVerdict ? (
            <div className="sm:col-span-2">
              <Field
                label="Kết luận báo cáo"
                value={issue.reportVerdict === 'INCORRECT' ? `Báo cáo sai — ${issue.incorrectReason ?? '—'}` : 'Báo cáo đúng'}
                wrap
              />
            </div>
          ) : null}
        </LifecyclePanel>

        {/* Only while inspection is part of the workflow — dormant, it is not shown at all. */}
        {issue.inspectionEnabled ? (
          <LifecyclePanel title="Nghiệm thu">
            <div className="sm:col-span-2">
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Trạng thái nghiệm thu</dt>
              <dd className="mt-0.5">
                <IssueInspectionBadge issue={issue} />
              </dd>
            </div>
            <Field label="Người nghiệm thu" value={judged?.inspectedByName} wrap empty="—" />
            <Field
              label="Thời gian nghiệm thu"
              value={judged?.inspectedAt ? formatDateTime(judged.inspectedAt) : null}
              wrap
              empty="—"
            />
            {judged?.note ? (
              <div className="sm:col-span-2">
                <Field
                  label={judged.result === 'FAILED' ? 'Lý do không đạt' : 'Ghi chú'}
                  value={judged.note}
                  wrap
                />
              </div>
            ) : null}
          </LifecyclePanel>
        ) : null}
      </div>

      <IssueStageTimeline issue={issue} />
      <IssueRepeatNote issue={issue} />
      <IssueAssignmentHistory issue={issue} />
      <IssueTimeline attempts={issue.attempts} stage={issue.stage} showInspection={issue.inspectionEnabled} />
    </div>
  );
}

/**
 * "Báo lại sau lần hoàn thành trước" — the same room and the same kind of fault
 * was finished before. A FACT with its dates, worded neutrally: nobody is being
 * blamed, and nothing is blocked. Renders nothing when there is no earlier one.
 */
export function IssueRepeatNote({ issue }: { issue: Pick<Issue, 'repeatOf' | 'createdAt'> }) {
  const prev = issue.repeatOf;
  if (!prev) return null;
  return (
    <p
      data-testid="issue-repeat"
      className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
    >
      <span className="font-semibold">Báo lại sau lần hoàn thành trước</span> — lần trước: {prev.description}
      {' · hoàn thành '}
      {prev.completedAt ? formatDateTime(prev.completedAt) : '—'}
      {prev.technicianName ? ` · ${prev.technicianName}` : ''}. Lần này báo {formatDateTime(issue.createdAt)}.
      {(prev.stages ?? []).length > 0 ? (
        <span className="mt-1 block" data-testid="issue-repeat-stages">
          Lần trước đã làm:{' '}
          {(prev.stages ?? []).map((st) => `Giai đoạn ${st.stageNumber}: ${st.workDone}`).join(' · ')}
        </span>
      ) : null}
    </p>
  );
}

/**
 * THE REPAIR, STAGE BY STAGE — "Giai đoạn 1 ✓, Giai đoạn 2 ✓, Giai đoạn 3 ●".
 *
 * Each finished stage is kept as it was recorded (who, when, what was done,
 * what was left); the stage under way is the next number while the repair is
 * worked. Renders nothing for a repair finished in one go with no stage on
 * record — the ordinary case needs no timeline.
 */
export function IssueStageTimeline({ issue }: { issue: Pick<Issue, 'stages' | 'currentStageNumber' | 'status'> }) {
  const stages = issue.stages ?? [];
  const current = issue.currentStageNumber ?? null;
  if (stages.length === 0 || (stages.length === 1 && stages[0]!.final && current === null)) return null;
  const last = stages[stages.length - 1];
  return (
    <section data-testid="issue-stages" className="mt-2">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Các giai đoạn sửa chữa</h4>
      <ol className="space-y-1.5 border-l-2 border-line pl-3">
        {stages.map((st) => (
          <li key={st.id} className="text-xs text-slate-700" data-testid={`issue-stage-${st.stageNumber}`}>
            <span className="font-semibold text-green-700">✓ Giai đoạn {st.stageNumber}</span>
            {' · '}
            {st.technicianName} · {formatDateTime(st.startedAt)} → {formatDateTime(st.completedAt)}
            <span className="block">Công việc hoàn thành: {st.workDone}</span>
            {st.nextWork ? <span className="block text-slate-600">Cần xử lý tiếp: {st.nextWork}</span> : null}
          </li>
        ))}
        {current !== null ? (
          <li className="text-xs font-semibold text-blue-700" data-testid="issue-stage-current">
            ● Giai đoạn {current} — đang thực hiện
            {last?.nextWork ? <span className="block font-normal text-slate-600">Tiếp theo: {last.nextWork}</span> : null}
          </li>
        ) : null}
      </ol>
    </section>
  );
}

/**
 * Who was given the job, by whom, and when — every assignment and reassignment,
 * oldest first, above what each technician did with it. Renders nothing for an
 * incident nobody has assigned yet (the state label says "Chưa giao" elsewhere).
 */
export function IssueAssignmentHistory({
  issue,
}: {
  issue: Pick<Issue, 'assignments' | 'assignmentStateLabel' | 'assignedTechnician'>;
}) {
  const rows = issue.assignments ?? [];
  if (rows.length === 0) return null;
  return (
    <section data-testid="issue-assignments">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Giao việc</h4>
      {issue.assignmentStateLabel ? (
        <p className="mb-1 text-xs font-medium text-slate-800">
          {issue.assignmentStateLabel}
          {issue.assignedTechnician ? ` · ${issue.assignedTechnician.name}` : ''}
        </p>
      ) : null}
      <ul className="space-y-0.5">
        {rows.map((a) => (
          <li key={a.id} className="text-xs text-slate-600">
            {formatDateTime(a.createdAt)} ·{' '}
            {a.reassigned
              ? `Giao lại: ${a.previousTechnicianName ?? '—'} → ${a.technicianName}`
              : `Giao cho ${a.technicianName}`}
            {' · bởi '}
            {a.assignedByName}
            {a.returnedAt ? (
              <span className="block text-amber-800">
                ↩ Chuyển về chờ giao kỹ thuật · {formatDateTime(a.returnedAt)} · bởi {a.returnedByName ?? '—'}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
