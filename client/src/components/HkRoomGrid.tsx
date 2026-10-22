/**
 * "TÌNH TRẠNG PHÒNG" BY FLOOR — every room and area of the branch, one tile each,
 * floors as the branch configures them (the Suite floors' own labels, the rooms
 * not yet placed, the Rooftop), coloured by where its housekeeping work stands.
 *
 * This is CLEANING status only, never occupancy: a room with no work today is
 * "Không có việc" — not "Trống", not "Chưa dọn". A tile's status comes from the
 * room's latest live cycle of the day and the server's own phase; no state is
 * invented to fill a colour:
 *
 *   Chưa dọn (gray)          not taken yet / taken, inspection not started
 *   Đang kiểm tra (gray)     the worker is inspecting
 *   Đã kiểm tra (amber)      inspected, cleaning not started
 *   Đang dọn (blue)          cleaning
 *   Chờ đánh giá (amber)     cleaned, waiting for the manager's "Đạt / Không đạt"
 *   Đã dọn / Đạt (green)     finished (and passed, where it was reviewed)
 *   Không đạt / Cần dọn lại (red)
 *   Chờ duyệt không cần dọn (amber) · Không cần dọn (gray)
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RoomTask } from '../api/roomWork';
import { LEGEND, STATUS_ICON_CLASS as STATUS_ICON, type FloorBlock, type RoomStatus, type RoomStatusGroup, type RoomTile } from '../lib/roomStatus';
import { CodeChips } from './HkWorkGroups';

const TILE: Record<RoomStatus['tone'], string> = {
  none: 'border-line-subtle bg-slate-50/60',
  slate: 'border-line-subtle bg-white',
  gray: 'border-line-subtle bg-white',
  blue: 'border-blue-200 bg-blue-50/40',
  green: 'border-green-200 bg-green-50/40',
  red: 'border-red-200 bg-red-50/50',
  amber: 'border-amber-200 bg-amber-50/50',
};

const STATUS_TEXT: Record<RoomStatus['tone'], string> = {
  none: 'text-slate-500',
  slate: 'text-slate-700',
  gray: 'text-slate-700',
  blue: 'text-blue-800',
  green: 'text-green-800',
  red: 'text-red-700',
  amber: 'text-amber-800',
};


export function StatusLegend() {
  return (
    <ul className="space-y-2.5" data-testid="room-legend">
      {LEGEND.map(({ label, hint, status }) => {
        const Icon = status.icon;
        return (
          <li key={label} className="flex items-start gap-2.5">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${STATUS_ICON[status.tone]}`} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900">{label}</span>
              <span className="block text-xs text-slate-500">{hint}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Tile({ tile, onOpen }: { tile: RoomTile; onOpen: (t: RoomTask) => void }) {
  const { task, status } = tile;
  const Icon = status.icon;
  const title = tile.isRoom ? `Phòng ${tile.name}` : tile.name;
  return (
    <li className={`flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5 ${TILE[status.tone]}`} data-testid={`room-tile-${tile.key}`}>
      <div className="flex items-start justify-between gap-1.5">
        <span className={`min-w-0 truncate font-semibold tabular-nums ${tile.isRoom ? 'text-base' : 'text-sm'} ${task ? 'text-slate-900' : 'text-slate-500'}`} title={title}>
          {tile.name}
        </span>
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${STATUS_ICON[status.tone]}`} aria-hidden="true" />
      </div>
      <p className={`text-xs font-semibold ${STATUS_TEXT[status.tone]}`} data-testid={`room-status-${tile.key}`}>
        {status.label}
      </p>
      {task ? (
        <>
          <CodeChips task={task} />
          <p className="truncate text-xs text-slate-600" title={task.assignee?.name ?? 'Chưa giao'}>
            {task.assignee ? task.assignee.name : 'Chưa giao'}
          </p>
          <button
            type="button"
            onClick={() => onOpen(task)}
            aria-label={`Chi tiết ${title}`}
            data-testid={`room-open-${tile.key}`}
            className="mt-auto inline-flex min-h-[2rem] items-center justify-center rounded-md border border-line-subtle bg-white px-2 text-xs font-medium text-slate-700 hover:border-line-strong hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Chi tiết
          </button>
        </>
      ) : null}
    </li>
  );
}

function FloorSection({
  block,
  tiles,
  open,
  onToggle,
  onOpen,
}: {
  block: FloorBlock;
  /** The block's tiles after the filters. */
  tiles: RoomTile[];
  open: boolean;
  onToggle: () => void;
  onOpen: (t: RoomTask) => void;
}) {
  const withWork = block.tiles.filter((t) => t.task);
  const done = withWork.filter((t) => t.status.group === 'done' || t.status.group === 'noclean').length;
  const pct = withWork.length === 0 ? 0 : Math.round((done / withWork.length) * 100);
  const id = `floor-body-${block.key.replace(/[^a-zA-Z0-9-]/g, '_')}`;
  const roomCount = block.tiles.filter((t) => t.isRoom).length;
  const areaCount = block.tiles.length - roomCount;
  return (
    <section className="border-b border-line-subtle last:border-b-0" data-testid={`floor-${block.key}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
            <span className="truncate text-[15px] font-semibold text-slate-900">{block.label}</span>
            <span className="shrink-0 text-sm text-slate-500">
              ({roomCount > 0 ? `${roomCount} phòng` : ''}
              {roomCount > 0 && areaCount > 0 ? ', ' : ''}
              {areaCount > 0 ? `${areaCount} khu vực` : ''})
            </span>
          </span>
          <span className="flex w-full items-center gap-3 text-xs text-slate-600 sm:w-auto">
            {withWork.length === 0 ? (
              <span className="text-slate-500">Không có công việc</span>
            ) : (
              <>
                <span className="h-2 w-24 overflow-hidden rounded-full bg-slate-200 sm:w-28" aria-hidden="true">
                  <span className="block h-full rounded-full bg-green-600" style={{ width: `${pct}%` }} />
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {done}/{withWork.length} việc đã xong ({pct}%)
                </span>
              </>
            )}
          </span>
        </button>
      </h3>
      {open ? (
        <div id={id} className="px-4 pb-4">
          {tiles.length === 0 ? (
            <p className="text-sm text-slate-500">Không có phòng nào khớp bộ lọc.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
              {tiles.map((tile) => (
                <Tile key={tile.key} tile={tile} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The floors, filtered: a search, a floor, a status family. */
export function FloorGrid({
  blocks,
  search,
  floor,
  status,
  onOpen,
  empty,
}: {
  blocks: FloorBlock[];
  search: string;
  floor: string;
  status: RoomStatusGroup | '';
  onOpen: (t: RoomTask) => void;
  empty: ReactNode;
}) {
  // A floor starts open when it has work today (or when it is the only one).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const needle = search.trim().toLocaleLowerCase('vi');
  const shown = useMemo(
    () =>
      blocks
        .filter((b) => !floor || b.key === floor)
        .map((b) => ({
          block: b,
          tiles: b.tiles.filter(
            (t) =>
              (!status || t.status.group === status) &&
              (!needle || t.name.toLocaleLowerCase('vi').includes(needle) || (t.task?.assignee?.name ?? '').toLocaleLowerCase('vi').includes(needle)),
          ),
        }))
        .filter((x) => (!needle && !status) || x.tiles.length > 0),
    [blocks, floor, status, needle],
  );
  if (blocks.length === 0) return <>{empty}</>;
  if (shown.length === 0) return <p className="px-4 py-8 text-center text-sm text-slate-500">Không có phòng nào khớp bộ lọc.</p>;
  const filtering = Boolean(needle || status || floor);
  return (
    <div data-testid="board-floors">
      {shown.map(({ block, tiles }) => {
        const natural = filtering || shown.length === 1 || block.tiles.some((t) => t.task);
        const open = toggled[block.key] ?? natural;
        return (
          <FloorSection
            key={block.key}
            block={block}
            tiles={tiles}
            open={open}
            onToggle={() => setToggled((s) => ({ ...s, [block.key]: !open }))}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
}
