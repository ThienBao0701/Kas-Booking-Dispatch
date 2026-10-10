/**
 * Branch-scoped room-class resolution (Phase C.3.8).
 *
 * The single rule this module exists to enforce:
 *
 *   A room name is resolved ONLY against the ACTIVE room-class mapping of the
 *   booking's OWN branch. There is no global table, no cross-branch fallback,
 *   no "first class wins", and no silent default to Standard.
 *
 * Matching is DETERMINISTIC and EXACT on a normalised form — never fuzzy.
 * That is a safety decision, not a simplification: the confirmed catalogue
 * contains pairs that any similarity metric would confuse, and picking the
 * wrong one silently sends a guest to the wrong room type.
 *
 *   Deluxe      vs Deluxe-Bal      vs Deluxe D-D
 *   King        vs King Bal
 *   Family      vs De-Family
 *   Deluxe1&2   vs Deluxe3&4
 *   D-D         vs Pre-DD
 *
 * An unrecognised name therefore returns UNRESOLVED with its source text
 * preserved, so a human can pick the class explicitly. Guessing is never an
 * acceptable outcome here.
 */
import type { PrismaClient, RoomClassResolutionStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { removeDiacritics } from '../booking/text';

/**
 * Folds a room-class name to its comparison key.
 *
 * Diacritics are stripped, case is folded, and every non-alphanumeric character
 * is removed so punctuation and spacing stop mattering:
 *
 *   "Deluxe1&2" · "Deluxe 1&2" · "Deluxe 1 & 2"  → "deluxe12"
 *   "D-D Room"  · "D D Room"   · "DD Room"       → "ddroom"
 *   "De-Family" · "De Family"  · "DEFAMILY"      → "defamily"
 *   "King Bal"  · "King-Bal"                     → "kingbal"
 *
 * Crucially it does NOT merge distinct classes: "deluxe" ≠ "deluxebal",
 * "king" ≠ "kingbal", "family" ≠ "defamily", "dd" ≠ "predd". Because matching
 * is exact on this key, near-neighbours can never collide.
 */
export function normalizeRoomClassName(input: string | null | undefined): string {
  if (!input) return '';
  return removeDiacritics(input).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Normalises a PMS code to its stored form: upper-cased, with spaces and
 * hyphens folded to underscores so "pre dd" / "pre-dd" both become PRE_DD.
 * Every confirmed code (STAN, LUXDEL, PRE_DD, DEL12, SUITEBAL, …) is preserved
 * exactly as the business specified it.
 */
export function normalizePmsCode(input: string | null | undefined): string {
  if (!input) return '';
  return removeDiacritics(input)
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** One room class as the resolver needs it (shape shared by DB rows + fixtures). */
export interface ResolvableRoomClass {
  id: string;
  branchId: number;
  versionId: string;
  stableKey: string;
  displayName: string;
  normalizedName: string;
  pmsCode: string;
  active: boolean;
  sortOrder: number;
  aliases: { normalizedAlias: string; alias: string; active: boolean }[];
}

/** The ACTIVE mapping of one branch, loaded once and passed to the resolver. */
export interface BranchRoomMapping {
  branchId: number;
  versionId: string;
  versionNumber: number;
  classes: ResolvableRoomClass[];
}

export type RoomMatchType = 'DISPLAY_NAME' | 'ALIAS' | 'EXPLICIT_ID' | 'NONE';

export interface RoomClassResolution {
  status: RoomClassResolutionStatus;
  roomClassId: string | null;
  branchId: number | null;
  versionId: string | null;
  displayName: string | null;
  pmsCode: string | null;
  /** The alias that matched, when the match came from an alias. */
  matchedAlias: string | null;
  matchType: RoomMatchType;
  /** Always preserved verbatim, resolved or not. */
  sourceText: string | null;
}

export interface ResolveRoomClassInput {
  /** The booking's own branch. Resolution never looks outside it. */
  branchId: number;
  /** The room name as it appeared in the source document, if any. */
  sourceRoomName?: string | null;
  /** An explicit class chosen by an authorised user; wins over text matching. */
  explicitRoomClassId?: string | null;
}

function unresolved(sourceText: string | null, branchId: number): RoomClassResolution {
  return {
    status: 'UNRESOLVED',
    roomClassId: null,
    branchId,
    versionId: null,
    displayName: null,
    pmsCode: null,
    matchedAlias: null,
    matchType: 'NONE',
    sourceText,
  };
}

/**
 * Resolves one room name against one branch's ACTIVE mapping.
 *
 * Pure: it takes the mapping as data, so it is fully unit-testable and performs
 * no database access of its own.
 *
 * Order of precedence:
 *  1. An explicit room-class id — but ONLY if that class belongs to this branch
 *     and this mapping version. A cross-branch id is rejected, not honoured.
 *  2. Exact normalised match on the class display name.
 *  3. Exact normalised match on an active alias.
 * Anything else is UNRESOLVED.
 */
export function resolveRoomClass(
  input: ResolveRoomClassInput,
  mapping: BranchRoomMapping | null,
): RoomClassResolution {
  const sourceText = input.sourceRoomName?.trim() || null;

  if (!mapping || mapping.branchId !== input.branchId) {
    // No configured mapping for this branch — never borrow another branch's.
    return unresolved(sourceText, input.branchId);
  }

  const active = mapping.classes.filter((c) => c.active);

  // 1. Explicit selection by an authorised user.
  if (input.explicitRoomClassId) {
    const chosen = active.find((c) => c.id === input.explicitRoomClassId);
    if (!chosen || chosen.branchId !== input.branchId) {
      // A room-class id from another branch is a bug or an attack — refuse it.
      return unresolved(sourceText, input.branchId);
    }
    return {
      status: 'MANUAL',
      roomClassId: chosen.id,
      branchId: chosen.branchId,
      versionId: mapping.versionId,
      displayName: chosen.displayName,
      pmsCode: chosen.pmsCode,
      matchedAlias: null,
      matchType: 'EXPLICIT_ID',
      sourceText,
    };
  }

  const key = normalizeRoomClassName(sourceText);
  if (key.length === 0) return unresolved(sourceText, input.branchId);

  // 2. The class's own display name.
  const byName = active.find((c) => c.normalizedName === key);
  if (byName) {
    return {
      status: 'RESOLVED',
      roomClassId: byName.id,
      branchId: byName.branchId,
      versionId: mapping.versionId,
      displayName: byName.displayName,
      pmsCode: byName.pmsCode,
      matchedAlias: null,
      matchType: 'DISPLAY_NAME',
      sourceText,
    };
  }

  // 3. An active alias of a class in this branch/version.
  for (const cls of active) {
    const alias = cls.aliases.find((a) => a.active && a.normalizedAlias === key);
    if (alias) {
      return {
        status: 'RESOLVED',
        roomClassId: cls.id,
        branchId: cls.branchId,
        versionId: mapping.versionId,
        displayName: cls.displayName,
        pmsCode: cls.pmsCode,
        matchedAlias: alias.alias,
        matchType: 'ALIAS',
        sourceText,
      };
    }
  }

  return unresolved(sourceText, input.branchId);
}

/**
 * Loads a branch's ACTIVE mapping. Returns null when the branch has none
 * configured — callers must treat that as "cannot resolve", never as
 * "use some other branch".
 */
export async function loadActiveMapping(
  branchId: number | null | undefined,
  client: PrismaClient = defaultPrisma,
): Promise<BranchRoomMapping | null> {
  if (branchId == null) return null;

  const version = await client.branchRoomMappingVersion.findFirst({
    where: { branchId, status: 'ACTIVE' },
    include: {
      roomClasses: {
        orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
        include: { aliases: true },
      },
    },
  });
  if (!version) return null;

  return {
    branchId: version.branchId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    classes: version.roomClasses.map((c) => ({
      id: c.id,
      branchId: c.branchId,
      versionId: c.versionId,
      stableKey: c.stableKey,
      displayName: c.displayName,
      normalizedName: c.normalizedName,
      pmsCode: c.pmsCode,
      active: c.active,
      sortOrder: c.sortOrder,
      aliases: c.aliases.map((a) => ({
        alias: a.alias,
        normalizedAlias: a.normalizedAlias,
        active: a.active,
      })),
    })),
  };
}

/** The snapshot columns written onto a BookingRoom from a resolution. */
export interface RoomClassSnapshot {
  roomClassId: string | null;
  roomClassVersionId: string | null;
  roomClassBranchId: number | null;
  roomClassDisplayName: string | null;
  roomClassPmsCode: string | null;
  roomClassSourceText: string | null;
  roomClassStatus: RoomClassResolutionStatus;
  roomClassResolvedAt: Date;
}

/**
 * Projects a resolution onto the immutable snapshot columns.
 *
 * The display name and PMS code are COPIED, not referenced: a later mapping
 * version may rename or re-code the class, and this booking must keep showing
 * what it was created with.
 */
export function toSnapshot(
  resolution: RoomClassResolution,
  now: Date = new Date(),
): RoomClassSnapshot {
  return {
    roomClassId: resolution.roomClassId,
    roomClassVersionId: resolution.versionId,
    roomClassBranchId: resolution.branchId,
    roomClassDisplayName: resolution.displayName,
    roomClassPmsCode: resolution.pmsCode,
    roomClassSourceText: resolution.sourceText,
    roomClassStatus: resolution.status,
    roomClassResolvedAt: now,
  };
}
