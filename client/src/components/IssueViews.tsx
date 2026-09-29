/**
 * The pieces of an incident that three different screens all have to render the
 * same way: Reception's own list, the Technical queues and the Admin monitor.
 *
 * They live here rather than being copied into each page because the status
 * names, the colours and the "where is it" line are the shared vocabulary of the
 * workflow — three copies would drift, and an incident reading "Đang sửa" on one
 * screen and "Đang xử lý" on another is a support call.
 *
 * THE INFORMATION HIERARCHY
 *
 * An incident card used to be one paragraph of run-together text: branch,
 * location, category, description, reporter, technician, phone and two
 * timestamps, all at the same visual weight, wrapping wherever the column
 * happened to end. A technician scanning for "which room, and who has it" had to
 * read all of it. It is now five labelled blocks in a fixed order —
 *
 *     WHERE      branch · location · status
 *     WHAT       category and description
 *     REPORTED   who raised it, and when
 *     ASSIGNED   who is fixing it, their phone, when they took it
 *     OUTCOME    how it ended, and how long it took
 *
 * — so the same question is always answered in the same place, and a block with
 * nothing true to say is not rendered at all rather than shown empty.
 */
import { useState } from 'react';
import {
  REPAIR_OUTCOME_LABEL,
  type Issue,
  type IssueEdit,
  type IssueStatus,
  type RepairAttempt,
} from '../api/issues';
import { formatDateTime } from '../lib/format';

const STATUS_STYLES: Record<IssueStatus, string> = {
  NEW: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
};

/**
 * "Cần xử lý lại" gets its own colour BECAUSE IT IS NOT A NEW STATUS.
 *
 * An incident somebody tried and could not fix is `NEW` in the database, exactly
 * like one nobody has opened. Rendering both in amber as "Sự cố khách sạn" hides
 * the single most useful thing a technician picking up the queue could know:
 * that the last person to go could not finish it, and why.
 */
const REWORK_STYLE = 'bg-rose-100 text-rose-700';

const STATUS_LABEL: Record<IssueStatus, string> = {
  NEW: 'Sự cố khách sạn',
  IN_PROGRESS: 'Đang sửa',
  COMPLETED: 'Đã hoàn thành',
};

export function IssueStatusBadge({
  status,
  needsRework = false,
}: {
  status: IssueStatus;
  needsRework?: boolean;
}) {
  const rework = status === 'NEW' && needsRework;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        rework ? REWORK_STYLE : STATUS_STYLES[status]
      }`}
    >
      {rework ? 'Cần xử lý lại' : STATUS_LABEL[status]}
    </span>
  );
}

export function IssueThumb({ url }: { url: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className="mt-3 block overflow-hidden rounded-xl border border-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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

/** One labelled fact. Renders nothing when there is nothing true to say. */
function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="truncate text-sm text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * Who worked the incident and when — the CURRENT assignment, plus how it ended.
 *
 * Shows nothing while the incident is NEW and has never been worked, because
 * there is nothing true to say. It does NOT hide itself merely because the
 * status is NEW: an incident returned by a "Không sửa được" is NEW and has a
 * history, and that history is the whole reason the card is worth reading.
 */
export function IssueWorkTrail({ issue }: { issue: Issue }) {
  const hasHistory = issue.attempts.length > 0;
  if (issue.status === 'NEW' && !hasHistory) return null;

  const outcomeLabel =
    issue.status === 'COMPLETED'
      ? 'Hoàn thành'
      : issue.status === 'IN_PROGRESS'
        ? 'Đang sửa'
        : 'Đã trả lại hàng đợi';

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
          <Field label="Trạng thái" value={outcomeLabel} />
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

      {hasHistory ? <IssueTimeline attempts={issue.attempts} /> : null}
    </div>
  );
}

/**
 * Every attempt, oldest first.
 *
 * WHY A TIMELINE AND NOT MORE FIELDS. An incident can be worked more than once,
 * and the fields above can only ever describe the CURRENT assignment — so a
 * second technician's acceptance replaces the first one's on the card exactly as
 * it does in the database. This is the only place that can show both, and it is
 * what "Attempt 1: Bảo, 4 phút, không có linh kiện" lives in.
 */
export function IssueTimeline({ attempts }: { attempts: RepairAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <section data-testid="issue-timeline">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Lịch sử xử lý
      </h4>
      <ol className="space-y-2 border-l border-slate-200 pl-3">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -left-[17px] top-1.5 h-2 w-2 rounded-full ${
                attempt.outcome === 'CANNOT_REPAIR'
                  ? 'bg-rose-500'
                  : attempt.outcome === 'COMPLETED'
                    ? 'bg-green-500'
                    : 'bg-blue-500'
              }`}
            />
            <p className="text-xs text-slate-700">
              <span className="font-semibold">Lần {attempt.attemptNumber}</span>
              {' · '}
              {attempt.technicianName}
              {attempt.technicianPhone ? ` · ${attempt.technicianPhone}` : ''}
            </p>
            <p className="text-xs text-slate-500">
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
            {attempt.reason ? (
              <p className="text-xs text-rose-700">Lý do: {attempt.reason}</p>
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
