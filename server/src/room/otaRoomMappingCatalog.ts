/**
 * The operator-confirmed OTA room mappings: how each platform's room name maps
 * to a branch's internal PMS code.
 *
 * SEED CONFIGURATION, NOT RUNTIME LOGIC. Once seeded these live in
 * `BranchOtaRoomMapping` and an Admin edits them from the UI; no parser reads
 * this file at runtime.
 *
 * ── PMS CODES ARE THE REPOSITORY'S, NOT THE SPREADSHEET'S ──────────────────
 * The operator's mapping list used four codes that are not this system's
 * internal codes. The authoritative catalogue is `roomClassCatalog.ts`, whose
 * codes already appear in dispatched bookings' immutable snapshots and in the
 * notes receptionists paste into the hotel PMS. Renaming them would change what
 * the PMS receives, so the mappings point at the EXISTING codes:
 *
 *   Premium King (CN2)   "PREMIUM" -> LUXDEL
 *   Premium Twin (CN2)   "PRE-DD"  -> PRE_DD
 *   Twin Superior (CN5)  "TWINT"   -> TWIN
 *   Studio (CN5)         "STUDIO"  -> STU
 *
 * Every other code in the operator's list already matched exactly.
 *
 * ── AGODA vs CTRIP ────────────────────────────────────────────────────────
 * The room NAMES are identical on both platforms today, so this file lists them
 * once. The seed writes them as INDEPENDENT rows per platform: renaming a room
 * on Agoda must never change what a CTrip booking resolves to.
 *
 * Agoda supplies real room-type identifiers, so they are recorded. No CTrip
 * identifier has been supplied, so CTrip rows carry `otaRoomTypeId = null` —
 * an Agoda id is never borrowed for a CTrip row.
 */

/** One OTA room name and the branch PMS code it resolves to. */
export interface OtaRoomMappingSeed {
  /** Exactly as the platform displays it. */
  otaRoomName: string;
  /** The branch's internal PMS code, from `roomClassCatalog.ts`. */
  pmsCode: string;
  /** Agoda's own room-type id. Null/absent for platforms that supplied none. */
  agodaRoomTypeId?: string;
}

export interface BranchOtaRoomMappingSeed {
  /** Stable Branch.code — the technical identity, never the CN label. */
  branchCode: string;
  /** Business-facing label at seed time, for readable logs only. */
  cnLabel: string;
  rooms: OtaRoomMappingSeed[];
}

/**
 * The platforms' OFFICIAL long room names, as Agoda publishes them, with Agoda's
 * own room-type identifiers. These are the names the OTA prints on a real
 * reservation.
 */
const OFFICIAL_ROOM_NAMES: readonly BranchOtaRoomMappingSeed[] = [
  {
    branchCode: 'TRUONG_DINH_05',
    cnLabel: 'CN1',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ', pmsCode: 'STAN', agodaRoomTypeId: '852778539' },
      { otaRoomName: 'Phòng Queen Superior Có Cửa Sổ', pmsCode: 'SUP', agodaRoomTypeId: '852779721' },
      { otaRoomName: 'Phòng Gia Đình Hướng Phố', pmsCode: 'DEFAM', agodaRoomTypeId: '852782077' },
    ],
  },
  {
    branchCode: 'LY_TU_TRONG_260',
    cnLabel: 'CN2',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ', pmsCode: 'STAN', agodaRoomTypeId: '588673998' },
      { otaRoomName: 'Phòng Superior Giường Đôi Cửa Sổ Nhỏ', pmsCode: 'SUP', agodaRoomTypeId: '588673999' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ King Và Cửa Sổ', pmsCode: 'DEL', agodaRoomTypeId: '588674093' },
      // Operator list said "PREMIUM"; the branch's actual PMS code is LUXDEL.
      { otaRoomName: 'Phòng Premium Có Giường Cỡ King Nhìn Ra Thành Phố', pmsCode: 'LUXDEL', agodaRoomTypeId: '983027841' },
      { otaRoomName: 'Phòng Deluxe 2 Giường Đơn Có Cửa Sổ', pmsCode: 'DD', agodaRoomTypeId: '983029243' },
      // Operator list said "PRE-DD"; the branch's actual PMS code is PRE_DD.
      { otaRoomName: 'Phòng Premium 2 Giường Đơn Nhìn Ra Thành Phố', pmsCode: 'PRE_DD', agodaRoomTypeId: '983030247' },
      { otaRoomName: 'Phòng Gia Đình Hướng Phố', pmsCode: 'FAM', agodaRoomTypeId: '983030369' },
      { otaRoomName: 'Phòng Gia Đình Deluxe Hướng Phố', pmsCode: 'DEFAM', agodaRoomTypeId: '983031952' },
    ],
  },
  {
    branchCode: 'NGUYEN_TRAI_47A',
    cnLabel: 'CN3',
    rooms: [
      { otaRoomName: 'Phòng Tiêu chuẩn Giường Đôi Không có Cửa sổ', pmsCode: 'STAN', agodaRoomTypeId: '588671493' },
      { otaRoomName: 'Phòng Superior Queen Hướng phố', pmsCode: 'SUP', agodaRoomTypeId: '588671503' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ King Và Cửa Sổ', pmsCode: 'DEL', agodaRoomTypeId: '764757071' },
      { otaRoomName: 'Phòng Gia đình Deluxe Hướng phố', pmsCode: 'DEFAM', agodaRoomTypeId: '601172314' },
    ],
  },
  {
    // CN4 deliberately has NO Standard mapping: a Standard-like input here must
    // stay unresolved and wait for an Admin.
    branchCode: 'NGUYEN_THAI_BINH_170',
    cnLabel: 'CN4',
    rooms: [
      { otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ', pmsCode: 'SUP', agodaRoomTypeId: '1170978687' },
      { otaRoomName: 'Phòng Deluxe Giường Cỡ Queen Có Cửa Sổ', pmsCode: 'DEL12', agodaRoomTypeId: '1170978688' },
      { otaRoomName: 'Phòng Deluxe Giường Cỡ Queen Nhìn Ra Thành Phố', pmsCode: 'DEL34', agodaRoomTypeId: '1170978689' },
      { otaRoomName: 'Phòng Twin Cao Cấp Có Cửa Sổ', pmsCode: 'DD', agodaRoomTypeId: '1170978690' },
      { otaRoomName: 'Premium Queen Room with Balcony & City View', pmsCode: 'DEBAL', agodaRoomTypeId: '1170978691' },
      { otaRoomName: 'Phòng Suite Junior Có Ban Công Và Nhìn Ra Thành Phố', pmsCode: 'SUITEBAL', agodaRoomTypeId: '1170978692' },
    ],
  },
  {
    branchCode: 'LE_THANH_TON_278',
    cnLabel: 'CN5',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ (Giường Đôi)', pmsCode: 'STAN', agodaRoomTypeId: '847723273' },
      { otaRoomName: 'Phòng Superior Có Cửa Sổ (Giường Queen)', pmsCode: 'SUP', agodaRoomTypeId: '848569037' },
      // Operator list said "TWINT"; the branch's actual PMS code is TWIN.
      { otaRoomName: 'Phòng Twin Superior Có Cửa Sổ', pmsCode: 'TWIN', agodaRoomTypeId: '848569629' },
      { otaRoomName: 'Phòng Đôi Hạng Sang Hướng Phố', pmsCode: 'DEL', agodaRoomTypeId: '848570639' },
      // Operator list said "STUDIO"; the branch's actual PMS code is STU.
      { otaRoomName: 'Căn Hộ Studio', pmsCode: 'STU', agodaRoomTypeId: '848571514' },
      { otaRoomName: 'Căn Hộ Suite Premium', pmsCode: 'SUITE', agodaRoomTypeId: '848571690' },
    ],
  },
  {
    branchCode: 'BUI_THI_XUAN_40',
    cnLabel: 'CN6',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ (Giường Queen)', pmsCode: 'STAN', agodaRoomTypeId: '982720014' },
      { otaRoomName: 'Phòng Superior Có Cửa Sổ (Giường Queen)', pmsCode: 'SUP', agodaRoomTypeId: '982729451' },
      { otaRoomName: 'Phòng Deluxe Có Cửa Sổ (Giường Queen)', pmsCode: 'DEL', agodaRoomTypeId: '982742035' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Nhìn Ra Thành Phố', pmsCode: 'DELQUEEN', agodaRoomTypeId: '982749388' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Có Ban Công & Nhìn Ra Thành Phố', pmsCode: 'DEBAL', agodaRoomTypeId: '982751149' },
      { otaRoomName: 'Phòng Twin Superior Có Cửa Sổ', pmsCode: 'DD', agodaRoomTypeId: '982754306' },
      { otaRoomName: 'Phòng Premium Có Giường Cỡ King Nhìn Ra Thành Phố', pmsCode: 'KING', agodaRoomTypeId: '982753134' },
      { otaRoomName: 'Phòng Gia Đình Hướng Phố', pmsCode: 'FAM', agodaRoomTypeId: '982756357' },
      { otaRoomName: 'Phòng Gia Đình Deluxe Hướng Phố', pmsCode: 'DEFAM', agodaRoomTypeId: '982758152' },
    ],
  },
  {
    branchCode: 'BUI_THI_XUAN_13',
    cnLabel: 'CN7',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Không Có Cửa Sổ (Giường Queen)', pmsCode: 'STAN', agodaRoomTypeId: '912918581' },
      { otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ', pmsCode: 'SUP', agodaRoomTypeId: '912918580' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Nhìn Ra Thành Phố', pmsCode: 'DEL', agodaRoomTypeId: '912918582' },
      { otaRoomName: 'Phòng King Deluxe Có Ban Công', pmsCode: 'DEBAL', agodaRoomTypeId: '1331879034' },
      { otaRoomName: 'Phòng Premium Có Giường Cỡ King Nhìn Ra Thành Phố', pmsCode: 'KING', agodaRoomTypeId: '1331882037' },
      { otaRoomName: 'Suite Cao Cấp', pmsCode: 'SUITE', agodaRoomTypeId: '1350229524' },
    ],
  },
  {
    branchCode: 'LE_THANH_TON_191',
    cnLabel: 'CN8',
    rooms: [
      { otaRoomName: 'Phòng Tiêu Chuẩn Giường Đôi Không Có Cửa Sổ', pmsCode: 'STAN', agodaRoomTypeId: '1181163414' },
      { otaRoomName: 'Phòng Superior Có Giường Cỡ Queen Không Có Cửa Sổ', pmsCode: 'SUP', agodaRoomTypeId: '1181163415' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Nhìn Ra Thành Phố', pmsCode: 'DEL', agodaRoomTypeId: '1181163416' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ King Và Cửa Sổ', pmsCode: 'KING', agodaRoomTypeId: '1331948224' },
      { otaRoomName: 'Phòng Deluxe Có Giường Cỡ Queen Có Ban Công', pmsCode: 'DEBAL', agodaRoomTypeId: '1331958223' },
      { otaRoomName: 'Premium King Room with Balcony', pmsCode: 'KINGBAL', agodaRoomTypeId: '1331968351' },
    ],
  },
] as const;

/**
 * The SHORT operator aliases, confirmed for all eight branches.
 *
 * These are the names that actually arrive in a pasted reservation — Agoda's
 * partner email and CTrip's reservation page both print the short form
 * ("Superior Room", "Standard Double Room No Window") rather than the long
 * official name above. Both spellings must therefore resolve, so these are
 * ADDITIONAL rows, never replacements: the official names and their Agoda ids
 * are left exactly as they are.
 *
 * No Agoda room-type id is recorded here. These aliases were supplied as text,
 * and attaching an id from the official row would assert a link nobody stated.
 *
 * The catalogue is IDENTICAL for Agoda and CTrip (operator-confirmed), which is
 * why it is written once — but `seedOtaRoomMappings` still writes an
 * independent row per platform, so renaming a room on one never moves the
 * other.
 *
 * ── WHERE THE SUPPLIED SHORTHAND MET AN EXISTING CODE ─────────────────────
 * Three aliases named a code the branch's committed catalogue does not use.
 * The repository's canonical code wins in every case — these codes are already
 * in dispatched bookings' immutable snapshots and in notes pasted into the PMS:
 *
 *   CN5 "D-D Room"           -> TWIN   (CN5 has TWIN, and has no DD class)
 *   CN5 "Deluxe Queen Room"  -> DEL    (CN5 has no DELQUEEN; CN6 does)
 *   CN2 "Luxury Twin Room - 01" -> PRE_DD  (the premium-twin code, unchanged)
 *
 * CN4 deliberately receives NO Standard alias: that branch has no STAN class,
 * so a Standard-like room there must stay unresolved and wait for an Admin.
 */
const OPERATOR_ROOM_ALIASES: readonly BranchOtaRoomMappingSeed[] = [
  {
    branchCode: 'TRUONG_DINH_05',
    cnLabel: 'CN1',
    rooms: [
      { otaRoomName: 'Standard Window', pmsCode: 'STAN' },
      { otaRoomName: 'Standard Room', pmsCode: 'STAN' },
      { otaRoomName: 'Superior Room', pmsCode: 'SUP' },
      { otaRoomName: 'Deluxe Family Room', pmsCode: 'DEFAM' },
    ],
  },
  {
    branchCode: 'LY_TU_TRONG_260',
    cnLabel: 'CN2',
    rooms: [
      { otaRoomName: 'Standard Double Room', pmsCode: 'STAN' },
      { otaRoomName: 'Superior Double Room', pmsCode: 'SUP' },
      { otaRoomName: 'Deluxe Room -03', pmsCode: 'DEL' },
      { otaRoomName: 'Luxury Deluxe Room - 01', pmsCode: 'LUXDEL' },
      { otaRoomName: 'Deluxe Twin Room - 03', pmsCode: 'DD' },
      // The premium twin. Canonical code PRE_DD — never PRE-DD or LUX_DD.
      { otaRoomName: 'Luxury Twin Room - 01', pmsCode: 'PRE_DD' },
      { otaRoomName: 'Family Room', pmsCode: 'FAM' },
      { otaRoomName: 'Deluxe Family Room', pmsCode: 'DEFAM' },
    ],
  },
  {
    branchCode: 'NGUYEN_TRAI_47A',
    cnLabel: 'CN3',
    rooms: [
      { otaRoomName: 'Standard Room', pmsCode: 'STAN' },
      { otaRoomName: 'Superior Room', pmsCode: 'SUP' },
      { otaRoomName: 'Deluxe Family Room', pmsCode: 'DEFAM' },
      { otaRoomName: 'Deluxe Room', pmsCode: 'DEL' },
    ],
  },
  {
    // No Standard alias: CN4 has no STAN class.
    branchCode: 'NGUYEN_THAI_BINH_170',
    cnLabel: 'CN4',
    rooms: [
      { otaRoomName: 'Superior Room', pmsCode: 'SUP' },
      { otaRoomName: 'Deluxe 1 - 2', pmsCode: 'DEL12' },
      { otaRoomName: 'Deluxe 3 - 4', pmsCode: 'DEL34' },
      { otaRoomName: 'Deluxe D-D', pmsCode: 'DD' },
      { otaRoomName: 'Deluxe Balcony', pmsCode: 'DEBAL' },
      { otaRoomName: 'Suite Balcony', pmsCode: 'SUITEBAL' },
    ],
  },
  {
    branchCode: 'LE_THANH_TON_278',
    cnLabel: 'CN5',
    rooms: [
      { otaRoomName: 'Standard Double Room', pmsCode: 'STAN' },
      { otaRoomName: 'Standard Double Room No Window', pmsCode: 'STAN' },
      { otaRoomName: 'Superior Double Room', pmsCode: 'SUP' },
      // CN5's twin class is TWIN; this branch has no DD.
      { otaRoomName: 'D-D Room', pmsCode: 'TWIN' },
      // CN5 has no DELQUEEN class — its deluxe code is DEL.
      { otaRoomName: 'Deluxe Queen Room', pmsCode: 'DEL' },
      { otaRoomName: 'Studio Room', pmsCode: 'STU' },
      { otaRoomName: 'Suite Room', pmsCode: 'SUITE' },
    ],
  },
  {
    branchCode: 'BUI_THI_XUAN_40',
    cnLabel: 'CN6',
    rooms: [
      { otaRoomName: 'Standard Double Room', pmsCode: 'STAN' },
      { otaRoomName: 'Standard Double Room No Window', pmsCode: 'STAN' },
      { otaRoomName: 'Standard', pmsCode: 'STAN' },
      { otaRoomName: 'Superior Room', pmsCode: 'SUP' },
      { otaRoomName: 'Deluxe Room', pmsCode: 'DEL' },
      { otaRoomName: 'Deluxe Double Room with Window', pmsCode: 'DEL' },
      { otaRoomName: 'Deluxe Queen Room', pmsCode: 'DELQUEEN' },
      { otaRoomName: 'Deluxe Balcony Room', pmsCode: 'DEBAL' },
      { otaRoomName: 'King Room', pmsCode: 'KING' },
      { otaRoomName: 'D-D Room', pmsCode: 'DD' },
      { otaRoomName: 'Family Room', pmsCode: 'FAM' },
      { otaRoomName: 'Deluxe Family Room', pmsCode: 'DEFAM' },
    ],
  },
  {
    branchCode: 'BUI_THI_XUAN_13',
    cnLabel: 'CN7',
    rooms: [
      { otaRoomName: 'Superior', pmsCode: 'SUP' },
      { otaRoomName: 'Superior Room', pmsCode: 'SUP' },
      { otaRoomName: 'Superior Queen Room with City View', pmsCode: 'SUP' },
      { otaRoomName: 'Standard', pmsCode: 'STAN' },
      { otaRoomName: 'Standard Room', pmsCode: 'STAN' },
      { otaRoomName: 'Deluxe Room', pmsCode: 'DEL' },
      { otaRoomName: 'Deluxe Balcony', pmsCode: 'DEBAL' },
      { otaRoomName: 'King Room', pmsCode: 'KING' },
      { otaRoomName: 'Deluxe King Room with Window', pmsCode: 'KING' },
      { otaRoomName: 'Suites Room', pmsCode: 'SUITE' },
      { otaRoomName: 'Suite Room', pmsCode: 'SUITE' },
    ],
  },
  {
    branchCode: 'LE_THANH_TON_191',
    cnLabel: 'CN8',
    rooms: [
      { otaRoomName: 'Standard Room', pmsCode: 'STAN' },
      { otaRoomName: 'Superior giường Queen', pmsCode: 'SUP' },
      { otaRoomName: 'Superior Queen Room', pmsCode: 'SUP' },
      { otaRoomName: 'Phòng Loại Sang', pmsCode: 'DEL' },
      { otaRoomName: 'Deluxe Room', pmsCode: 'DEL' },
      { otaRoomName: 'King Room', pmsCode: 'KING' },
      { otaRoomName: 'Deluxe King Room with Window', pmsCode: 'KING' },
      { otaRoomName: 'Deluxe Balcony', pmsCode: 'DEBAL' },
      { otaRoomName: 'King Balcony', pmsCode: 'KINGBAL' },
    ],
  },
] as const;

/**
 * The full catalogue: each branch's official names followed by its operator
 * aliases. Merged by branch code so a branch appears exactly once.
 */
export const BRANCH_OTA_ROOM_MAPPING_SEED: readonly BranchOtaRoomMappingSeed[] =
  OFFICIAL_ROOM_NAMES.map((branch) => ({
    branchCode: branch.branchCode,
    cnLabel: branch.cnLabel,
    rooms: [
      ...branch.rooms,
      ...(OPERATOR_ROOM_ALIASES.find((a) => a.branchCode === branch.branchCode)?.rooms ?? []),
    ],
  }));

/** The platforms these mappings are seeded for. */
export const MAPPED_PLATFORMS = ['AGODA', 'CTRIP'] as const;

/** Total mappings per platform (asserted by tests). */
export const OTA_ROOM_MAPPING_COUNT = BRANCH_OTA_ROOM_MAPPING_SEED.reduce(
  (total, branch) => total + branch.rooms.length,
  0,
);
