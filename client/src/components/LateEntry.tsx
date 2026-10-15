/**
 * "NHẬP BÙ" — how every screen marks a record entered after its shift.
 *
 * Two people, always named apart, from what the SERVER stamped:
 *   Người nhập bù   the account that actually entered it (never typed by anyone);
 *   Nhập bù cho     the receptionist of the original shift, who stays the
 *                   record's creator.
 *
 * `LateEntryBadge` is the restrained marker for a table cell; `LateEntryNotice`
 * the full statement for a record's detail. Both read the same words as the
 * exports (`server/src/reception/lateEntryText.ts`). A stamp without a name —
 * never guessed — says "Không có dữ liệu lịch sử".
 */
import { CalendarClock } from 'lucide-react';
import { formatDateTime } from '../lib/format';

const NO_HISTORY = 'Không có dữ liệu lịch sử';

export interface LateEntryStamp {
  enteredBy: { id?: number | null; name: string };
  enteredByRoleLabel: string | null;
  reason: string | null;
  enteredAt: string;
}

function operator(late: LateEntryStamp): string {
  const name = late.enteredBy.name?.trim();
  if (!name || name === '—') return NO_HISTORY;
  return late.enteredByRoleLabel ? `${name} (${late.enteredByRoleLabel})` : name;
}

/** The table-cell marker: "NHẬP BÙ", with both names one hover (or one tap on the row) away. */
export function LateEntryBadge({
  lateEntry,
  forName,
  testId,
}: {
  lateEntry: LateEntryStamp;
  forName: string | null | undefined;
  testId?: string;
}) {
  const title = `Người nhập bù: ${operator(lateEntry)} · Nhập bù cho: ${forName?.trim() || NO_HISTORY} · Nhập lúc ${formatDateTime(lateEntry.enteredAt)}${
    lateEntry.reason ? ` — ${lateEntry.reason}` : ''
  }`;
  return (
    <span
      data-testid={testId}
      title={title}
      className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 align-middle text-[11px] font-bold uppercase tracking-wide text-amber-900"
    >
      <CalendarClock className="h-3 w-3" aria-hidden="true" />
      Nhập bù
      <span className="font-medium normal-case tracking-normal">· {operator(lateEntry)}</span>
    </span>
  );
}

/** The full statement, for a record's detail and the history views. */
export function LateEntryNotice({
  lateEntry,
  forName,
  shiftLabel,
  testId = 'late-entry-notice',
}: {
  lateEntry: LateEntryStamp;
  forName: string | null | undefined;
  /** "Ca A, 07/10/2026" — the original shift the record belongs to. */
  shiftLabel?: string | null;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2 text-sm text-amber-950">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-900">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
        Nhập bù
      </p>
      <dl className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        <div>
          <dt className="inline text-amber-800">Người nhập bù: </dt>
          <dd className="inline font-semibold">{operator(lateEntry)}</dd>
        </div>
        <div>
          <dt className="inline text-amber-800">Nhập bù cho: </dt>
          <dd className="inline font-semibold">{forName?.trim() || NO_HISTORY}</dd>
        </div>
        {shiftLabel ? (
          <div>
            <dt className="inline text-amber-800">Ca gốc: </dt>
            <dd className="inline">{shiftLabel}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline text-amber-800">Nhập lúc: </dt>
          <dd className="inline">{formatDateTime(lateEntry.enteredAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline text-amber-800">Nội dung bổ sung / lý do: </dt>
          <dd className="inline">{lateEntry.reason?.trim() || NO_HISTORY}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The badge for a journal record, when it was a "Nhập bù" — nothing otherwise. */
export function RecordLateEntryBadge({
  row,
}: {
  row: { id: string; createdByName: string; lateEntry?: LateEntryStamp | null };
}) {
  if (!row.lateEntry) return null;
  return <LateEntryBadge lateEntry={row.lateEntry} forName={row.createdByName} testId={`late-entry-${row.id}`} />;
}
