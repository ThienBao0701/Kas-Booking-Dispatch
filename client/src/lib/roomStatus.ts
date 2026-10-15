/**
 * WHERE A ROOM'S HOUSEKEEPING STANDS, for "Tình trạng phòng" — cleaning status
 * only, never occupancy. See components/HkRoomGrid.tsx for the picture.
 */
import { CircleAlert, CircleCheck, CircleMinus, Clock, ClipboardCheck, Hourglass, Minus, ScanSearch, Brush, type LucideIcon } from 'lucide-react';
import type { RoomTask, WorkAreas } from '../api/roomWork';
import type { Tone } from '../components/HkManagerUi';
import { floorHeading, placeName } from './workPlaces';

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/** The filter / summary family a tile belongs to. */
export type RoomStatusGroup = 'todo' | 'cleaning' | 'review' | 'done' | 'reclean' | 'noclean' | 'none';

export interface RoomStatus {
  group: RoomStatusGroup;
  label: string;
  tone: Tone | 'none';
  icon: LucideIcon;
}

export const STATUS_FILTERS: { value: RoomStatusGroup | ''; label: string }[] = [
  { value: '', label: 'Tất cả trạng thái' },
  { value: 'todo', label: 'Chưa dọn' },
  { value: 'cleaning', label: 'Đang dọn' },
  { value: 'review', label: 'Chờ đánh giá' },
  { value: 'done', label: 'Đã dọn' },
  { value: 'reclean', label: 'Cần dọn lại / Không đạt' },
  { value: 'noclean', label: 'Không cần dọn' },
  { value: 'none', label: 'Không có việc' },
];

/** Where the room's latest live cycle of the day stands. */
export function roomStatus(t: RoomTask | undefined): RoomStatus {
  if (!t) return { group: 'none', label: 'Không có việc', tone: 'none', icon: Minus };
  if (t.reclean && t.state === 'NOT_STARTED') return { group: 'reclean', label: 'Cần dọn lại', tone: 'red', icon: CircleAlert };
  if (t.phase === 'NO_CLEAN_PENDING') return { group: 'noclean', label: 'Chờ duyệt không cần dọn', tone: 'amber', icon: Hourglass };
  if (t.phase === 'NO_CLEAN') return { group: 'noclean', label: 'Không cần dọn', tone: 'gray', icon: CircleMinus };
  if (t.state === 'COMPLETED') {
    if (t.review?.status === 'PENDING') return { group: 'review', label: 'Chờ đánh giá', tone: 'amber', icon: Hourglass };
    if (t.review?.status === 'FAILED') return { group: 'reclean', label: 'Không đạt', tone: 'red', icon: CircleAlert };
    if (t.review?.status === 'PASSED') return { group: 'done', label: 'Đạt', tone: 'green', icon: CircleCheck };
    return { group: 'done', label: 'Đã dọn', tone: 'green', icon: CircleCheck };
  }
  if (t.state === 'IN_PROGRESS' || t.phase === 'CLEANING') return { group: 'cleaning', label: 'Đang dọn', tone: 'blue', icon: Brush };
  if (t.state === 'INSPECTED' || t.phase === 'AWAITING_CLEANING') return { group: 'todo', label: 'Đã kiểm tra', tone: 'amber', icon: ClipboardCheck };
  if (t.phase === 'INSPECTING') return { group: 'todo', label: 'Đang kiểm tra', tone: 'gray', icon: ScanSearch };
  return { group: 'todo', label: 'Chưa dọn', tone: 'gray', icon: Clock };
}

/** The legend: each colour with its word and icon. */
export const LEGEND: { label: string; hint: string; status: RoomStatus }[] = [
  { label: 'Chưa dọn', hint: 'Chưa nhận hoặc chưa kiểm tra', status: roomStatus({ state: 'NOT_STARTED', phase: 'UNCLAIMED' } as RoomTask) },
  { label: 'Đã kiểm tra', hint: 'Đã kiểm tra, chờ bắt đầu dọn', status: roomStatus({ state: 'INSPECTED' } as RoomTask) },
  { label: 'Đang dọn', hint: 'Đang trong quá trình dọn', status: roomStatus({ state: 'IN_PROGRESS' } as RoomTask) },
  { label: 'Chờ đánh giá', hint: 'Đã dọn xong, chờ “Đạt / Không đạt”', status: roomStatus({ state: 'COMPLETED', review: { status: 'PENDING' } } as RoomTask) },
  { label: 'Đã dọn', hint: 'Hoàn thành (đã đạt nếu được đánh giá)', status: roomStatus({ state: 'COMPLETED' } as RoomTask) },
  { label: 'Cần dọn lại', hint: 'Không đạt hoặc phải dọn lại', status: roomStatus({ state: 'NOT_STARTED', reclean: {} } as RoomTask) },
  { label: 'Không có việc', hint: 'Không có công việc trong ngày', status: roomStatus(undefined) },
];

/* ------------------------------------------------------------------ *
 * The floors
 * ------------------------------------------------------------------ */

export interface RoomTile {
  key: string;
  /** "101", "Hành lang", "Rooftop". */
  name: string;
  isRoom: boolean;
  task: RoomTask | undefined;
  status: RoomStatus;
}

export interface FloorBlock {
  key: string;
  label: string;
  tiles: RoomTile[];
}

const roomKey = (t: RoomTask) => (t.areaKind === 'ROOM' || !t.areaKind ? `ROOM:${t.roomNumber}` : (t.itemKey ?? `${t.areaKind}:${t.floor ?? ''}:${t.roomNumber}`));

/** The latest live cycle of each room / area of the day. */
export function latestByPlace(tasks: RoomTask[]): Map<string, RoomTask> {
  const latest = new Map<string, RoomTask>();
  for (const t of tasks) {
    if (t.voided) continue;
    const key = roomKey(t);
    const seen = latest.get(key);
    if (!seen || seen.cycleNumber < t.cycleNumber) latest.set(key, t);
  }
  return latest;
}

const tileOf = (key: string, name: string, isRoom: boolean, task: RoomTask | undefined): RoomTile => ({ key, name, isRoom, task, status: roomStatus(task) });

/**
 * The branch's floors with every room on them (from its room catalog), the shared
 * areas that have work on that floor today, the rooms not yet placed, and any
 * area outside a floor (the Rooftop). Without a catalog: the day's places only.
 */
export function buildFloors(areas: WorkAreas | undefined, tasks: RoomTask[]): FloorBlock[] {
  const latest = latestByPlace(tasks);
  const used = new Set<string>();
  const take = (key: string) => {
    used.add(key);
    return latest.get(key);
  };
  const blocks: FloorBlock[] = [];
  if (areas?.hasRoomCatalog) {
    for (const f of areas.floors) {
      const tiles = f.rooms.map((r) => tileOf(`ROOM:${r}`, r, true, take(`ROOM:${r}`)));
      for (const [key, t] of latest) {
        if (!used.has(key) && t.areaKind && t.areaKind !== 'ROOM' && t.areaKind !== 'ROOFTOP' && t.floor === f.floor) {
          used.add(key);
          tiles.push(tileOf(key, placeName(t), false, t));
        }
      }
      blocks.push({ key: `floor:${f.floor}`, label: f.label, tiles });
    }
    if (areas.unplacedRooms.length > 0) {
      blocks.push({ key: 'unplaced', label: areas.unplacedLabel, tiles: areas.unplacedRooms.map((r) => tileOf(`ROOM:${r}`, r, true, take(`ROOM:${r}`))) });
    }
  }
  // Whatever has work today but no place above: rooms outside the catalog, the Rooftop, …
  const rest = new Map<string, RoomTile[]>();
  for (const [key, t] of latest) {
    if (used.has(key)) continue;
    const heading = floorHeading(t);
    const isRoom = t.areaKind === 'ROOM' || !t.areaKind;
    rest.set(heading, [...(rest.get(heading) ?? []), tileOf(key, isRoom ? t.roomNumber : placeName(t), isRoom, t)]);
  }
  for (const [heading, tiles] of rest) {
    const existing = blocks.find((b) => b.label === heading);
    if (existing) existing.tiles.push(...tiles);
    else blocks.push({ key: `other:${heading}`, label: heading, tiles });
  }
  return blocks;
}


/** The colour of a status icon, beside its word. */
export const STATUS_ICON_CLASS: Record<RoomStatus['tone'], string> = {
  none: 'text-slate-400',
  slate: 'text-slate-500',
  gray: 'text-slate-500',
  blue: 'text-blue-600',
  green: 'text-green-600',
  red: 'text-red-600',
  amber: 'text-amber-600',
};
