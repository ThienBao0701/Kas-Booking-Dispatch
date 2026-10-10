/**
 * ONE ROOM'S WORK, IN FULL — everything the worker entered and everything that
 * happened to it, for the manager and the Admin: the code, priority and note;
 * who it was given to (and every reassignment); the inspection and its findings
 * with what Reception collected; the "Dọn phòng" form item by item; the times
 * and the duration; the void. Nothing the worker did is kept out of this view.
 */
import type { RoomTask, RoomWorkCatalog } from '../api/roomWork';
import { formatMinutes } from '../api/roomWork';
import { formatVnd } from '../lib/money';
import { formatDateTime } from '../lib/format';

function eventText(e: RoomTask['events'][number]): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'ASSIGNED':
      return d.fromName ? `${String(d.fromName)} → ${String(d.toName ?? 'Bỏ giao')}` : `Giao cho ${String(d.toName ?? '—')}`;
    case 'UPDATED': {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      return Object.keys(after)
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
        .map((k) => `${k === 'statusCode' ? 'Mã phòng' : k === 'priority' ? 'Ưu tiên' : 'Ghi chú'}: ${String(before[k] ?? '—')} → ${String(after[k] ?? '—')}`)
        .join(' · ');
    }
    case 'INSPECTED':
      return `${String(d.findings ?? 0)} phát sinh`;
    case 'COMPLETED':
      return formatMinutes(typeof d.durationSeconds === 'number' ? d.durationSeconds : null);
    case 'VOIDED':
      return d.reason ? `Lý do: ${String(d.reason)}` : '';
    default:
      return '';
  }
}

export function RoomTaskDetail({ task, catalog }: { task: RoomTask; catalog?: RoomWorkCatalog }) {
  const label = (list: { code: string; label: string }[] | undefined, code: string) => list?.find((i) => i.code === code)?.label ?? code;
  const c = task.cleaning;
  return (
    <div className="space-y-4 text-sm" data-testid="room-task-detail">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {(
          [
            ['Mã phòng', task.statusCode],
            ['Ưu tiên', task.priority ? 'Có' : 'Không'],
            ['Trạng thái', task.stateLabel],
            ['Người được giao', task.assignee?.name ?? 'Chưa giao'],
            ['Kiểm phòng', task.inspection ? `${task.inspection.inspectorName} · ${formatDateTime(task.inspection.createdAt)}` : '—'],
            ['Bắt đầu', task.startedAt ? formatDateTime(task.startedAt) : '—'],
            ['Hoàn thành', task.completedAt ? formatDateTime(task.completedAt) : '—'],
            ['Thời gian dọn', formatMinutes(task.durationSeconds ?? task.elapsedSeconds)],
            ['Người dọn', task.cleanedBy?.name ?? '—'],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
      {task.note ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">Ghi chú quản lý: {task.note}</p> : null}
      {task.voided ? (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800">
          Đã xóa bởi {task.voidedByName ?? '—'} · {task.voidedAt ? formatDateTime(task.voidedAt) : ''}
          {task.voidReason ? ` · ${task.voidReason}` : ''}
        </p>
      ) : null}

      <section>
        <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">Kiểm phòng</h4>
        {!task.inspection ? (
          <p className="text-slate-500">Chưa kiểm phòng.</p>
        ) : task.inspection.findings.length === 0 ? (
          <p className="text-slate-700">Không có vấn đề.</p>
        ) : (
          <ul className="space-y-1">
            {task.inspection.findings.map((f) => (
              <li key={f.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-line px-3 py-1.5" data-testid={`task-finding-${f.id}`}>
                <span>
                  {f.typeLabel}
                  {f.note ? ` — ${f.note}` : ''}
                  {f.voided ? ' (đã hủy)' : ''}
                </span>
                {f.collectionStatusLabel ? (
                  <span className="text-slate-600">
                    {f.collectionStatusLabel}
                    {f.amount !== null ? ` · ${formatVnd(f.amount)}` : ''}
                    {f.collectedByName ? ` · ${f.collectedByName}` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">Dọn phòng</h4>
        {!c ? (
          <p className="text-slate-500">Chưa có dữ liệu dọn phòng.</p>
        ) : (
          <div className="space-y-1.5 text-slate-800" data-testid="task-cleaning">
            <p>
              <span className="text-slate-500">Đồ vải: </span>
              {Object.entries(c.linen)
                .map(([k, e]) => `${label(catalog?.linen, k)}: ${label(catalog?.linenSizes, e.size)}${e.quantity === null ? '' : ` × ${e.quantity}`}`)
                .join(' · ') || '—'}
            </p>
            <p>
              <span className="text-slate-500">Số lượng: </span>
              {Object.entries(c.quantities).map(([k, n]) => `${label(catalog?.quantities, k)}: ${n}`).join(' · ') || '—'}
            </p>
            <p>
              <span className="text-slate-500">Thay thế ✓: </span>
              {c.replaced.map((k) => label(catalog?.replacements, k)).join(', ') || '—'}
            </p>
            <p>
              <span className="text-slate-500">Ghi nhận đặc biệt: </span>
              {(c.special ?? [])
                .map((k) => {
                  const s = catalog?.specialStatuses.find((x) => x.code === k);
                  return s ? `${s.short} (${s.label})` : k;
                })
                .join(', ') || '—'}
            </p>
            {c.note ? (
              <p>
                <span className="text-slate-500">Ghi chú: </span>
                {c.note}
              </p>
            ) : null}
            {c.savedAt ? <p className="text-xs text-slate-500">Lưu lúc {formatDateTime(c.savedAt)} bởi {c.savedByName ?? '—'}</p> : null}
          </div>
        )}
      </section>

      <section>
        <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">Lịch sử</h4>
        <ol className="space-y-1 border-l-2 border-line pl-3" data-testid="task-history">
          {task.events.map((e) => (
            <li key={e.id} className="text-slate-700">
              <span className="font-medium">{e.label}</span> · {e.actorName} · {formatDateTime(e.createdAt)}
              {eventText(e) ? <span className="block text-xs text-slate-500">{eventText(e)}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
