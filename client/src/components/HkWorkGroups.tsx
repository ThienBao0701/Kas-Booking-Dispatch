/**
 * WORK GROUPS — "Công việc 1", "Công việc 2", … — the manager's side.
 *
 *   PlacePicker        one or more FLOOR SECTIONS ("Khu vực 1", "+ Thêm khu
 *                      vực"): each its own "Tầng / nhóm khu vực" and that
 *                      floor's rooms and areas as tiles. Under the tiles, one
 *                      compact line per picked place ("101 — OUT"), opened one
 *                      at a time for its "Việc cần làm" checkboxes (one of OUT /
 *                      OC / VC, and/or Khác) — and a note ONLY with "Khác"
 *                      (always for a shared area). Everything picked, on every
 *                      floor, is ONE group.
 *   CreateWorkDialog   "+ Tạo công việc": the optional group name on top, the
 *                      picker, a review, then ONE save for the whole group.
 *   WorkGroupCard      one numbered group: who holds it, then ONE ROW PER FLOOR
 *                      with that floor's places side by side as tiles — each
 *                      with what is to be done, who has it and where it stands.
 *   WorkGroupEditor    "Chỉnh sửa": name, who holds it, each place's codes (and
 *                      "Khác" note), take a place out (with confirmation), add
 *                      places on any floor.
 *   NoCleanReviewList  "Không cần dọn" requests waiting for the manager.
 *
 * The server checks every rule again (rooms of the branch, required notes, one
 * of OUT / OC / VC, who may do what, the state) — these screens only ask.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  ROOM_WORK_KEY,
  roomWorkApi,
  type RoomTask,
  type WorkAreas,
  type WorkGroup,
  type WorkTaskCode,
} from '../api/roomWork';
import { ApiError, toUserMessage } from '../api/errors';
import { formatDateTime } from '../lib/format';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { Modal } from './Modal';
import { QueryState } from './PageState';
import { PhaseBadge } from './HkWorkOrders';
import {
  codesLabel,
  needsNote,
  nextSection,
  noteProblem,
  openPlaceKeys,
  placeInput,
  placeName,
  placeProblem,
  placeText,
  placesByFloor,
  draftsByFloor,
  type FloorSection,
  type PlaceDraft,
} from '../lib/workPlaces';

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';
const LABEL = 'block text-sm font-medium text-slate-700';

const ROOM_CODES: WorkTaskCode[] = ['OUT', 'OC', 'VC'];
const ALL_CODES: WorkTaskCode[] = ['OUT', 'OC', 'VC', 'OTHER'];
const CODE_LABEL: Record<string, string> = { OUT: 'OUT', OC: 'OC', VC: 'VC', OTHER: 'Khác' };
const UNPLACED = '__unplaced__';
const ROOFTOP = '__rooftop__';

/** One of OUT / OC / VC at most — ticking one clears the other two; "Khác" stands alone. */
function toggleCode(codes: WorkTaskCode[], code: WorkTaskCode): WorkTaskCode[] {
  if (codes.includes(code)) return codes.filter((c) => c !== code);
  const kept = ROOM_CODES.includes(code) ? codes.filter((c) => !ROOM_CODES.includes(c)) : codes;
  return [...kept, code].sort((a, b) => ALL_CODES.indexOf(a) - ALL_CODES.indexOf(b));
}

/** The floor groups of the branch, as the selector offers them. */
function groupOptions(areas: WorkAreas): { value: string; label: string }[] {
  return [
    ...areas.floors.map((f) => ({ value: f.floor, label: f.label })),
    ...(areas.hasRooftop ? [{ value: ROOFTOP, label: areas.rooftopLabel ?? 'Rooftop' }] : []),
    ...(areas.unplacedRooms.length > 0 ? [{ value: UNPLACED, label: areas.unplacedLabel }] : []),
  ];
}

/** The tiles of one floor group: its rooms, then the shared areas (a real floor only). */
function tilesOf(areas: WorkAreas, group: string, section: number): PlaceDraft[] {
  const blank = { codes: [] as WorkTaskCode[], note: '', section };
  if (group === ROOFTOP) {
    const label = areas.rooftopLabel ?? 'Rooftop';
    return [{ ...blank, key: 'ROOFTOP', areaKind: 'ROOFTOP', groupLabel: label, label }];
  }
  if (group === UNPLACED) {
    return areas.unplacedRooms.map((r) => ({ ...blank, key: `ROOM:${r}`, areaKind: 'ROOM', roomNumber: r, groupLabel: areas.unplacedLabel, label: `Phòng ${r}` }));
  }
  const floor = areas.floors.find((f) => f.floor === group);
  if (!floor) return [];
  return [
    ...floor.rooms.map((r) => ({ ...blank, key: `ROOM:${r}`, areaKind: 'ROOM' as const, roomNumber: r, groupLabel: floor.label, label: `Phòng ${r}` })),
    ...areas.sharedAreas.map((a) => ({ ...blank, key: `${a.kind}:${floor.floor}`, areaKind: a.kind, floor: floor.floor, groupLabel: floor.label, label: a.label })),
  ];
}

/* ------------------------------------------------------------------ *
 * "Lý do / việc cần làm (Khác)" — with its own "Xác nhận"
 * ------------------------------------------------------------------ */

/**
 * The reason and its "Xác nhận" in ONE framed box: the text above, the button
 * at its bottom-right, never over the text. "Xác nhận" marks the reason as
 * checked IN THE DRAFT — nothing is saved before the whole form is — and any
 * edit afterwards asks for it again. The state is announced to screen readers.
 */
function ConfirmedNote({
  id,
  value,
  confirmed,
  placeholder,
  disabled = false,
  onChange,
  onConfirm,
}: {
  id: string;
  value: string;
  confirmed: boolean;
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onConfirm: () => void;
}) {
  const problem = noteProblem(value);
  const statusId = `${id}-status`;
  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        Lý do / việc cần làm (Khác) <span className="text-red-600">*</span>
      </label>
      <div
        className={`mt-1 rounded-xl border bg-white focus-within:ring-2 focus-within:ring-brand-600 ${confirmed ? 'border-green-600' : 'border-line-strong hover:border-slate-600'}`}
        data-testid={`${id}-box`}
      >
        <textarea
          id={id}
          rows={2}
          maxLength={1000}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-describedby={statusId}
          className="block w-full resize-y rounded-t-xl border-0 bg-transparent px-3 pt-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:text-slate-500"
          data-testid={id}
        />
        <div className="flex flex-wrap items-center justify-end gap-2 px-2 pb-2 pt-1">
          <span id={statusId} aria-live="polite" className={`mr-auto inline-flex items-center gap-1 px-1 text-xs ${confirmed ? 'font-semibold text-green-700' : 'text-slate-500'}`} data-testid={`${id}-state`}>
            {confirmed ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Đã xác nhận
              </>
            ) : value.trim() ? (
              (problem ?? 'Chưa xác nhận')
            ) : (
              'Nhập lý do rồi bấm “Xác nhận”.'
            )}
          </span>
          {confirmed ? null : (
            <button
              type="button"
              onClick={onConfirm}
              disabled={disabled || problem !== null}
              className="inline-flex min-h-[2.25rem] items-center gap-1 rounded-lg bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-300"
              data-testid={`${id}-confirm`}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Xác nhận
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * PlacePicker
 * ------------------------------------------------------------------ */

export function PlacePicker({
  areas,
  sections,
  onSections,
  value,
  onChange,
  taken = new Set<string>(),
}: {
  areas: WorkAreas;
  sections: FloorSection[];
  onSections: (next: FloorSection[]) => void;
  value: PlaceDraft[];
  onChange: (next: PlaceDraft[]) => void;
  /**
   * Places with an OPEN item today (keys as the tiles: "ROOM:101", "HALLWAY:5",
   * "ROOFTOP") — in this group or another: not offered. They come back once
   * their work is resolved. (The server checks again when the group is saved.)
   */
  taken?: ReadonlySet<string>;
}) {
  // One place's details open at a time; every value stays in `value` either way.
  const [open, setOpen] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const picked = new Set(value.map((d) => d.key));
  const options = groupOptions(areas);
  const patch = (key: string, next: Partial<PlaceDraft>) => onChange(value.map((d) => (d.key === key ? { ...d, ...next } : d)));
  const toggle = (tile: PlaceDraft) => {
    if (picked.has(tile.key)) {
      onChange(value.filter((d) => d.key !== tile.key));
      if (open === tile.key) setOpen(null);
    } else {
      onChange([...value, tile]);
      setOpen(tile.key);
    }
  };
  const removeSection = (key: number) => {
    onChange(value.filter((d) => d.section !== key));
    onSections(sections.filter((s) => s.key !== key));
    setConfirmRemove(null);
  };

  return (
    <div className="space-y-4" data-testid="place-sections">
      {sections.map((sec, i) => {
        const mine = value.filter((d) => d.section === sec.key);
        const usedElsewhere = new Set(sections.filter((s) => s.key !== sec.key).map((s) => s.group).filter(Boolean));
        const allTiles = sec.group ? tilesOf(areas, sec.group, sec.key) : [];
        const tiles = allTiles.filter((tile) => !taken.has(tile.key));
        const held = allTiles.length - tiles.length;
        const selectId = `place-floor-${i}`;
        return (
          <fieldset key={sec.key} className="min-w-0 rounded-xl border border-line bg-white p-3" data-testid={`place-section-${i}`}>
            <legend className="flex min-h-[1.75rem] w-full flex-wrap items-center justify-between gap-2 px-1 text-sm font-semibold text-slate-900">
              <span>
                Khu vực {i + 1}
                {sec.group ? ` — ${options.find((o) => o.value === sec.group)?.label ?? ''}` : ''}
              </span>
              {sections.length > 1 ? (
                <button
                  type="button"
                  onClick={() => (mine.length > 0 ? setConfirmRemove(sec.key) : removeSection(sec.key))}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  data-testid={`place-section-remove-${i}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Bỏ khu vực
                </button>
              ) : null}
            </legend>
            {confirmRemove === sec.key ? (
              <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid={`place-section-confirm-${i}`}>
                <p>
                  Bỏ khu vực này sẽ bỏ {mine.length} phòng / khu vực đã chọn ({mine.map((d) => d.label).join(', ')}) cùng việc cần làm và ghi chú của chúng.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
                    Giữ lại
                  </Button>
                  <Button variant="danger" onClick={() => removeSection(sec.key)} data-testid={`place-section-remove-confirm-${i}`}>
                    Bỏ khu vực
                  </Button>
                </div>
              </div>
            ) : null}
            <label className={LABEL} htmlFor={selectId}>
              Tầng / nhóm khu vực
              <select
                id={selectId}
                className={FIELD}
                value={sec.group}
                disabled={mine.length > 0}
                onChange={(e) => onSections(sections.map((s) => (s.key === sec.key ? { ...s, group: e.target.value } : s)))}
                data-testid={selectId}
              >
                <option value="">— Chọn tầng —</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value} disabled={usedElsewhere.has(o.value)}>
                    {o.label}
                    {usedElsewhere.has(o.value) ? ' (đã có ở khu vực khác)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {/* Always the same one line once a floor is chosen, so the tiles below never move. */}
            {sec.group ? (
              <p className="mt-1 text-xs text-slate-500">
                {mine.length > 0 ? 'Bỏ chọn hết phòng của khu vực này để đổi tầng.' : 'Có thể đổi tầng cho đến khi chọn phòng.'}
              </p>
            ) : null}

            {sec.group ? (
              <div className="mt-3" role="group" aria-label={`Chọn phòng / khu vực — Khu vực ${i + 1}`}>
                <p className="mb-2 text-sm font-medium text-slate-700">Chọn phòng / khu vực (chọn được nhiều)</p>
                {held > 0 ? (
                  <p className="mb-2 text-xs text-slate-500" data-testid={`place-held-${i}`}>
                    {tiles.length === 0
                      ? 'Mọi phòng / khu vực của tầng này đang có công việc chưa xong — chọn tầng khác.'
                      : `${held} phòng / khu vực đang có công việc chưa xong nên không hiện ở đây.`}
                  </p>
                ) : null}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2" data-testid={`place-tiles-${i}`}>
                  {tiles.map((tile) => {
                    const on = picked.has(tile.key);
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(tile)}
                        className={`flex min-h-[2.75rem] items-center justify-center gap-1 rounded-xl border-2 px-2 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-40 ${
                          on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-800 hover:border-slate-500'
                        }`}
                        data-testid={`place-tile-${tile.key}`}
                      >
                        {on ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                        <span className="truncate">{tile.areaKind === 'ROOM' ? tile.roomNumber : tile.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Chọn tầng để xem các phòng và khu vực.</p>
            )}

            {mine.length > 0 ? (
              <ul className="mt-3 divide-y divide-line-subtle rounded-lg border border-line-subtle" data-testid={`place-rows-${i}`}>
                {mine.map((d) => (
                  <PlaceRow
                    key={d.key}
                    draft={d}
                    blocked={taken.has(d.key)}
                    open={open === d.key}
                    onToggle={() => setOpen(open === d.key ? null : d.key)}
                    onChange={(next) => patch(d.key, next)}
                    onRemove={() => toggle(d)}
                  />
                ))}
              </ul>
            ) : null}
          </fieldset>
        );
      })}
      <Button variant="secondary" onClick={() => onSections([...sections, nextSection(sections)])} data-testid="place-add-section">
        <Plus className="h-4 w-4" aria-hidden="true" />
        Thêm khu vực
      </Button>
    </div>
  );
}

/**
 * One picked place as a single line — "101 — OUT", or what it still needs — and,
 * when opened, ITS details only: the codes, and the note when "Khác" asks one.
 */
function PlaceRow({
  draft: d,
  blocked = false,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  draft: PlaceDraft;
  /** Taken by another group since it was picked: it must be removed. */
  blocked?: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (next: Partial<PlaceDraft>) => void;
  onRemove: () => void;
}) {
  const problem = blocked ? 'Vừa có công việc khác nhận nơi này — bỏ chọn.' : placeProblem(d);
  const noteId = `place-note-${d.key}`;
  const detailId = `place-detail-${d.key}`;
  return (
    <li className="px-2.5 py-2" data-testid={`place-row-${d.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm">
          <span className="font-semibold text-slate-900">{d.label}</span>
          <span className="text-slate-600"> — {d.areaKind === 'ROOM' ? codesLabel(d.codes) || 'chưa chọn việc' : 'Khác'}</span>
          {problem ? (
            <span className="ml-2 text-xs font-medium text-amber-800" data-testid={`place-problem-${d.key}`}>
              {problem}
            </span>
          ) : null}
        </p>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={detailId}
            className="inline-flex min-h-[2.25rem] items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            data-testid={`place-open-${d.key}`}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {open ? 'Thu gọn' : 'Mở chi tiết'}
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Bỏ chọn ${d.label}`}
            className="inline-flex min-h-[2.25rem] items-center rounded-lg px-2 text-xs font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            data-testid={`place-remove-${d.key}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {open ? (
        <div id={detailId} className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2.5" data-testid={detailId}>
          {d.areaKind === 'ROOM' ? (
            <div role="group" aria-label={`Việc cần làm — ${d.label}`} className="flex flex-wrap gap-2">
              {ALL_CODES.map((code) => (
                <label
                  key={code}
                  className={`inline-flex min-h-[2.5rem] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                    d.codes.includes(code) ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={d.codes.includes(code)}
                    onChange={() => onChange({ codes: toggleCode(d.codes, code) })}
                    data-testid={`place-code-${d.key}-${code}`}
                  />
                  {CODE_LABEL[code]}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-600">Việc cần làm: Khác — ghi rõ lý do / việc cần làm.</p>
          )}
          {needsNote(d) ? (
            <ConfirmedNote
              id={noteId}
              value={d.note}
              confirmed={Boolean(d.noteConfirmed)}
              placeholder={d.areaKind === 'ROOM' ? 'Ví dụ: Thay rèm cửa sổ' : 'Ví dụ: Lau sàn, gom rác'}
              onChange={(note) => onChange({ note, noteConfirmed: false })}
              onConfirm={() => onChange({ note: d.note.trim(), noteConfirmed: true })}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The day's items of the branch — shared with the board's own query. */
function useDayTasks(branchId: number, date: string) {
  return useQuery({
    queryKey: [...ROOM_WORK_KEY, 'tasks', date, branchId],
    queryFn: () => roomWorkApi.tasks({ date, branchId }),
  });
}

function useAreas(branchId: number) {
  return useQuery({
    queryKey: [...ROOM_WORK_KEY, 'areas', branchId],
    queryFn: () => roomWorkApi.areas({ branchId }),
    staleTime: 5 * 60_000,
  });
}

/** The review line of a place, under its floor: "Phòng 101 — OUT + Khác". */
function reviewLine(d: PlaceDraft): string {
  const what = d.areaKind === 'ROOM' ? codesLabel(d.codes) : 'Khác';
  return `${d.label} — ${what}`;
}

/* ------------------------------------------------------------------ *
 * "+ Tạo công việc"
 * ------------------------------------------------------------------ */

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
  const areas = useAreas(branchId);
  // The day's items — the same list as the board's — say which places are still open.
  const day = useDayTasks(branchId, date);
  const taken = useMemo(() => openPlaceKeys(day.data?.tasks ?? []), [day.data]);
  const [name, setName] = useState('');
  // The draft lives here, not in the picker: the review and back keep every value.
  const [sections, setSections] = useState<FloorSection[]>([{ key: 1, group: '' }]);
  const [places, setPlaces] = useState<PlaceDraft[]>([]);
  const [reviewing, setReviewing] = useState(false);
  // One id per dialog: a double click, or a retry after a lost answer, creates one group.
  const requestId = useRef(newRequestId());
  const ready = places.length > 0 && places.every((p) => placeProblem(p) === null && !taken.has(p.key));
  const save = useMutation({
    mutationFn: () =>
      roomWorkApi.createWorkGroup({
        branchId,
        workDate: date,
        requestId: requestId.current,
        ...(name.trim() ? { name: name.trim() } : {}),
        items: places.map(placeInput),
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onCreated(r.duplicate ? `${r.group.title} đã được lưu trước đó.` : `Đã tạo ${r.group.title} (${r.group.counts.items} phòng / khu vực).`);
    },
    // Another manager took a place first: reload which places are open, so the form shows it.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void day.refetch();
    },
  });
  const a = areas.data?.areas;
  // In section order: the review reads like the form.
  const ordered = sections.flatMap((s) => places.filter((p) => p.section === s.key));
  const groups = [...new Set(ordered.map((p) => p.groupLabel))];

  return (
    <Modal
      open
      size="4xl"
      anchor="top"
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
              Lưu công việc
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Hủy
            </Button>
            <Button onClick={() => setReviewing(true)} disabled={!ready} data-testid="work-review">
              Xem lại ({places.length})
            </Button>
          </>
        )
      }
    >
      <QueryState
        isLoading={areas.isLoading || day.isLoading}
        isError={areas.isError || day.isError}
        error={areas.error ?? day.error}
        onRetry={() => {
          void areas.refetch();
          void day.refetch();
        }}
      >
        {a ? (
          reviewing ? (
            <div className="space-y-3" data-testid="work-review-list">
              <p className="text-sm text-slate-700">
                <span className="font-semibold">Tên công việc:</span> {name.trim() || <span className="text-slate-500">(không đặt tên)</span>}
              </p>
              <p className="text-sm text-slate-700">
                <span className="font-semibold">Tầng / khu vực:</span> {groups.join(', ')}
              </p>
              {draftsByFloor(ordered).map((floor) => (
                <section key={floor.heading} className="overflow-hidden rounded-xl border border-line" data-testid={`work-review-floor-${floor.heading}`}>
                  <h3 className="border-b border-line-subtle bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-900">{floor.heading}</h3>
                  <ul className="divide-y divide-line-subtle">
                    {floor.places.map((p) => (
                      <li key={p.key} className="px-3 py-2 text-sm">
                        <p className="font-medium text-slate-900">{reviewLine(p)}</p>
                        {needsNote(p) && p.note.trim() ? <p className="mt-0.5 whitespace-pre-wrap text-slate-600">Ghi chú: {p.note.trim()}</p> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <p className="text-xs text-slate-500">Một công việc, giao và nhận cùng nhau; mỗi phòng / khu vực vẫn được kiểm tra và dọn riêng.</p>
              {save.isError ? (
                <ErrorAlert>
                  {toUserMessage(save.error)}{' '}
                  {/* Only a real conflict means another group took a place: the list was reloaded for it. */}
                  {save.error instanceof ApiError && save.error.status === 409
                    ? 'Bấm “Sửa lại” để chọn lại — danh sách phòng đã được tải lại.'
                    : 'Công việc chưa được lưu. Bấm “Lưu công việc” để thử lại.'}
                </ErrorAlert>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <label className={LABEL} htmlFor="work-name">
                Tên công việc (không bắt buộc)
                <input
                  id="work-name"
                  className={FIELD}
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ví dụ: Tổng vệ sinh buổi sáng"
                  data-testid="work-name"
                />
              </label>
              <PlacePicker areas={a} sections={sections} onSections={setSections} value={places} onChange={setPlaces} taken={taken} />
            </div>
          )
        ) : null}
      </QueryState>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * The numbered group card
 * ------------------------------------------------------------------ */

export function CodeChips({ task: t }: { task: RoomTask }) {
  const codes = t.taskCodes && t.taskCodes.length > 0 ? t.taskCodes : [t.statusCode];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {codes.map((c) => (
        <span key={c} className="rounded-md bg-slate-800 px-1.5 py-0.5 text-xs font-bold text-white">
          {CODE_LABEL[c] ?? c}
        </span>
      ))}
    </span>
  );
}

/** "Không cần dọn" — where the request stands, for everyone who sees the place. */
function NoCleanLine({ task: t }: { task: RoomTask }) {
  if (!t.noClean) return null;
  if (t.noClean.status === 'PENDING') {
    return <p className="text-xs font-medium text-amber-800">Chờ quản lý duyệt không cần dọn · Lý do: {t.noClean.reason}</p>;
  }
  if (t.noClean.status === 'REJECTED') {
    return (
      <p className="text-xs text-slate-600">
        Quản lý từ chối không cần dọn{t.noClean.decisionNote ? ` · ${t.noClean.decisionNote}` : ''} — tiếp tục dọn.
      </p>
    );
  }
  return <p className="text-xs text-slate-600">Không cần dọn · Lý do: {t.noClean.reason}</p>;
}

export function WorkGroupCard({
  group,
  onEdit,
  headerAction,
  itemAction,
}: {
  group: WorkGroup;
  /** "Chỉnh sửa" — the manager's. */
  onEdit?: () => void;
  /** Beside the title — the housekeeper's "Nhận công việc", for one. */
  headerAction?: ReactNode;
  /** Under a place — the housekeeper's next step on its own room. */
  itemAction?: (task: RoomTask) => ReactNode;
}) {
  const liveItems = group.items.filter((t) => !t.voided);
  const closed = group.items.filter((t) => t.voided);
  // The owner is said ONCE, in the header. A tile names its person only when the
  // room went to someone else (a re-clean given to another housekeeper).
  const ownerId = group.assignee?.id ?? null;
  return (
    <article className="rounded-2xl border border-line-subtle bg-white shadow-sm" data-testid={`group-card-${group.number}`} aria-labelledby={`group-title-${group.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 id={`group-title-${group.id}`} className="text-base font-bold text-slate-900">
            {group.title}
            {group.name ? <span className="font-semibold text-slate-700"> — {group.name}</span> : null}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-slate-700" data-testid={`group-assignee-${group.number}`}>
            <span>
              Người thực hiện:{' '}
              {group.assignee ? <span className="font-semibold text-slate-900">{group.assignee.name}</span> : <span className="text-slate-500">Chưa giao</span>}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{group.status.label}</span>
          </p>
          {group.floors.length > 0 ? <p className="mt-0.5 text-sm text-slate-600">{group.floors.join(' · ')}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {headerAction}
          {onEdit ? (
            <Button variant="secondary" onClick={onEdit} data-testid={`group-edit-${group.number}`} aria-label={`Chỉnh sửa ${group.title}`}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Chỉnh sửa
            </Button>
          ) : null}
        </div>
      </header>
      <div className="space-y-3 px-4 py-3">
        {placesByFloor(liveItems).map((floor, i) => (
          <section key={floor.heading} aria-label={`${group.title} — ${floor.heading}`} data-testid={`group-floor-${group.number}-${i}`}>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{floor.heading}</h4>
            {/* One floor, one row: compact tiles side by side, wrapping only when the row is full. */}
            <ul className="flex flex-wrap items-start gap-2" data-testid={`group-floor-row-${group.number}-${i}`}>
              {floor.tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex w-[calc(50%-0.25rem)] min-w-0 flex-col gap-1 rounded-lg border border-line-subtle bg-slate-50/60 px-2.5 py-2 sm:w-44"
                  data-testid={`group-item-${t.id}`}
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-slate-900">
                    <span className="break-words">{placeName(t)}</span>
                    <CodeChips task={t} />
                    {t.priority ? <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Ưu tiên</span> : null}
                  </p>
                  {t.reclean ? <span className="w-fit rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">Cần dọn lại</span> : null}
                  <div>
                    <PhaseBadge task={t} />
                  </div>
                  {t.assignee && t.assignee.id !== ownerId ? (
                    <p className="text-xs text-slate-600" data-testid={`group-item-person-${t.id}`}>
                      Người làm: {t.assignee.name}
                    </p>
                  ) : null}
                  {t.note ? <p className="line-clamp-2 whitespace-pre-wrap text-xs text-slate-600" title={t.note}>Ghi chú: {t.note}</p> : null}
                  <NoCleanLine task={t} />
                  {itemAction ? <div className="flex flex-col gap-1 pt-0.5 [&>button]:min-h-[2.25rem] [&>button]:w-full">{itemAction(t)}</div> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {closed.length > 0 ? (
        <p className="border-t border-line-subtle px-4 py-2 text-xs text-slate-500" data-testid={`group-closed-${group.number}`}>
          {closed.map((t) => `${placeText(t)}: ${t.phase === 'NO_CLEAN' ? 'Không cần dọn' : 'Đã bỏ khỏi công việc'}`).join(' · ')}
        </p>
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * "Chỉnh sửa"
 * ------------------------------------------------------------------ */

export function WorkGroupEditor({
  group,
  staff,
  onClose,
  onChanged,
}: {
  group: WorkGroup;
  staff: { id: number; fullName: string }[];
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const areas = useAreas(group.branchId);
  const [current, setCurrent] = useState(group);
  const [name, setName] = useState(group.name ?? '');
  const [person, setPerson] = useState<number | ''>(group.assignee?.id ?? '');
  const [adding, setAdding] = useState<PlaceDraft[]>([]);
  const [addSections, setAddSections] = useState<FloorSection[]>([{ key: 1, group: '' }]);
  const [removing, setRemoving] = useState<RoomTask | null>(null);
  const done = async (next: WorkGroup, message: string) => {
    setCurrent(next);
    await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
    onChanged(message);
  };
  const rename = useMutation({
    mutationFn: () => roomWorkApi.renameWorkGroup(current.id, name.trim() || null),
    onSuccess: ({ group: next }) => done(next, 'Đã lưu tên công việc.'),
  });
  const assign = useMutation({
    mutationFn: () => roomWorkApi.assignWorkGroup(current.id, person === '' ? null : person),
    onSuccess: ({ group: next }) => done(next, next.assignee ? `Đã giao ${next.title} cho ${next.assignee.name}.` : `${next.title}: chưa giao.`),
  });
  const add = useMutation({
    mutationFn: () => roomWorkApi.addWorkGroupItems(current.id, adding.map(placeInput)),
    onSuccess: async ({ group: next }) => {
      setAdding([]);
      setAddSections([{ key: 1, group: '' }]);
      await done(next, `Đã thêm vào ${next.title}.`);
    },
    onError: () => void day.refetch(),
  });
  const liveItems = current.items.filter((t) => !t.voided);
  // Open places: this group's own, and every other group's of the day.
  const day = useDayTasks(current.branchId, current.workDate);
  const taken = useMemo(() => openPlaceKeys([...current.items, ...(day.data?.tasks ?? [])]), [current.items, day.data]);
  const addReady = adding.length > 0 && adding.every((p) => placeProblem(p) === null && !taken.has(p.key));
  const reload = async () => {
    const { groups } = await roomWorkApi.workGroups({ date: current.workDate, branchId: current.branchId });
    const next = groups.find((g) => g.id === current.id);
    if (next) setCurrent(next);
    await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
  };

  return (
    <Modal open size="4xl" anchor="top" title={`Chỉnh sửa ${current.title}`} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Đóng</Button>}>
      <div className="space-y-5" data-testid="group-editor">
        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="group-name">
              Tên công việc (không bắt buộc)
              <input id="group-name" className={FIELD} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="group-name" />
            </label>
            <Button className="mt-2" variant="secondary" onClick={() => rename.mutate()} loading={rename.isPending} disabled={(name.trim() || null) === current.name} data-testid="group-name-save">
              Lưu tên
            </Button>
            {rename.isError ? <ErrorAlert>{toUserMessage(rename.error)}</ErrorAlert> : null}
          </div>
          <div>
            <label className={LABEL} htmlFor="group-assignee">
              Người thực hiện (cả công việc)
              <select
                id="group-assignee"
                className={FIELD}
                value={person}
                onChange={(e) => setPerson(e.target.value === '' ? '' : Number(e.target.value))}
                data-testid="group-assignee"
              >
                <option value="">— Chưa giao —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </select>
            </label>
            <Button className="mt-2" variant="secondary" onClick={() => assign.mutate()} loading={assign.isPending} disabled={(person === '' ? null : person) === (current.assignee?.id ?? null)} data-testid="group-assign-save">
              Lưu người thực hiện
            </Button>
            {assign.isError ? <ErrorAlert>{toUserMessage(assign.error)}</ErrorAlert> : null}
            <p className="mt-1 text-xs text-slate-500">Danh sách gồm nhân viên đã vào ca tại chi nhánh này trong 30 ngày gần đây.</p>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">Phòng / khu vực trong công việc</h3>
          {liveItems.length === 0 ? <p className="text-sm text-slate-500">Công việc này không còn phòng / khu vực nào.</p> : null}
          {liveItems.map((t) => (
            <ItemEditor key={t.id} task={t} onSaved={reload} onRemove={() => setRemoving(t)} />
          ))}
          {current.items.some((t) => t.voided) ? (
            <p className="text-xs text-slate-500">
              Đã bỏ / không cần dọn: {current.items.filter((t) => t.voided).map((t) => placeText(t)).join(', ')} (vẫn giữ trong lịch sử).
            </p>
          ) : null}
        </section>

        <section className="space-y-3 rounded-xl border border-dashed border-line-strong p-3" data-testid="group-add">
          <h3 className="text-sm font-semibold text-slate-900">Thêm phòng / khu vực</h3>
          <QueryState isLoading={areas.isLoading} isError={areas.isError} error={areas.error} onRetry={() => void areas.refetch()}>
            {areas.data ? <PlacePicker areas={areas.data.areas} sections={addSections} onSections={setAddSections} value={adding} onChange={setAdding} taken={taken} /> : null}
          </QueryState>
          {add.isError ? <ErrorAlert>{toUserMessage(add.error)}</ErrorAlert> : null}
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!addReady} data-testid="group-add-save">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Thêm vào công việc ({adding.length})
          </Button>
        </section>
      </div>
      {removing ? (
        <RemoveItemDialog
          task={removing}
          group={current}
          onClose={() => setRemoving(null)}
          onRemoved={async () => {
            setRemoving(null);
            await reload();
            onChanged(`Đã bỏ ${placeText(removing)} khỏi ${current.title}.`);
          }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * One place of the group: its own codes — and its note only while "Khác" asks
 * for one (always for a shared area). Unticking "Khác" hides the note and sends
 * nothing for it: what was stored stays on the record.
 */
function ItemEditor({ task: t, onSaved, onRemove }: { task: RoomTask; onSaved: () => Promise<void>; onRemove: () => void }) {
  const initial = (t.taskCodes && t.taskCodes.length > 0 ? t.taskCodes : [t.statusCode]) as WorkTaskCode[];
  const [codes, setCodes] = useState<WorkTaskCode[]>(initial);
  const [note, setNote] = useState(t.note ?? '');
  // The note on record counts as confirmed; a new or edited one is confirmed again.
  const [confirmedNote, setConfirmedNote] = useState<string | null>(t.note ? t.note : null);
  const isRoom = t.areaKind === 'ROOM' || !t.areaKind;
  const withNote = needsNote({ areaKind: t.areaKind ?? 'ROOM', codes });
  const locked = t.state === 'COMPLETED';
  const confirmed = confirmedNote !== null && confirmedNote === note && noteProblem(note) === null;
  const changed = codes.join() !== initial.join() || (withNote && note !== (t.note ?? ''));
  const save = useMutation({
    mutationFn: () => roomWorkApi.updateTask(t.id, { ...(isRoom ? { taskCodes: codes } : {}), ...(withNote ? { note: note.trim() || null } : {}) }),
    onSuccess: () => onSaved(),
  });
  const problem =
    isRoom && codes.length === 0
      ? 'Chọn việc cần làm.'
      : withNote && !note.trim()
        ? isRoom
          ? '"Khác" cần ghi rõ lý do / việc cần làm.'
          : 'Khu vực này cần ghi rõ việc cần làm.'
        : withNote && noteProblem(note)
          ? noteProblem(note)
          : withNote && !confirmed
            ? 'Bấm “Xác nhận” lý do (Khác) trước khi lưu.'
            : null;
  const removable = t.state === 'NOT_STARTED' || t.state === 'INSPECTED';
  return (
    <div className="rounded-xl border border-line p-3" data-testid={`item-editor-${t.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">
          {placeText(t)} <PhaseBadge task={t} />
        </p>
        <Button
          variant="ghost"
          onClick={onRemove}
          disabled={!removable || t.noClean?.status === 'PENDING'}
          title={removable ? undefined : 'Phòng đang được dọn hoặc đã xong — không bỏ được'}
          data-testid={`item-remove-${t.id}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Bỏ khỏi công việc
        </Button>
      </div>
      {isRoom ? (
        <div role="group" aria-label={`Việc cần làm — ${placeText(t)}`} className="mt-2 flex flex-wrap gap-2">
          {ALL_CODES.map((code) => (
            <label key={code} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={codes.includes(code)}
                disabled={locked}
                onChange={() => setCodes(toggleCode(codes, code))}
                data-testid={`item-code-${t.id}-${code}`}
              />
              {CODE_LABEL[code]}
            </label>
          ))}
        </div>
      ) : null}
      {withNote ? (
        <div className="mt-2">
          <ConfirmedNote
            id={`item-note-${t.id}`}
            value={note}
            confirmed={confirmed}
            disabled={locked}
            onChange={setNote}
            onConfirm={() => {
              setNote(note.trim());
              setConfirmedNote(note.trim());
            }}
          />
        </div>
      ) : null}
      {problem ? <p className="mt-1 text-xs text-amber-800">{problem}</p> : null}
      {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      <Button className="mt-2" variant="secondary" onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || problem !== null} data-testid={`item-save-${t.id}`}>
        Lưu phòng này
      </Button>
    </div>
  );
}

/** "Bỏ khỏi công việc" — confirmed; the room stays in the catalog and the item in the history. */
function RemoveItemDialog({ task: t, group, onClose, onRemoved }: { task: RoomTask; group: WorkGroup; onClose: () => void; onRemoved: () => void }) {
  const [reason, setReason] = useState('');
  const held = t.assignee !== null || t.state !== 'NOT_STARTED';
  const remove = useMutation({ mutationFn: () => roomWorkApi.voidTask(t.id, reason.trim() || undefined), onSuccess: onRemoved });
  return (
    <Modal
      open
      title="Bỏ khỏi công việc"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Hủy
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending} disabled={held && !reason.trim()} data-testid="item-remove-confirm">
            Bỏ {placeText(t)}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="item-remove-dialog">
        <p className="text-sm text-slate-700">
          Bỏ <span className="font-semibold">{placeText(t)}</span> khỏi <span className="font-semibold">{group.title}</span>? Phòng vẫn còn trong danh sách phòng của chi nhánh;
          công việc đã ghi vẫn được giữ trong lịch sử.
        </p>
        <label className={LABEL}>
          Lý do{held ? ' *' : ' (không bắt buộc)'}
          <textarea className={FIELD} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="item-remove-reason" />
        </label>
        {remove.isError ? <ErrorAlert>{toUserMessage(remove.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * "Không cần dọn" — the manager's review
 * ------------------------------------------------------------------ */

export function NoCleanReviewList({ items, onDecided }: { items: RoomTask[]; onDecided: (message: string) => void }) {
  const [deciding, setDeciding] = useState<{ task: RoomTask; approve: boolean } | null>(null);
  if (items.length === 0) return <p className="py-2 text-sm text-slate-500">Không có yêu cầu nào đang chờ duyệt.</p>;
  return (
    <>
      <ul className="space-y-2" data-testid="no-clean-list">
        {items.map((t) => (
          <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2" data-testid={`no-clean-${t.id}`}>
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-slate-900">
                {t.workGroup ? `Công việc ${t.workGroup.number} · ` : ''}
                {placeText(t)}
              </p>
              <p className="text-amber-950">Lý do: {t.noClean?.reason}</p>
              <p className="text-xs text-slate-600">
                {t.noClean?.requestedByName ?? '—'}
                {t.noClean?.requestedAt ? ` · ${formatDateTime(t.noClean.requestedAt)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" onClick={() => setDeciding({ task: t, approve: false })} data-testid={`no-clean-reject-${t.id}`}>
                Từ chối
              </Button>
              <Button onClick={() => setDeciding({ task: t, approve: true })} data-testid={`no-clean-approve-${t.id}`}>
                Duyệt
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {deciding ? (
        <NoCleanDecisionDialog
          task={deciding.task}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onDone={(message) => {
            setDeciding(null);
            onDecided(message);
          }}
        />
      ) : null}
    </>
  );
}

function NoCleanDecisionDialog({ task: t, approve, onClose, onDone }: { task: RoomTask; approve: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: () => roomWorkApi.decideNoClean(t.id, approve, note.trim() || undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROOM_WORK_KEY });
      onDone(approve ? `Đã duyệt không cần dọn: ${placeText(t)}.` : `Đã từ chối — ${placeText(t)} tiếp tục được dọn.`);
    },
  });
  return (
    <Modal
      open
      title={approve ? 'Duyệt không cần dọn' : 'Từ chối không cần dọn'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={decide.isPending}>
            Hủy
          </Button>
          <Button variant={approve ? 'primary' : 'danger'} onClick={() => decide.mutate()} loading={decide.isPending} data-testid="no-clean-decision-confirm">
            {approve ? 'Duyệt' : 'Từ chối'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="no-clean-decision">
        <p className="text-sm text-slate-700">
          {placeText(t)} — lý do của nhân viên: <span className="font-semibold">{t.noClean?.reason}</span>
        </p>
        <p className="text-sm text-slate-600">
          {approve
            ? 'Duyệt: phòng ra khỏi công việc đang làm hôm nay; yêu cầu và quyết định vẫn được giữ trong lịch sử.'
            : 'Từ chối: phòng quay lại công việc, nhân viên được báo để tiếp tục dọn.'}
        </p>
        <label className={LABEL}>
          Ghi chú (không bắt buộc)
          <textarea className={FIELD} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="no-clean-decision-note" />
        </label>
        {decide.isError ? <ErrorAlert>{toUserMessage(decide.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
