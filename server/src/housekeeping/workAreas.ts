/**
 * WHERE A HOUSEKEEPING WORK ITEM IS, AND WHERE IT STANDS — the vocabulary of
 * "Tạo công việc", the work groups ("Công việc 1, 2, …") and the housekeeper's
 * list.
 *
 * THE AREAS COME FROM THE BRANCH'S OWN CATALOG (`room/branchRooms`): its rooms,
 * its floors and whether it has a Rooftop, keyed by the branch code — never a
 * hardcoded list here.
 *
 * A ROOM'S FLOOR IS READ, NEVER GUESSED. A room is put on a floor when the
 * catalog fixes it (Chi nhánh 4's Suite rooms 001 / 002 / 003), or when the
 * part of its number before the last two digits names one of the branch's
 * floors ("501" → "5"). Where neither holds — a ground-floor "001" with no
 * floor "0" — the room is listed under "Phòng chưa xác định tầng" instead of
 * being placed on a floor it may not be on. Nothing is hidden.
 */
import type { HousekeepingAreaKind, HousekeepingNoCleanStatus, RoomWorkState } from '@prisma/client';
import { floorsForBranchCode, hasRooftop, roomFloorOverride, roomsForBranchCode } from '../room/branchRooms';
import { ApiError } from '../lib/errors';
import { ROOM_STATUS_CODES } from './roomTaskCatalog';

export const AREA_KIND_LABELS: Record<HousekeepingAreaKind, string> = {
  ROOM: 'Phòng',
  HALLWAY: 'Hành lang',
  STAIRCASE: 'Cầu thang',
  OTHER: 'Khác',
  ROOFTOP: 'Rooftop',
};

/** The shared areas of a floor, offered under every floor beside its rooms. */
export const SHARED_AREA_KINDS = ['HALLWAY', 'STAIRCASE', 'OTHER'] as const;

/**
 * "Việc cần làm" ticked for a place. OUT / OC / VC are the room's state for the
 * day, so AT MOST ONE of them; "Khác" (OTHER) may be ticked beside it, or alone,
 * and its note says what. A shared area or the Rooftop is always "Khác".
 */
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
export function roomFloor(room: string, floors: readonly string[] | null, branchCode?: string): string | null {
  const fixed = branchCode ? roomFloorOverride(branchCode, room) : null;
  if (fixed) return floors?.includes(fixed) ? fixed : null;
  if (!floors || !/^\d{3,4}$/.test(room)) return null;
  const candidate = String(Number(room.slice(0, -2)));
  return floors.includes(candidate) ? candidate : null;
}

/** The place as one line: "Phòng - 502", "Hành lang - Tầng 5", "Khác - Tầng 5", "Rooftop". */
export function placeLabel(kind: HousekeepingAreaKind, room: string | null, floor: string | null): string {
  if (kind === 'ROOM') return `${AREA_KIND_LABELS.ROOM} - ${room ?? '—'}`;
  if (kind === 'ROOFTOP') return AREA_KIND_LABELS.ROOFTOP;
  return floor ? `${AREA_KIND_LABELS[kind]} - ${floorLabel(floor)}` : AREA_KIND_LABELS[kind];
}

/**
 * The branch's areas for "Tạo công việc": each floor with its rooms (the shared
 * areas are offered under every floor), the rooms no floor can be read for —
 * only when there are any — and whether the branch has a Rooftop.
 */
export function workAreasFor(branchCode: string) {
  const rooms = roomsForBranchCode(branchCode);
  const floors = floorsForBranchCode(branchCode);
  const byFloor = new Map<string, string[]>((floors ?? []).map((f) => [f, []]));
  const unplaced: string[] = [];
  for (const room of rooms ?? []) {
    const floor = roomFloor(room, floors, branchCode);
    if (floor) byFloor.get(floor)!.push(room);
    else unplaced.push(room);
  }
  const numeric = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  return {
    /** False: the branch has no room catalog — the room is typed, as on every other form. */
    hasRoomCatalog: rooms !== null,
    hasFloorCatalog: floors !== null,
    floors: [...byFloor.entries()].map(([floor, floorRooms]) => ({ floor, label: floorLabel(floor), rooms: [...floorRooms].sort(numeric) })),
    unplacedRooms: [...unplaced].sort(numeric),
    unplacedLabel: UNPLACED_LABEL,
    sharedAreas: SHARED_AREA_KINDS.map((kind) => ({ kind, label: AREA_KIND_LABELS[kind] })),
    hasRooftop: hasRooftop(branchCode),
    rooftopLabel: AREA_KIND_LABELS.ROOFTOP,
    roomTaskCodes: WORK_TASK_CODES.map((code) => ({ code, label: code === 'OTHER' ? OTHER_TASK_LABEL : code })),
  };
}

/**
 * The ticked "Việc cần làm" of one place, checked — and the code the row keeps
 * in `statusCode`: the room's OUT / OC / VC, or OTHER when only "Khác".
 */
export function normalizeTaskCodes(raw: unknown, kind: HousekeepingAreaKind, at: string): { codes: WorkTaskCode[]; statusCode: string } {
  if (kind !== 'ROOM') return { codes: ['OTHER'], statusCode: 'OTHER' };
  const list = Array.isArray(raw) ? raw : [];
  const codes = WORK_TASK_CODES.filter((code) => list.includes(code));
  if (codes.length === 0 || codes.length !== new Set(list).size) {
    throw ApiError.validation(`${at}: vui lòng chọn việc cần làm (OUT, OC, VC hoặc Khác).`);
  }
  const roomCodes = codes.filter((c) => c !== 'OTHER');
  if (roomCodes.length > 1) throw ApiError.validation(`${at}: chỉ chọn một trong OUT, OC, VC.`);
  return { codes, statusCode: roomCodes[0] ?? 'OTHER' };
}

/** The ticked codes of a row — read from `statusCode` on rows saved before the codes were. */
export function taskCodesOf(t: { taskCodes: string[]; statusCode: string }): string[] {
  return t.taskCodes.length > 0 ? t.taskCodes : [t.statusCode];
}

/**
 * WHERE A WORK ITEM STANDS — one word per stage, the order the work goes in:
 *
 *   UNCLAIMED          nobody has it                         "Chưa giao"
 *   ACCEPTED           accepted or given; not inspected      "Đã nhận / Chờ kiểm tra"
 *   INSPECTING         "Kiểm tra" begun, not yet saved       "Đang kiểm tra"
 *   AWAITING_CLEANING  inspection saved; cleaning not begun  "Chờ dọn phòng"
 *   CLEANING           "Dọn phòng" / "Bắt đầu dọn" pressed     "Đang dọn phòng"
 *   COMPLETED          the cleaning is finished              "Hoàn thành"
 *   NO_CLEAN_PENDING   "Không cần dọn" asked, not decided    "Chờ duyệt không cần dọn"
 *   NO_CLEAN           "Không cần dọn" approved              "Không cần dọn"
 *   VOIDED             removed by the manager                "Đã xóa"
 *
 * Read from the existing state and timestamps, never stored apart from them, so
 * it cannot disagree with the record.
 */
export type WorkPhase =
  | 'UNCLAIMED'
  | 'ACCEPTED'
  | 'INSPECTING'
  | 'AWAITING_CLEANING'
  | 'CLEANING'
  | 'COMPLETED'
  | 'NO_CLEAN_PENDING'
  | 'NO_CLEAN'
  | 'VOIDED';

export const WORK_PHASE_LABELS: Record<WorkPhase, string> = {
  UNCLAIMED: 'Chưa giao',
  ACCEPTED: 'Đã nhận / Chờ kiểm tra',
  INSPECTING: 'Đang kiểm tra',
  AWAITING_CLEANING: 'Chờ dọn phòng',
  CLEANING: 'Đang dọn phòng',
  COMPLETED: 'Hoàn thành',
  NO_CLEAN_PENDING: 'Chờ duyệt không cần dọn',
  NO_CLEAN: 'Không cần dọn',
  VOIDED: 'Đã xóa',
};

export function workPhase(t: {
  state: RoomWorkState;
  assigneeUserId: number | null;
  inspectionStartedAt: Date | null;
  voidedAt: Date | null;
  noCleanStatus?: HousekeepingNoCleanStatus | null;
}): WorkPhase {
  if (t.voidedAt) return t.noCleanStatus === 'APPROVED' ? 'NO_CLEAN' : 'VOIDED';
  if (t.noCleanStatus === 'PENDING') return 'NO_CLEAN_PENDING';
  if (t.state === 'COMPLETED') return 'COMPLETED';
  if (t.state === 'IN_PROGRESS') return 'CLEANING';
  if (t.state === 'INSPECTED') return 'AWAITING_CLEANING';
  if (t.assigneeUserId === null) return 'UNCLAIMED';
  return t.inspectionStartedAt ? 'INSPECTING' : 'ACCEPTED';
}

/** "Việc cần làm": "OC", "OUT + Khác", "Khác"; an older item's typed name as before. */
export function taskLabel(t: { statusCode: string; taskName: string | null; areaKind: HousekeepingAreaKind; taskCodes?: string[] }): string {
  if (t.areaKind !== 'ROOM') return t.taskName ?? (t.areaKind === 'ROOFTOP' ? OTHER_TASK_LABEL : AREA_KIND_LABELS[t.areaKind]);
  const codes = t.taskCodes && t.taskCodes.length > 0 ? t.taskCodes : [t.statusCode];
  const label = codes.map((c) => (c === 'OTHER' ? OTHER_TASK_LABEL : c)).join(' + ');
  return t.taskName ? `${label} — ${t.taskName}` : label;
}
