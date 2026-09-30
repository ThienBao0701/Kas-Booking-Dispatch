/**
 * THE ROOM CATALOG — the one list of rooms each branch actually has.
 *
 * Every room-bearing report (an incident in a room, a housekeeping inspection)
 * picks its room from here, and the server refuses a room that is not on its
 * branch's list. That is what makes "the same room" mean the same room: a typed
 * "302 " and "P302" were two rooms to every report and every repeat check.
 *
 * KEYED BY THE BRANCH CODE, never by `branchNumber` or `id`: the code is
 * immutable, the number is editable in "Khách sạn & chi nhánh". The lists are the
 * operator's own data (supplied per "Chi nhánh 1–8"), de-duplicated where the
 * source repeated a room, and otherwise exactly as supplied — no room invented.
 *
 * A branch NOT in this table has no catalog: its forms fall back to a typed room
 * and the server accepts it, exactly as before. Adding a hotel therefore never
 * blocks its reception from reporting until someone edits this file.
 */
import { ApiError } from '../lib/errors';

const ROOMS_BY_BRANCH_CODE: Record<string, readonly string[]> = {
  // Chi nhánh 1 — 05 Trương Định
  TRUONG_DINH_05: ['102', '103', '101', '202', '302', '402', '502', '602', '702', '201', '301', '401', '501', '601', '701'],
  // Chi nhánh 2 — 260 Lý Tự Trọng
  LY_TU_TRONG_260: [
    '102', '202', '302', '402', '502', '602', '103', '403', '503', '603', '702', '802', '201', '301', '601',
    '203', '303', '101', '401', '501', '701', '801',
  ],
  // Chi nhánh 3 — 47A Nguyễn Trãi (201 and 301 were listed twice)
  NGUYEN_TRAI_47A: [
    '102', '202', '302', '402', '502', '602', '702', '101', '201', '301', '401', '501', '601', '701', '801',
    '103', '203', '303', '403', '503', '603', '703', '803', '903', '1003', '1103', '201', '301',
  ],
  // Chi nhánh 4 — 170-172-174 Nguyễn Thái Bình
  NGUYEN_THAI_BINH_170: [
    '203', '204', '303', '403', '201', '202', '301', '302', '401', '402', '501', '502', '601', '602', '701',
    '702', '801', '802', '304', '404', '503', '504', '603', '604', '703', '704', '803', '804', '805', '806',
    '205', '206', '305', '306', '405', '406', '505', '506', '605', '606', '705', '706', '001', '002', '003',
  ],
  // Chi nhánh 5 — 278 Lê Thánh Tôn
  LE_THANH_TON_278: ['102', '202', '302', '402', '203', '303', '403', '103', '502', '101', '201', '301', '401', '001', '501'],
  // Chi nhánh 6 — 40-42 Bùi Thị Xuân (401 was listed twice)
  BUI_THI_XUAN_40: [
    '402', '502', '602', '702', '205', '305', '405', '505', '605', '705', '805', '806', '001', '403', '503',
    '603', '703', '206', '306', '401', '406', '501', '506', '606', '706', '601', '701', '102', '202', '302',
    '802', '204', '304', '404', '604', '704', '804', '504', '101', '201', '301', '401',
  ],
  // Chi nhánh 7 — 13 Bùi Thị Xuân
  BUI_THI_XUAN_13: [
    '202', '302', '402', '502', '602', '702', '802', '902', '102', '103', '203', '204', '303', '304', '403',
    '503', '603', '703', '803', '903', '201', '301', '401', '501', '601', '701', '801', '804', '901', '904',
    '404', '504', '604', '704', '101', '001',
  ],
  // Chi nhánh 8 — 191 Lê Thánh Tôn
  LE_THANH_TON_191: [
    '102', '104', '106', '202', '204', '205', '302', '304', '402', '502', '602', '702', '207', '208', '209',
    '307', '308', '309', '001', '101', '105', '201', '211', '301', '401', '501', '601', '701', '103', '203',
    '303', '403', '503', '603', '703', '206', '311', '210', '305', '310',
  ],
};

/** Floor, then room: "001" … "003", "101" … "1103" — the order a building is walked. */
function byFloorThenRoom(a: string, b: string): number {
  return Number(a) - Number(b) || a.localeCompare(b);
}

const CATALOG: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(ROOMS_BY_BRANCH_CODE).map(([code, rooms]) => [code, [...new Set(rooms)].sort(byFloorThenRoom)]),
);

/** The branch's rooms, unique and ordered — or null when the branch has no catalog. */
export function roomsForBranchCode(code: string): readonly string[] | null {
  return CATALOG.get(code) ?? null;
}

/**
 * The room as it will be stored: trimmed, and — when the branch has a catalog —
 * one of its rooms, or refused. `null` means "no room given"; whether a room is
 * REQUIRED is the caller's rule (the area decides it for an incident).
 */
export function catalogRoom(branchCode: string, raw: string | null | undefined): string | null {
  const room = (raw ?? '').trim();
  if (!room) return null;
  const rooms = roomsForBranchCode(branchCode);
  if (rooms && !rooms.includes(room)) {
    throw ApiError.validation(`Phòng ${room} không thuộc chi nhánh này. Vui lòng chọn phòng trong danh sách.`);
  }
  return room;
}
