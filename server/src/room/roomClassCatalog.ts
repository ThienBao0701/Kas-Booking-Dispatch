/**
 * The confirmed branch room-class catalogue (Phase C.3.8).
 *
 * This is the SEED of the database-backed configuration, not the runtime source
 * of truth: once seeded, Admins manage room classes through versioned drafts and
 * this file is never consulted again for resolution. It exists so a fresh
 * database (and every test) starts from the operator-confirmed mapping.
 *
 * Each branch is keyed by its STABLE `Branch.code` — never by branch number,
 * array position, address text or the business-facing "CNx" label. The CN
 * numbers appear only as human-readable comments, because an Admin may renumber
 * a branch at any time (C.3.7) without that meaning anything changed here.
 *
 * ── Spelling ──────────────────────────────────────────────────────────────
 * The business wrote "Superrior". The application, its parser tables and its
 * existing data all use the correct spelling "Superior", so the canonical
 * DISPLAY name is "Superior" and "Superrior" is carried as a recognised ALIAS.
 * That keeps one room class per branch instead of two near-duplicates, while
 * still resolving whatever the business types. The PMS code is SUP either way.
 *
 * ── No cross-class normalisation ──────────────────────────────────────────
 * Business classes that merely look similar are NEVER folded together:
 * Deluxe ≠ Deluxe-Bal, King ≠ King Bal, Family ≠ De-Family,
 * Deluxe1&2 ≠ Deluxe3&4, D-D ≠ Pre-DD, Deluxe D-D ≠ Deluxe.
 */

/** One room class as confirmed by the business. */
export interface RoomClassSeed {
  /** Stable across versions and renames; unique within a branch. */
  stableKey: string;
  /** Canonical display name shown to staff. */
  displayName: string;
  /** Exact PMS note code. Never normalised away. */
  pmsCode: string;
  /** Extra spellings that must resolve to this class, within this branch only. */
  aliases: string[];
}

export interface BranchRoomClassSeed {
  /** Stable Branch.code — the technical identity. */
  branchCode: string;
  /** Business-facing label at seed time, for readable seed logs only. */
  cnLabel: string;
  classes: RoomClassSeed[];
}

/** Aliases every "Superior" class accepts, including the business's spelling. */
const SUPERIOR_ALIASES = ['Superrior', 'SUPERIOR', 'SUPERRIOR', 'Superior Room'];

/** Aliases every "Standard" class accepts. */
const STANDARD_ALIASES = ['STANDARD', 'Standard Room'];

export const BRANCH_ROOM_CLASS_SEED: readonly BranchRoomClassSeed[] = [
  {
    // CN1
    branchCode: 'TRUONG_DINH_05',
    cnLabel: 'CN1',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      {
        stableKey: 'family-twin',
        displayName: 'FamilyTwin',
        pmsCode: 'DEFAM',
        aliases: ['Family Twin', 'family-twin', 'FAMILYTWIN', 'Family-Twin'],
      },
    ],
  },
  {
    // CN2
    branchCode: 'LY_TU_TRONG_260',
    cnLabel: 'CN2',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      { stableKey: 'premium', displayName: 'Premium', pmsCode: 'LUXDEL', aliases: ['PREMIUM', 'Luxury Deluxe'] },
      {
        stableKey: 'dd-room',
        displayName: 'D-D Room',
        pmsCode: 'DD',
        aliases: ['D D Room', 'DD Room', 'D-D', 'DD', 'D D'],
      },
      {
        stableKey: 'pre-dd',
        displayName: 'Pre-DD',
        pmsCode: 'PRE_DD',
        aliases: ['Pre DD', 'PRE_DD', 'PREDD', 'Pre-D-D'],
      },
      { stableKey: 'family', displayName: 'Family', pmsCode: 'FAM', aliases: ['FAMILY', 'Family Room'] },
      {
        stableKey: 'de-family',
        displayName: 'De-Family',
        pmsCode: 'DEFAM',
        aliases: ['De Family', 'DEFAMILY', 'Deluxe Family'],
      },
    ],
  },
  {
    // CN3
    branchCode: 'NGUYEN_TRAI_47A',
    cnLabel: 'CN3',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      {
        stableKey: 'de-family',
        displayName: 'De-Family',
        pmsCode: 'DEFAM',
        aliases: ['De Family', 'DEFAMILY', 'Deluxe Family'],
      },
    ],
  },
  {
    // CN4
    branchCode: 'NGUYEN_THAI_BINH_170',
    cnLabel: 'CN4',
    classes: [
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      {
        stableKey: 'deluxe-1-2',
        displayName: 'Deluxe1&2',
        pmsCode: 'DEL12',
        aliases: ['Deluxe 1&2', 'Deluxe 1 & 2', 'Deluxe12', 'Deluxe 12'],
      },
      {
        stableKey: 'deluxe-3-4',
        displayName: 'Deluxe3&4',
        pmsCode: 'DEL34',
        aliases: ['Deluxe 3&4', 'Deluxe 3 & 4', 'Deluxe34', 'Deluxe 34'],
      },
      {
        stableKey: 'deluxe-dd',
        displayName: 'Deluxe D-D',
        pmsCode: 'DD',
        aliases: ['Deluxe DD', 'Deluxe D D', 'DeluxeD-D'],
      },
      {
        stableKey: 'deluxe-bal',
        displayName: 'Deluxe-Bal',
        pmsCode: 'DEBAL',
        aliases: ['Deluxe Bal', 'Deluxe Balcony', 'DELUXEBAL'],
      },
      {
        stableKey: 'suite-bal',
        displayName: 'Suite-Bal',
        pmsCode: 'SUITEBAL',
        aliases: ['Suite Bal', 'Suite Balcony', 'SUITEBAL'],
      },
    ],
  },
  {
    // CN5
    branchCode: 'LE_THANH_TON_278',
    cnLabel: 'CN5',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'twin', displayName: 'TWIN', pmsCode: 'TWIN', aliases: ['Twin', 'Twin Room'] },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      { stableKey: 'studio', displayName: 'Studio', pmsCode: 'STU', aliases: ['STUDIO', 'Studio Room'] },
      { stableKey: 'suite', displayName: 'Suite', pmsCode: 'SUITE', aliases: ['SUITE', 'Suite Room'] },
    ],
  },
  {
    // CN6
    branchCode: 'BUI_THI_XUAN_40',
    cnLabel: 'CN6',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      {
        stableKey: 'deluxe-queen',
        displayName: 'DeluxeQueen',
        pmsCode: 'DELQUEEN',
        aliases: ['Deluxe Queen', 'DELUXEQUEEN', 'Deluxe-Queen'],
      },
      {
        stableKey: 'deluxe-bal',
        displayName: 'Deluxe-Bal',
        pmsCode: 'DEBAL',
        aliases: ['Deluxe Bal', 'Deluxe Balcony', 'DELUXEBAL'],
      },
      { stableKey: 'dd', displayName: 'D-D', pmsCode: 'DD', aliases: ['D D', 'DD', 'D-D Room', 'DD Room'] },
      { stableKey: 'king', displayName: 'King', pmsCode: 'KING', aliases: ['KING', 'King Room'] },
      { stableKey: 'family', displayName: 'Family', pmsCode: 'FAM', aliases: ['FAMILY', 'Family Room'] },
      {
        stableKey: 'de-family',
        displayName: 'De-Family',
        pmsCode: 'DEFAM',
        aliases: ['De Family', 'DEFAMILY', 'Deluxe Family'],
      },
    ],
  },
  {
    // CN7
    branchCode: 'BUI_THI_XUAN_13',
    cnLabel: 'CN7',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      {
        stableKey: 'deluxe-bal',
        displayName: 'Deluxe-Bal',
        pmsCode: 'DEBAL',
        aliases: ['Deluxe Bal', 'Deluxe Balcony', 'DELUXEBAL'],
      },
      { stableKey: 'king', displayName: 'King', pmsCode: 'KING', aliases: ['KING', 'King Room'] },
      { stableKey: 'suite', displayName: 'Suite', pmsCode: 'SUITE', aliases: ['SUITE', 'Suite Room'] },
    ],
  },
  {
    // CN8
    branchCode: 'LE_THANH_TON_191',
    cnLabel: 'CN8',
    classes: [
      { stableKey: 'standard', displayName: 'Standard', pmsCode: 'STAN', aliases: STANDARD_ALIASES },
      { stableKey: 'superior', displayName: 'Superior', pmsCode: 'SUP', aliases: SUPERIOR_ALIASES },
      { stableKey: 'deluxe', displayName: 'Deluxe', pmsCode: 'DEL', aliases: ['DELUXE'] },
      { stableKey: 'king', displayName: 'King', pmsCode: 'KING', aliases: ['KING', 'King Room'] },
      {
        stableKey: 'deluxe-bal',
        displayName: 'Deluxe-Bal',
        pmsCode: 'DEBAL',
        aliases: ['Deluxe Bal', 'Deluxe Balcony', 'DELUXEBAL'],
      },
      {
        stableKey: 'king-bal',
        displayName: 'King Bal',
        pmsCode: 'KINGBAL',
        aliases: ['King-Bal', 'King Balcony', 'KINGBAL'],
      },
    ],
  },
] as const;

/** Total confirmed room classes across all branches (asserted by tests). */
export const CONFIRMED_ROOM_CLASS_COUNT = BRANCH_ROOM_CLASS_SEED.reduce(
  (total, branch) => total + branch.classes.length,
  0,
);

/** Every PMS code the confirmed catalogue uses. Preserved exactly. */
export const CONFIRMED_PMS_CODES = [
  'STAN', 'SUP', 'DEFAM', 'DEL', 'LUXDEL', 'DD', 'PRE_DD', 'FAM',
  'DEL12', 'DEL34', 'DEBAL', 'SUITEBAL', 'TWIN', 'STU', 'SUITE',
  'DELQUEEN', 'KING', 'KINGBAL',
] as const;
