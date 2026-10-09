/**
 * "TÌNH TRẠNG PHÒNG NGÀY …" — the board both the worker and the manager read.
 *
 *   OUT     101  102  103
 *   OC      201  202
 *   VC      301
 *
 * One row per operational code (the catalog's order); each room a large tap
 * target whose look says where the cleaning stands — and only that:
 *
 *   gray            chưa bắt đầu
 *   blue            đang dọn
 *   green underline hoàn thành
 *
 * "Ưu tiên" is a red mark on the room. The code and the state are two fields;
 * the board shows both without merging them.
 */
import type { ReactNode } from 'react';
import type { RoomTask } from '../api/roomWork';

const STATE_STYLE: Record<RoomTask['state'], string> = {
  NOT_STARTED: 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200',
  INSPECTED: 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100',
  IN_PROGRESS: 'border-blue-500 bg-blue-50 text-blue-800 hover:bg-blue-100',
  COMPLETED: 'border-line bg-white text-slate-900 hover:bg-slate-50',
};

export function RoomStateLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600" data-testid="room-legend">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded border border-slate-300 bg-slate-100" aria-hidden="true" /> Chưa bắt đầu
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded border border-amber-400 bg-amber-50" aria-hidden="true" /> Đã kiểm tra
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded border border-blue-500 bg-blue-50" aria-hidden="true" /> Đang dọn
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 border-b-[3px] border-green-600" aria-hidden="true" /> Hoàn thành
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-600" aria-hidden="true" /> Ưu tiên
      </span>
    </p>
  );
}

/** One room on the board. */
export function RoomChip({
  task,
  onClick,
  selected = false,
  label,
}: {
  task: Pick<RoomTask, 'id' | 'roomNumber' | 'state' | 'priority' | 'stateLabel'>;
  onClick?: () => void;
  selected?: boolean;
  /** Under the number: the assignee, on the manager's board. */
  label?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`room-chip-${task.roomNumber}`}
      data-state={task.state}
      aria-pressed={selected || undefined}
      aria-label={`Phòng ${task.roomNumber} · ${task.stateLabel}${task.priority ? ' · Ưu tiên' : ''}`}
      className={`relative flex min-h-[3.5rem] min-w-[4.25rem] flex-col items-center justify-center rounded-xl border-2 px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
        STATE_STYLE[task.state]
      } ${selected ? 'ring-2 ring-brand-600 ring-offset-1' : ''}`}
    >
      <span
        className={`text-lg font-bold leading-tight tabular-nums ${
          task.state === 'COMPLETED' ? 'border-b-[3px] border-green-600' : 'border-b-[3px] border-transparent'
        }`}
      >
        {task.roomNumber}
      </span>
      {label ? <span className="mt-0.5 max-w-[6rem] truncate text-[11px] font-medium leading-tight">{label}</span> : null}
      {task.priority ? (
        <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-600 ring-2 ring-white" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/** The rows, by code in the catalog's order (an unknown code keeps a row of its own). */
export function RoomBoard({
  tasks,
  codes,
  onSelect,
  selectedIds,
  labelOf,
  testId = 'room-board',
}: {
  tasks: RoomTask[];
  codes: readonly string[];
  onSelect?: (task: RoomTask) => void;
  selectedIds?: ReadonlySet<string>;
  labelOf?: (task: RoomTask) => ReactNode;
  testId?: string;
}) {
  const order = [...codes, ...[...new Set(tasks.map((t) => t.statusCode))].filter((c) => !codes.includes(c))];
  const rows = order
    .map((code) => ({
      code,
      tasks: tasks
        .filter((t) => t.statusCode === code)
        .sort((a, b) => Number(b.priority) - Number(a.priority) || a.roomNumber.localeCompare(b.roomNumber, 'vi', { numeric: true })),
    }))
    .filter((r) => r.tasks.length > 0);
  return (
    <div className="space-y-3" data-testid={testId}>
      {rows.map((row) => (
        <section key={row.code} className="flex flex-col gap-2 sm:flex-row sm:items-start" data-testid={`room-row-${row.code}`}>
          <h3 className="w-16 shrink-0 pt-1 text-sm font-bold tracking-wide text-slate-700">{row.code}</h3>
          <div className="flex flex-wrap gap-2">
            {row.tasks.map((task) => (
              <RoomChip
                key={task.id}
                task={task}
                onClick={onSelect ? () => onSelect(task) : undefined}
                selected={selectedIds?.has(task.id)}
                label={labelOf?.(task)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
