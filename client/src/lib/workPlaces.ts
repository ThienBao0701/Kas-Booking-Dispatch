/**
 * A place of a housekeeping work group, as the forms hold it — and the one-line
 * text every screen shows for a place. Pure: no React, no requests.
 */
import type { GroupItemInput, RoomTask, WorkAreaKind, WorkTaskCode } from '../api/roomWork';

/** One floor section of the form ("Khu vực 1", "+ Thêm khu vực"): which floor group it shows. */
export interface FloorSection {
  key: number;
  /** A catalog floor, "__rooftop__", "__unplaced__", or "" before a choice. */
  group: string;
}

/** A fresh, empty floor section after the ones there are. */
export function nextSection(sections: FloorSection[]): FloorSection {
  return { key: Math.max(0, ...sections.map((s) => s.key)) + 1, group: '' };
}

export interface PlaceDraft {
  /** "ROOM:101", "HALLWAY:5", "OTHER:5", "ROOFTOP" — one place, picked once in the whole group. */
  key: string;
  /** The floor section it was picked in. */
  section: number;
  areaKind: WorkAreaKind;
  roomNumber?: string;
  /** The catalog floor a shared area is on. */
  floor?: string;
  /** "Tầng 1", "Tầng 2 (Khu Suite)", "Phòng chưa xác định tầng", "Rooftop". */
  groupLabel: string;
  /** "Phòng 101", "Hành lang", "Rooftop". */
  label: string;
  codes: WorkTaskCode[];
  /** Asked for — and sent — only with "Khác" (always "Khác" for a shared area). */
  note: string;
  /**
   * "Xác nhận" pressed on the note as it now reads — a draft state only: nothing
   * is saved before the whole group is. Any edit of the note clears it.
   */
  noteConfirmed?: boolean;
}

/**
 * The review of a new work group, by floor: one section per floor (a shared
 * area under its own floor), floors in the order first picked; a place with no
 * floor known under its own labelled section.
 */
export function draftsByFloor(drafts: PlaceDraft[]): { heading: string; places: PlaceDraft[] }[] {
  const floors = new Map<string, PlaceDraft[]>();
  for (const d of drafts) {
    const heading = d.groupLabel.trim() || 'Chưa xác định tầng';
    floors.set(heading, [...(floors.get(heading) ?? []), d]);
  }
  return [...floors].map(([heading, places]) => ({ heading, places }));
}

/** The shortest reason that says something ("Thay rèm", "Lau sàn"). */
export const MIN_NOTE_CHARS = 3;

/** Why a "Khác" note cannot be confirmed yet, or null. */
export function noteProblem(note: string): string | null {
  const text = note.trim();
  if (!text) return 'Nhập lý do / việc cần làm.';
  if (text.length < MIN_NOTE_CHARS) return `Ghi rõ hơn (ít nhất ${MIN_NOTE_CHARS} ký tự).`;
  return null;
}

/** "Khác" says what in its note: a room with "Khác" ticked, or any shared area. */
export function needsNote(d: { areaKind: WorkAreaKind; codes: readonly string[] }): boolean {
  return d.areaKind !== 'ROOM' || d.codes.includes('OTHER');
}

/** "OUT", "OC + Khác", "Khác". */
export function codesLabel(codes: readonly string[]): string {
  return codes.map((c) => (c === 'OTHER' ? 'Khác' : c)).join(' + ');
}

/** Why the place cannot be saved yet, or null. */
export function placeProblem(d: PlaceDraft): string | null {
  if (d.areaKind === 'ROOM' && d.codes.length === 0) return 'Chọn việc cần làm.';
  if (needsNote(d) && !d.note.trim()) return d.areaKind === 'ROOM' ? '"Khác" cần ghi rõ lý do / việc cần làm.' : 'Khu vực này cần ghi rõ việc cần làm.';
  if (needsNote(d) && noteProblem(d.note)) return noteProblem(d.note);
  if (needsNote(d) && !d.noteConfirmed) return 'Bấm “Xác nhận” lý do (Khác).';
  return null;
}

/**
 * The places of the day that are still OPEN — the server's own rule: an item
 * not removed (an approved "Không cần dọn" removes it) and not yet reviewed. A
 * room cleaned and waiting for "Đạt / Không đạt", or with "Không cần dọn" not
 * yet approved, is still open. Keys as the form's tiles: "ROOM:101",
 * "HALLWAY:5", "STAIRCASE:5", "ROOFTOP". "Khác" is a free description, never held.
 */
export function openPlaceKeys(tasks: readonly RoomTask[]): Set<string> {
  const keys = new Set<string>();
  for (const t of tasks) {
    if (t.voided || (t.review && t.review.status !== 'PENDING')) continue;
    const kind = t.areaKind ?? 'ROOM';
    if (kind === 'ROOM') keys.add(`ROOM:${t.roomNumber}`);
    else if (kind === 'ROOFTOP') keys.add('ROOFTOP');
    else if ((kind === 'HALLWAY' || kind === 'STAIRCASE') && t.floor) keys.add(`${kind}:${t.floor}`);
  }
  return keys;
}

export function placeInput(d: PlaceDraft): GroupItemInput {
  return {
    areaKind: d.areaKind,
    ...(d.areaKind === 'ROOM' ? { roomNumber: d.roomNumber } : {}),
    ...(d.floor && d.areaKind !== 'ROOM' && d.areaKind !== 'ROOFTOP' ? { floor: d.floor } : {}),
    taskCodes: d.areaKind === 'ROOM' ? d.codes : ['OTHER'],
    // A note only where "Khác" asks for one; priority is no longer set from this form.
    ...(needsNote(d) && d.note.trim() ? { note: d.note.trim() } : {}),
  };
}

/** "Tầng 1 · Phòng 101", "Tầng 5 · Hành lang", "Rooftop". */
export function placeText(t: RoomTask): string {
  if (t.areaKind === 'ROOFTOP') return t.areaKindLabel ?? 'Rooftop';
  const where = t.areaKind === 'ROOM' || !t.areaKind ? `Phòng ${t.roomNumber}` : (t.areaKindLabel ?? t.areaKind);
  return t.floor ? `Tầng ${t.floor} · ${where}` : where;
}


/** The floor / area heading a place is shown under: "Tầng 1", "Tầng 2 (Khu Suite)", "Rooftop". */
export function floorHeading(t: RoomTask): string {
  if (t.areaKind === 'ROOFTOP') return t.areaKindLabel ?? 'Rooftop';
  if (t.floor) return `Tầng ${t.floor}`;
  return t.areaKind === 'ROOM' || !t.areaKind ? 'Phòng chưa xác định tầng' : 'Khu vực khác';
}

/** The place without its floor — the tile's own label: "Phòng 101", "Hành lang", "Rooftop". */
export function placeName(t: RoomTask): string {
  if (t.areaKind === 'ROOFTOP') return t.areaKindLabel ?? 'Rooftop';
  return t.areaKind === 'ROOM' || !t.areaKind ? `Phòng ${t.roomNumber}` : (t.areaKindLabel ?? t.areaKind);
}

/** A group's places by floor, floors in the order their first place was added. */
export function placesByFloor(tasks: RoomTask[]): { heading: string; tasks: RoomTask[] }[] {
  const floors = new Map<string, RoomTask[]>();
  for (const t of tasks) {
    const heading = floorHeading(t);
    floors.set(heading, [...(floors.get(heading) ?? []), t]);
  }
  return [...floors.entries()].map(([heading, list]) => ({ heading, tasks: list }));
}
