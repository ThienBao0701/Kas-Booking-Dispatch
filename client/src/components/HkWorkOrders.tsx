/**
 * HOUSEKEEPING WORK ITEMS — the manager's side.
 *
 *   CreateWorkDialog    "+ Tạo công việc": one or many items at once, each its
 *                       own area, job, note and priority ("+ Chọn khu vực" adds
 *                       another), then a review before anything is saved.
 *   WorkOrderTable      "Các công việc trong ngày": ONE ROW PER ITEM — two jobs
 *                       for room 502 are two rows — with Khu vực, Việc cần làm,
 *                       Trạng thái, Người thực hiện, Ghi chú, filters, and the
 *                       full instructions one click down.
 *   ReassignDialog      "Giao lại" an item inspected and waiting for cleaning.
 *
 * The areas are the branch's own catalog, served by the server; the server
 * checks every rule again (required notes, rooms of the branch, who may
 * reassign, the state) — these screens only ask.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, UserCog } from 'lucide-react';
import {
  ROOM_WORK_KEY,
  WORK_PHASE_ORDER,
  roomWorkApi,
  type RoomTask,
  type WorkAreaKind,
  type WorkAreas,
  type WorkItemInput,
  type WorkPhase,
} from '../api/roomWork';
import { toUserMessage } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { Button } from './Button';
import { DataTable, RowAction, type DataColumn } from './DataTable';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { QueryState } from './PageState';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';
const LABEL = 'block text-sm font-medium text-slate-700';

const PHASE_TONES: Record<WorkPhase, string> = {
  UNCLAIMED: 'bg-slate-100 text-slate-700 ring-slate-300',
  ACCEPTED: 'bg-sky-50 text-sky-800 ring-sky-300',
  INSPECTING: 'bg-violet-50 text-violet-800 ring-violet-300',
  AWAITING_CLEANING: 'bg-amber-50 text-amber-900 ring-amber-300',
  CLEANING: 'bg-blue-100 text-blue-800 ring-blue-300',
  COMPLETED: 'bg-green-100 text-green-800 ring-green-300',
  VOIDED: 'bg-rose-50 text-rose-700 ring-rose-300',
};

/** Where an item stands — the server's word, in its own colour (never colour alone). */
export function PhaseBadge({ task }: { task: RoomTask }) {
  const phase = task.phase ?? 'UNCLAIMED';
  return (
    <span
      data-testid={`phase-${task.id}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${PHASE_TONES[phase]}`}
    >
      {task.phaseLabel ?? task.stateLabel}
    </span>
  );
}

const areaOf = (t: RoomTask) => t.areaLabel ?? `Phòng - ${t.roomNumber}`;
const jobOf = (t: RoomTask) => t.taskLabel ?? t.statusCode;

/* ------------------------------------------------------------------ *
 * "+ Tạo công việc"
 * ------------------------------------------------------------------ */

/** One editable section of the form: "where" first (floor, then place), then what. */
interface Draft {
  key: number;
  /** A catalog floor, UNPLACED for "Phòng chưa xác định tầng", '' before a choice. */
  group: string;
  /** A room number, or a shared area: HALLWAY / STAIRCASE / OTHER. */
  place: string;
  /** Typed when the branch has no room catalog. */
  typedRoom: string;
  taskCode: string;
  taskName: string;
  note: string;
  priority: boolean;
}

const UNPLACED = '__unplaced__';
const SHARED: readonly string[] = ['HALLWAY', 'STAIRCASE', 'OTHER'];
const blankDraft = (key: number): Draft => ({ key, group: '', place: '', typedRoom: '', taskCode: '', taskName: '', note: '', priority: false });

function kindOf(d: Draft): WorkAreaKind | null {
  if (SHARED.includes(d.place)) return d.place as WorkAreaKind;
  return d.place || d.typedRoom.trim() ? 'ROOM' : null;
}

/** What the form would send for one section, or why it cannot yet. */
function checkDraft(d: Draft, areas: WorkAreas): { item: WorkItemInput } | { problem: string } {
  const kind = kindOf(d);
  if (!kind) return { problem: 'Chọn khu vực.' };
  const floor = d.group && d.group !== UNPLACED ? d.group : undefined;
  if (kind === 'ROOM') {
    const room = areas.hasRoomCatalog ? d.place : d.typedRoom.trim();
    if (!room) return { problem: 'Chọn phòng.' };
    if (!d.taskCode) return { problem: 'Chọn việc cần làm.' };
    if (d.taskCode === 'OTHER' && !d.note.trim()) return { problem: '"Khác" cần ghi chú nêu rõ việc cần làm.' };
    return {
      item: {
        areaKind: 'ROOM',
        roomNumber: room,
        taskCode: d.taskCode,
        ...(d.taskName.trim() ? { taskName: d.taskName.trim() } : {}),
        ...(d.note.trim() ? { note: d.note.trim() } : {}),
        priority: d.priority,
      },
    };
  }
  if (kind !== 'OTHER' && !floor) return { problem: 'Chọn tầng.' };
  if (!d.taskName.trim()) return { problem: 'Nhập tên công việc.' };
  if (!d.note.trim()) return { problem: kind === 'OTHER' ? '"Khác" cần ghi chú nêu rõ vị trí và việc cần làm.' : 'Khu vực chung cần ghi chú / hướng dẫn.' };
  return { item: { areaKind: kind, ...(floor ? { floor } : {}), taskName: d.taskName.trim(), note: d.note.trim(), priority: d.priority } };
}

function describeItem(item: WorkItemInput, areas: WorkAreas): string {
  const kindLabel = areas.sharedAreas.find((s) => s.kind === item.areaKind)?.label;
  const where = item.areaKind === 'ROOM' ? `Phòng - ${item.roomNumber}` : `${kindLabel}${item.floor ? ` - Tầng ${item.floor}` : ''}`;
  const code = areas.roomTaskCodes.find((c) => c.code === item.taskCode)?.label;
  const what = item.areaKind === 'ROOM' ? `${code ?? item.taskCode}${item.taskName ? ` — ${item.taskName}` : ''}` : item.taskName;
  return `${where} · ${what}`;
}

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function CreateWorkDialog({
  branchId,
  date,
  onClose,
  onCreated,
}: {
  branchId: number;
  date: string;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const areas = useQuery({
    queryKey: [...ROOM_WORK_KEY, 'areas', branchId],
    queryFn: () => roomWorkApi.areas({ branchId }),
    staleTime: 5 * 60_000,
  });
  const nextKey = useRef(2);
  const [drafts, setDrafts] = useState<Draft[]>([blankDraft(1)]);
  const [reviewing, setReviewing] = useState(false);
  // One id per dialog: a double-click, or a retry after a lost response, cannot create twice.
  const requestId = useRef(newRequestId());
  const a = areas.data?.areas;
  const checks = a ? drafts.map((d) => checkDraft(d, a)) : [];
  const ready = checks.length > 0 && checks.every((c) => 'item' in c);

  const save = useMutation({
    mutationFn: () =>
      roomWorkApi.createWorkItems({
        branchId,
        workDate: date,
        requestId: requestId.current,
        items: checks.map((c) => (c as { item: WorkItemInput }).item),
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onCreated(r.duplicate ? 'Các công việc này đã được lưu trước đó.' : `Đã tạo ${r.created} công việc.`);
    },
  });

  const patch = (key: number, next: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.key === key ? { ...d, ...next } : d)));

  return (
    <Modal
      open
      size="4xl"
      title={reviewing ? 'Xem lại công việc' : 'Tạo công việc'}
      onClose={onClose}
      footer={
        reviewing ? (
          <>
            <Button variant="secondary" onClick={() => setReviewing(false)} disabled={save.isPending}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Sửa lại
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={save.isPending || save.isSuccess} data-testid="work-save">
              Lưu {drafts.length} công việc
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
            <Button onClick={() => setReviewing(true)} disabled={!ready} data-testid="work-review">
              Xem lại ({drafts.length})
            </Button>
          </>
        )
      }
    >
      <QueryState isLoading={areas.isLoading} isError={areas.isError} error={areas.error} onRetry={() => void areas.refetch()}>
        {a ? (
          reviewing ? (
            <div className="space-y-3" data-testid="work-review-list">
              <p className="text-sm text-slate-600">Mỗi dòng là một công việc riêng: được nhận, kiểm tra và dọn độc lập.</p>
              <ol className="divide-y divide-line-subtle rounded-xl border border-line">
                {checks.map((c, i) => {
                  const item = (c as { item: WorkItemInput }).item;
                  return (
                    <li key={drafts[i]!.key} className="px-3 py-2 text-sm">
                      <p className="font-semibold text-slate-900">
                        {i + 1}. {describeItem(item, a)}
                        {item.priority ? <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">Ưu tiên</span> : null}
                      </p>
                      {item.note ? <p className="mt-0.5 whitespace-pre-wrap text-slate-600">Ghi chú: {item.note}</p> : null}
                    </li>
                  );
                })}
              </ol>
              {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
            </div>
          ) : (
            <div className="space-y-4">
              {drafts.map((d, i) => (
                <DraftSection
                  key={d.key}
                  index={i}
                  draft={d}
                  areas={a}
                  problem={'problem' in checks[i]! ? (checks[i] as { problem: string }).problem : null}
                  onChange={(next) => patch(d.key, next)}
                  onRemove={drafts.length > 1 ? () => setDrafts((all) => all.filter((x) => x.key !== d.key)) : undefined}
                />
              ))}
              <Button
                variant="secondary"
                onClick={() => setDrafts((all) => [...all, blankDraft(nextKey.current++)])}
                disabled={drafts.length >= 50}
                data-testid="work-add-area"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Chọn khu vực
              </Button>
            </div>
          )
        ) : null}
      </QueryState>
    </Modal>
  );
}

function DraftSection({
  index,
  draft: d,
  areas,
  problem,
  onChange,
  onRemove,
}: {
  index: number;
  draft: Draft;
  areas: WorkAreas;
  problem: string | null;
  onChange: (next: Partial<Draft>) => void;
  onRemove?: () => void;
}) {
  const kind = kindOf(d);
  const groupRooms = d.group === UNPLACED ? areas.unplacedRooms : (areas.floors.find((f) => f.floor === d.group)?.rooms ?? []);
  const id = (field: string) => `work-${d.key}-${field}`;
  const noteRequired = kind !== null && (kind !== 'ROOM' || d.taskCode === 'OTHER');
  return (
    <fieldset className="rounded-xl border border-line bg-slate-50/60 p-3" data-testid={`work-item-${index}`}>
      <legend className="flex w-full items-center justify-between gap-2 px-1 text-sm font-semibold text-slate-800">
        Công việc {index + 1}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            data-testid={`work-remove-${index}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Bỏ công việc này
          </button>
        ) : null}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {areas.hasRoomCatalog || areas.floors.length > 0 ? (
          <label className={LABEL} htmlFor={id('group')}>
            Tầng / nhóm khu vực
            <select
              id={id('group')}
              className={FIELD}
              value={d.group}
              onChange={(e) => onChange({ group: e.target.value, place: '', taskCode: '' })}
              data-testid={`work-group-${index}`}
            >
              <option value="">— Chọn tầng —</option>
              {areas.floors.map((f) => (
                <option key={f.floor} value={f.floor}>
                  {f.label}
                </option>
              ))}
              {areas.unplacedRooms.length > 0 ? <option value={UNPLACED}>{areas.unplacedLabel}</option> : null}
            </select>
          </label>
        ) : null}
        <label className={LABEL} htmlFor={id('place')}>
          Chọn khu vực
          <select
            id={id('place')}
            className={FIELD}
            value={d.place}
            disabled={(areas.hasRoomCatalog || areas.floors.length > 0) && !d.group}
            onChange={(e) => onChange({ place: e.target.value, taskCode: SHARED.includes(e.target.value) ? 'OTHER' : '' })}
            data-testid={`work-place-${index}`}
          >
            <option value="">— Chọn —</option>
            {areas.hasRoomCatalog
              ? groupRooms.map((r) => (
                  <option key={r} value={r}>
                    Phòng {r}
                  </option>
                ))
              : null}
            {!areas.hasRoomCatalog ? <option value="ROOM_TYPED">Phòng (nhập số)</option> : null}
            {d.group !== UNPLACED
              ? areas.sharedAreas.map((s) => (
                  <option key={s.kind} value={s.kind}>
                    {s.label}
                  </option>
                ))
              : null}
          </select>
        </label>
        {!areas.hasRoomCatalog && d.place === 'ROOM_TYPED' ? (
          <label className={LABEL} htmlFor={id('room')}>
            Số phòng
            <input id={id('room')} className={FIELD} value={d.typedRoom} maxLength={50} onChange={(e) => onChange({ typedRoom: e.target.value })} />
          </label>
        ) : null}
        {kind === 'ROOM' ? (
          <label className={LABEL} htmlFor={id('code')}>
            Việc cần làm
            <select id={id('code')} className={FIELD} value={d.taskCode} onChange={(e) => onChange({ taskCode: e.target.value })} data-testid={`work-code-${index}`}>
              <option value="">— Chọn —</option>
              {areas.roomTaskCodes.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind ? (
          <label className={LABEL} htmlFor={id('name')}>
            Tên công việc{kind === 'ROOM' ? ' (không bắt buộc)' : ' *'}
            <input
              id={id('name')}
              className={FIELD}
              value={d.taskName}
              maxLength={200}
              placeholder={kind === 'ROOM' ? 'Ví dụ: Thay khăn' : 'Ví dụ: Dọn lối đi'}
              onChange={(e) => onChange({ taskName: e.target.value })}
              data-testid={`work-name-${index}`}
            />
          </label>
        ) : null}
      </div>
      {kind ? (
        <>
          <label className={`${LABEL} mt-3`} htmlFor={id('note')}>
            Ghi chú / Hướng dẫn{noteRequired ? ' *' : ' (không bắt buộc)'}
            <textarea
              id={id('note')}
              className={FIELD}
              rows={2}
              maxLength={1000}
              value={d.note}
              placeholder={kind === 'ROOM' ? 'Ví dụ: Thay khăn theo hướng dẫn' : 'Ví dụ: Dọn khu vực chung trước 10:00'}
              onChange={(e) => onChange({ note: e.target.value })}
              data-testid={`work-note-${index}`}
            />
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={d.priority} onChange={(e) => onChange({ priority: e.target.checked })} className="h-5 w-5 accent-red-600" />
            Ưu tiên — cần làm trước
          </label>
        </>
      ) : null}
      {problem ? (
        <p className="mt-2 text-xs text-amber-800" data-testid={`work-problem-${index}`}>
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}

/* ------------------------------------------------------------------ *
 * "Các công việc trong ngày"
 * ------------------------------------------------------------------ */

export function WorkOrderTable({
  tasks,
  isLoading,
  isError,
  error,
  onRetry,
  onOpen,
  onReassign,
  canReassign,
  showBranch = false,
}: {
  tasks: RoomTask[];
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** "Chi tiết" — the item's full record (the board's own dialog). */
  onOpen?: (task: RoomTask) => void;
  /** "Giao lại" an item waiting for cleaning. */
  onReassign?: (task: RoomTask) => void;
  canReassign: boolean;
  showBranch?: boolean;
}) {
  const [area, setArea] = useState('');
  const [phase, setPhase] = useState<WorkPhase | ''>('');
  const [person, setPerson] = useState('');
  const areaGroups = useMemo(() => [...new Set(tasks.map((t) => groupOf(t)))].sort(), [tasks]);
  const people = useMemo(
    () => [...new Map(tasks.filter((t) => t.assignee).map((t) => [String(t.assignee!.id), t.assignee!.name])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'vi')),
    [tasks],
  );
  const shown = tasks.filter(
    (t) =>
      (!area || groupOf(t) === area) &&
      (!phase || t.phase === phase) &&
      (!person || (person === 'NONE' ? !t.assignee : String(t.assignee?.id) === person)),
  );

  const columns: DataColumn<RoomTask>[] = [
    ...(showBranch
      ? [{ key: 'branch', header: 'Chi nhánh', hideBelow: 'xl' as const, render: (t: RoomTask) => `CN ${t.branch.branchNumber}` }]
      : []),
    {
      key: 'area',
      header: 'Khu vực',
      className: 'min-w-[8rem] font-medium text-slate-900',
      render: (t) => (
        <>
          {areaOf(t)}
          {t.priority ? <span className="ml-1.5 rounded bg-red-600 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-white">Ưu tiên</span> : null}
        </>
      ),
    },
    { key: 'job', header: 'Việc cần làm', className: 'min-w-[7rem]', render: (t) => jobOf(t) },
    { key: 'phase', header: 'Trạng thái', className: 'whitespace-nowrap', render: (t) => <PhaseBadge task={t} /> },
    {
      key: 'person',
      header: 'Người thực hiện',
      className: 'min-w-[7rem]',
      render: (t) => (t.assignee ? t.assignee.name : <span className="text-slate-400">— Chưa có —</span>),
    },
    {
      key: 'note',
      header: 'Ghi chú',
      hideBelow: 'lg',
      coveredByDetail: true,
      className: 'min-w-[10rem] max-w-[24rem]',
      render: (t) => (t.note ? <span className="line-clamp-2 whitespace-pre-wrap">{t.note}</span> : <span className="text-slate-400">—</span>),
    },
  ];

  const select = 'min-h-[2.5rem] rounded-xl border border-line-strong bg-white px-3 py-1.5 text-sm text-slate-800';
  return (
    <div className="space-y-3" data-testid="work-orders">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc công việc">
        <select aria-label="Khu vực" className={select} value={area} onChange={(e) => setArea(e.target.value)} data-testid="work-filter-area">
          <option value="">Mọi khu vực</option>
          {areaGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select aria-label="Trạng thái" className={select} value={phase} onChange={(e) => setPhase(e.target.value as WorkPhase | '')} data-testid="work-filter-phase">
          <option value="">Mọi trạng thái</option>
          {WORK_PHASE_ORDER.map((p) => (
            <option key={p} value={p}>
              {PHASE_NAMES[p]}
            </option>
          ))}
        </select>
        <select aria-label="Người thực hiện" className={select} value={person} onChange={(e) => setPerson(e.target.value)} data-testid="work-filter-person">
          <option value="">Mọi nhân viên</option>
          <option value="NONE">Chưa có người nhận</option>
          {people.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <DataTable
        testId="work-orders-table"
        title="Các công việc trong ngày"
        badge={shown.length}
        columns={columns}
        rows={shown}
        rowKey={(t) => t.id}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={onRetry}
        emptyTitle={tasks.length === 0 ? 'Chưa có công việc nào trong ngày' : 'Không có công việc khớp bộ lọc'}
        emptyMessage={tasks.length === 0 ? 'Bấm “+ Tạo công việc” để giao việc cho buồng phòng.' : ''}
        detailToggle="always"
        multiExpand
        renderDetail={(t) => <WorkOrderDetail task={t} />}
        actions={(t) => (
          <span className="inline-flex flex-wrap justify-end gap-1">
            {canReassign && onReassign && t.phase === 'AWAITING_CLEANING' ? (
              <RowAction onClick={() => onReassign(t)} testId={`work-reassign-${t.id}`}>
                <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                Giao lại
              </RowAction>
            ) : null}
            {onOpen ? (
              <RowAction onClick={() => onOpen(t)} testId={`work-open-${t.id}`}>
                Chi tiết
              </RowAction>
            ) : null}
          </span>
        )}
      />
    </div>
  );
}

const PHASE_NAMES: Record<WorkPhase, string> = {
  UNCLAIMED: 'Chưa tiếp nhận',
  ACCEPTED: 'Đã tiếp nhận / Chờ kiểm tra',
  INSPECTING: 'Đang kiểm tra',
  AWAITING_CLEANING: 'Chờ dọn phòng',
  CLEANING: 'Đang dọn phòng',
  COMPLETED: 'Hoàn thành',
  VOIDED: 'Đã xóa',
};

/** The floor (or group) an item belongs to, for the "Khu vực" filter. */
function groupOf(t: RoomTask): string {
  return t.floor ? `Tầng ${t.floor}` : t.areaKind && t.areaKind !== 'ROOM' ? (t.areaKindLabel ?? 'Khu vực chung') : 'Phòng chưa xác định tầng';
}

/** The item in full: every instruction, and where the work stands. */
function WorkOrderDetail({ task: t }: { task: RoomTask }) {
  const fact = (label: string, value: string | null | undefined) => (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value || '—'}</dd>
    </div>
  );
  return (
    <div className="space-y-2" data-testid={`work-detail-${t.id}`}>
      {t.note ? (
        <p className="whitespace-pre-wrap rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <span className="font-semibold">Ghi chú / Hướng dẫn: </span>
          {t.note}
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {fact('Khu vực', areaOf(t))}
        {fact('Việc cần làm', jobOf(t))}
        {fact('Nhận việc', t.acceptedAt ? formatDateTime(t.acceptedAt) : null)}
        {fact('Bắt đầu kiểm tra', t.inspectionStartedAt ? formatDateTime(t.inspectionStartedAt) : null)}
        {fact('Kiểm tra xong', t.inspectedAt ? formatDateTime(t.inspectedAt) : null)}
        {fact('Bắt đầu dọn', t.startedAt ? formatDateTime(t.startedAt) : null)}
        {fact('Hoàn thành', t.completedAt ? formatDateTime(t.completedAt) : null)}
        {fact('Người tạo', t.createdByName)}
      </dl>
      {t.inspectionNote ? <p className="text-sm text-slate-700">Ghi nhận khi kiểm tra: {t.inspectionNote}</p> : null}
      {t.inspection && t.inspection.findings.length > 0 ? (
        <p className="text-sm text-slate-700">Tình trạng phòng: {t.inspection.findings.map((f) => f.typeLabel).join(', ')}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * "Giao lại"
 * ------------------------------------------------------------------ */

export function ReassignDialog({
  task,
  staff,
  onClose,
  onDone,
}: {
  task: RoomTask;
  staff: { id: number; fullName: string }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const others = staff.filter((s) => s.id !== task.assignee?.id);
  const name = others.find((s) => s.id === target)?.fullName ?? '';
  const save = useMutation({
    mutationFn: () => roomWorkApi.reassign(task.id, { assigneeUserId: target as number, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onDone(`Đã giao lại ${areaOf(task)} · ${jobOf(task)} cho ${name}.`);
    },
  });
  return (
    <Modal
      open
      title="Giao lại công việc"
      onClose={onClose}
      footer={
        confirming ? (
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={save.isPending}>
              Quay lại
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} data-testid="reassign-confirm">
              Xác nhận giao lại
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={target === ''} data-testid="reassign-next">
              Tiếp tục
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3" data-testid="reassign-dialog">
        <p className="text-sm text-slate-700">
          <span className="font-semibold">{areaOf(task)}</span> · {jobOf(task)} — đã kiểm tra, đang chờ dọn phòng.
          <span className="block">Người thực hiện hiện tại: {task.assignee?.name ?? '—'}</span>
        </p>
        {confirming ? (
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="reassign-summary">
            Giao <span className="font-semibold">{areaOf(task)} · {jobOf(task)}</span> từ{' '}
            <span className="font-semibold">{task.assignee?.name ?? '—'}</span> cho <span className="font-semibold">{name}</span>?
            {reason.trim() ? <span className="block">Lý do: {reason.trim()}</span> : null}
          </p>
        ) : (
          <>
            <label className={LABEL}>
              Giao cho
              <select className={FIELD} value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))} data-testid="reassign-target">
                <option value="">— Chọn nhân viên buồng phòng —</option>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Lý do (không bắt buộc)
              <textarea className={FIELD} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="reassign-reason" />
            </label>
          </>
        )}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
