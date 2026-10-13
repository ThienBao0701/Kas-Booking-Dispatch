/**
 * WHERE A HOUSEKEEPING WORK ITEM IS, AND WHERE IT STANDS — the vocabulary of
 * "Tạo công việc", "Các công việc trong ngày" and the housekeeper's task list.
 *
 * THE AREAS COME FROM THE BRANCH'S OWN CATALOG (`room/branchRooms`): its rooms
 * and its floors, keyed by the branch code — never a hardcoded list here.
 *
 * A ROOM'S FLOOR IS READ, NEVER GUESSED. A room is put on a floor only when the
 * part of its number before the last two digits names exactly one of the
 * branch's catalog floors ("501" → "5" when "5" is a floor). Where that does not
 * hold — a ground-floor "001" with no floor "0", or Chi nhánh 4, whose floors
 * carry their building ("2 (Khu Suite)" and "2 (Tòa bên cạnh)") so "203" could
 * be either — the room is listed under "Phòng chưa xác định tầng" instead of
 * being placed on a floor it may not be on. Nothing is hidden.
 */
import type { HousekeepingAreaKind, RoomWorkState } from '@prisma/client';
import { floorsForBranchCode, roomsForBranchCode } from '../room/branchRooms';
import { ROOM_STATUS_CODES } from './roomTaskCatalog';

export const AREA_KIND_LABELS: Record<HousekeepingAreaKind, string> = {
  ROOM: 'Phòng',
  HALLWAY: 'Hành lang',
  STAIRCASE: 'Cầu thang',
  OTHER: 'Khác',
};

/** A shared area of a floor — anything that is not a room. */
export const SHARED_AREA_KINDS = ['HALLWAY', 'STAIRCASE', 'OTHER'] as const;

/** A room item's "Việc cần làm": the room's code for the day, or "Khác". */
export const WORK_TASK_CODES = [...ROOM_STATUS_CODES, 'OTHER'] as const;
export type WorkTaskCode = (typeof WORK_TASK_CODES)[number];
export const OTHER_TASK_LABEL = 'Khác';

/** The heading of the rooms a floor cannot be read for. */
export const UNPLACED_LABEL = 'Phòng chưa xác định tầng';

export const floorLabel = (floor: string): string => `Tầng ${floor}`;

/**
 * The catalog floor of a room, or null when it cannot be read for certain —
 * see the module comment. `floors` is the branch's floor catalog.
 */
export function roomFloor(room: string, floors: readonly string[] | null): string | null {
  if (!floors || !/^\d{3,4}$/.test(room)) return null;
  const candidate = String(Number(room.slice(0, -2)));
  return floors.includes(candidate) ? candidate : null;
}

/** The place as one line: "Phòng - 502", "Hành lang - Tầng 5", "Khác - Tầng 5". */
export function placeLabel(kind: HousekeepingAreaKind, room: string | null, floor: string | null): string {
  if (kind === 'ROOM') return `${AREA_KIND_LABELS.ROOM} - ${room ?? '—'}`;
  return floor ? `${AREA_KIND_LABELS[kind]} - ${floorLabel(floor)}` : AREA_KIND_LABELS[kind];
}

/** The branch's areas for "Chọn khu vực": floors with their rooms, then the rooms no floor can be read for. */
export function workAreasFor(branchCode: string) {
  const rooms = roomsForBranchCode(branchCode);
  const floors = floorsForBranchCode(branchCode);
  const byFloor = new Map<string, string[]>((floors ?? []).map((f) => [f, []]));
  const unplaced: string[] = [];
  for (const room of rooms ?? []) {
    const floor = roomFloor(room, floors);
    if (floor) byFloor.get(floor)!.push(room);
    else unplaced.push(room);
  }
  return {
    /** False: the branch has no room catalog — the room is typed, as on every other form. */
    hasRoomCatalog: rooms !== null,
    hasFloorCatalog: floors !== null,
    floors: [...byFloor.entries()].map(([floor, floorRooms]) => ({ floor, label: floorLabel(floor), rooms: floorRooms })),
    unplacedRooms: unplaced,
    unplacedLabel: UNPLACED_LABEL,
    sharedAreas: SHARED_AREA_KINDS.map((kind) => ({ kind, label: AREA_KIND_LABELS[kind] })),
    roomTaskCodes: WORK_TASK_CODES.map((code) => ({ code, label: code === 'OTHER' ? OTHER_TASK_LABEL : code })),
  };
}

/**
 * WHERE A WORK ITEM STANDS — one word per stage, the order the work goes in:
 *
 *   UNCLAIMED          nobody has it                         "Chưa tiếp nhận"
 *   ACCEPTED           accepted or given; not inspected      "Đã tiếp nhận / Chờ kiểm tra"
 *   INSPECTING         "Kiểm tra" begun, not yet saved       "Đang kiểm tra"
 *   AWAITING_CLEANING  inspection saved; cleaning not begun  "Chờ dọn phòng"
 *   CLEANING           "Dọn phòng" / "Bắt đầu dọn" pressed     "Đang dọn phòng"
 *   COMPLETED          the cleaning is finished              "Hoàn thành"
 *   VOIDED             "Xóa"                                 "Đã xóa"
 *
 * Read from the existing state plus two timestamps, never stored apart from
 * them, so it cannot disagree with the record.
 */
export type WorkPhase = 'UNCLAIMED' | 'ACCEPTED' | 'INSPECTING' | 'AWAITING_CLEANING' | 'CLEANING' | 'COMPLETED' | 'VOIDED';

export const WORK_PHASE_LABELS: Record<WorkPhase, string> = {
  UNCLAIMED: 'Chưa tiếp nhận',
  ACCEPTED: 'Đã tiếp nhận / Chờ kiểm tra',
  INSPECTING: 'Đang kiểm tra',
  AWAITING_CLEANING: 'Chờ dọn phòng',
  CLEANING: 'Đang dọn phòng',
  COMPLETED: 'Hoàn thành',
  VOIDED: 'Đã xóa',
};

export function workPhase(t: {
  state: RoomWorkState;
  assigneeUserId: number | null;
  inspectionStartedAt: Date | null;
  voidedAt: Date | null;
}): WorkPhase {
  if (t.voidedAt) return 'VOIDED';
  if (t.state === 'COMPLETED') return 'COMPLETED';
  if (t.state === 'IN_PROGRESS') return 'CLEANING';
  if (t.state === 'INSPECTED') return 'AWAITING_CLEANING';
  if (t.assigneeUserId === null) return 'UNCLAIMED';
  return t.inspectionStartedAt ? 'INSPECTING' : 'ACCEPTED';
}

/** "Việc cần làm": the typed name, else the room's code ("OC"); "Khác — <name>" for a room's other job. */
export function taskLabel(t: { statusCode: string; taskName: string | null; areaKind: HousekeepingAreaKind }): string {
  if (t.areaKind !== 'ROOM') return t.taskName ?? AREA_KIND_LABELS[t.areaKind];
  if (t.statusCode === 'OTHER') return t.taskName ? `${OTHER_TASK_LABEL} — ${t.taskName}` : OTHER_TASK_LABEL;
  return t.taskName ? `${t.statusCode} — ${t.taskName}` : t.statusCode;
}
