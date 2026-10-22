/**
 * Resolves a hotel name found in pasted OTA text to a branch.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a branch is assigned automatically
 * ONLY on an exact, normalised match. Similarity may rank candidates and report
 * confidence, but it never assigns — an operator confirms instead. A wrong
 * automatic assignment sends a real guest to the wrong hotel, and no similarity
 * score is worth that.
 *
 * Precedence, highest first:
 *   1. the branch's CURRENT identity on the selected platform (exact)
 *   2. the branch's internal name (exact)
 *   3. a stable branch code appearing in trusted structured input (exact)
 *   4. similarity — SUGGESTIONS ONLY, never an assignment
 *
 * A tie between two branches at the same precedence level is AMBIGUOUS and
 * resolves to nothing. An unknown name resolves to nothing. Neither ever falls
 * back to a default or first branch.
 *
 * Pure: it takes configuration and text, never touches Prisma, and is therefore
 * fully testable without a database.
 */
import { normalizeText } from './text';
import { hotelNameContains, hotelNameKey } from './hotelNameKey';
import type { MatchableBranch } from './types';

/** The five platforms an identity can belong to. */
export type IdentityPlatform =
  | 'BOOKING_COM'
  | 'AGODA'
  | 'CTRIP'
  | 'TRIPADVISOR'
  | 'TRAVELOKA';

/** One branch's current name on one platform, as the resolver needs it. */
export interface BranchIdentity {
  platform: IdentityPlatform;
  name: string;
  normalizedName: string;
}

/** A branch plus its current platform identities. */
export interface IdentityBranch extends MatchableBranch {
  identities?: readonly BranchIdentity[];
}

export type IdentityMatchReason =
  | 'EXACT_PLATFORM_IDENTITY'
  | 'EXACT_INTERNAL_NAME'
  | 'EXACT_BRANCH_CODE'
  /** Booking.com only: matched once generic words were dropped. */
  | 'NORMALIZED_NAME'
  /** Booking.com only: one name is contained in the other, word-aligned. */
  | 'NAME_CONTAINS'
  | 'AMBIGUOUS'
  | 'UNKNOWN'
  | 'NO_INPUT';

/** A branch the operator may pick, with why it was suggested. */
export interface BranchCandidate {
  branchId: number;
  branchCode: string;
  hotelName: string;
  address: string;
  /** 0–100. Advisory only — it never authorises an automatic assignment. */
  confidence: number;
  matchedValue: string;
}

export interface IdentityResolution {
  /** Non-null ONLY for an exact match. Similarity never fills this in. */
  branchId: number | null;
  branchCode: string | null;
  address: string | null;
  /** The configured value that matched, when one did. */
  matchedIdentity: string | null;
  reason: IdentityMatchReason;
  /** 0–100. 100 for an exact match; the best similarity score otherwise. */
  confidence: number;
  /**
   * True whenever an Admin must choose the branch before the booking may be
   * dispatched — i.e. for everything that is not an exact match.
   */
  requiresManualBranch: boolean;
  /** Ranked alternatives for the operator. Empty when the match is exact. */
  candidates: BranchCandidate[];
}

/** Only an active branch takes part in automatic routing. */
function routable(branch: IdentityBranch): boolean {
  return branch.active !== false;
}

function unresolved(
  reason: IdentityMatchReason,
  candidates: BranchCandidate[] = [],
  confidence = 0,
): IdentityResolution {
  return {
    branchId: null,
    branchCode: null,
    address: null,
    matchedIdentity: null,
    reason,
    confidence,
    requiresManualBranch: true,
    candidates,
  };
}

function resolved(
  branch: IdentityBranch,
  matchedIdentity: string,
  reason: IdentityMatchReason,
): IdentityResolution {
  return {
    branchId: branch.id,
    branchCode: branch.code,
    address: branch.address,
    matchedIdentity,
    reason,
    confidence: 100,
    requiresManualBranch: false,
    candidates: [],
  };
}

/** Exact matches at one precedence level, across every routable branch. */
function exactMatches(
  branches: readonly IdentityBranch[],
  valueOf: (branch: IdentityBranch) => string[],
  key: string,
): { branch: IdentityBranch; matched: string }[] {
  const hits: { branch: IdentityBranch; matched: string }[] = [];
  for (const branch of branches) {
    if (!routable(branch)) continue;
    for (const candidate of valueOf(branch)) {
      if (normalizeText(candidate) === key) {
        hits.push({ branch, matched: candidate });
        break;
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Similarity — suggestions only                                       */
/* ------------------------------------------------------------------ */

function tokens(text: string): string[] {
  return normalizeText(text).split(' ').filter(Boolean);
}

/** Two tokens match when equal, or one is a prefix of the other (len >= 3). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Prefix-tolerant token overlap, 0..1. Absorbs OTA truncations. */
function similarity(candidate: string, target: string): number {
  const a = tokens(candidate);
  const b = tokens(target);
  if (a.length === 0 || b.length === 0) return 0;
  const used = new Array<boolean>(b.length).fill(false);
  let intersection = 0;
  for (const token of a) {
    for (let j = 0; j < b.length; j += 1) {
      if (!used[j] && tokensMatch(token, b[j]!)) {
        used[j] = true;
        intersection += 1;
        break;
      }
    }
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Below this a suggestion is noise rather than a candidate. */
export const SUGGESTION_THRESHOLD = 0.4;

/** Every value a branch can be recognised by, for suggestion purposes. */
function searchableValues(branch: IdentityBranch, platform: IdentityPlatform): string[] {
  const identities = (branch.identities ?? [])
    .filter((i) => i.platform === platform)
    .map((i) => i.name);
  return [...identities, branch.hotelName];
}

function rankCandidates(
  candidate: string,
  platform: IdentityPlatform,
  branches: readonly IdentityBranch[],
): BranchCandidate[] {
  const scored: BranchCandidate[] = [];
  for (const branch of branches) {
    if (!routable(branch)) continue;
    let best = 0;
    let bestValue = '';
    for (const value of searchableValues(branch, platform)) {
      const score = similarity(candidate, value);
      if (score > best) {
        best = score;
        bestValue = value;
      }
    }
    if (best >= SUGGESTION_THRESHOLD) {
      scored.push({
        branchId: branch.id,
        branchCode: branch.code,
        hotelName: branch.hotelName,
        address: branch.address,
        confidence: Math.round(best * 100),
        matchedValue: bestValue,
      });
    }
  }
  // Deterministic: confidence first, then stable code so equal scores never
  // reorder between runs.
  return scored
    .sort((a, b) => b.confidence - a.confidence || a.branchCode.localeCompare(b.branchCode))
    .slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Public resolver                                                     */
/* ------------------------------------------------------------------ */

export interface ResolveOptions {
  /**
   * A branch code taken from TRUSTED structured input (never from free text a
   * guest could influence). Matched exactly at precedence 3.
   */
  trustedBranchCode?: string | null;
}

export function resolveBranchIdentity(
  hotelName: string | null | undefined,
  platform: IdentityPlatform,
  branches: readonly IdentityBranch[],
  options: ResolveOptions = {},
): IdentityResolution {
  // Precedence 3 is checked first when supplied, because a trusted structured
  // code is stronger evidence than any name a page happened to display.
  const trusted = options.trustedBranchCode?.trim();
  if (trusted && trusted.length > 0) {
    const key = normalizeText(trusted);
    const hits = exactMatches(branches, (b) => [b.code], key);
    if (hits.length === 1) return resolved(hits[0]!.branch, hits[0]!.matched, 'EXACT_BRANCH_CODE');
    if (hits.length > 1) return unresolved('AMBIGUOUS');
  }

  if (!hotelName) return unresolved('NO_INPUT');
  const key = normalizeText(hotelName);
  if (key.length === 0) return unresolved('NO_INPUT');

  // 1. Current platform identity — the operator-managed value.
  const byIdentity = exactMatches(
    branches,
    (b) => (b.identities ?? []).filter((i) => i.platform === platform).map((i) => i.name),
    key,
  );
  if (byIdentity.length === 1) {
    return resolved(byIdentity[0]!.branch, byIdentity[0]!.matched, 'EXACT_PLATFORM_IDENTITY');
  }
  if (byIdentity.length > 1) {
    return unresolved('AMBIGUOUS', rankCandidates(hotelName, platform, branches), 100);
  }

  // 2. Internal name — the "Tên nội bộ" an Admin maintains on the branch.
  const byInternal = exactMatches(branches, (b) => [b.hotelName], key);
  if (byInternal.length === 1) {
    return resolved(byInternal[0]!.branch, byInternal[0]!.matched, 'EXACT_INTERNAL_NAME');
  }
  if (byInternal.length > 1) {
    return unresolved('AMBIGUOUS', rankCandidates(hotelName, platform, branches), 100);
  }

  // 3. BOOKING.COM ONLY — the relaxed pass added in the 5.1 hotfix.
  //
  // Booking.com prints whatever public name the listing carries, which is
  // rarely character-equal to the internal name. Dropping generic words and
  // then allowing word-aligned containment resolves the real production
  // failures without loosening anything else.
  //
  // Agoda and CTrip deliberately do NOT get this. Every Agoda property name
  // shares the tokens "KAS" and "Hotel", so relaxed matching there could rate
  // two different properties alike and dispatch a guest to the wrong hotel —
  // the exact failure the exact-only rule was introduced to prevent.
  //
  // Every step below still refuses to guess: two branches matching means
  // AMBIGUOUS and no assignment, exactly as above.
  if (platform === 'BOOKING_COM') {
    const relaxed = resolveRelaxed(hotelName, platform, branches);
    if (relaxed) return relaxed;
  }

  // 4. Nothing matched. Suggest, never assign.
  const candidates = rankCandidates(hotelName, platform, branches);
  return unresolved('UNKNOWN', candidates, candidates[0]?.confidence ?? 0);
}

/** Every name a Booking.com booking may legitimately be recognised by. */
function recognisableNames(branch: IdentityBranch, platform: IdentityPlatform): string[] {
  const identities = (branch.identities ?? [])
    .filter((i) => i.platform === platform)
    .map((i) => i.name);
  // The alias table when the Admin has configured one. No alias is created
  // here and none is inferred — this only reads what already exists.
  const aliases = (branch.aliases ?? [])
    .filter((a) => a.source === 'BOOKING_COM')
    .map((a) => a.alias);
  return [...identities, branch.hotelName, ...aliases];
}

/**
 * The relaxed ladder, in strict precedence: normalised equality, then the
 * candidate containing a configured name, then a configured name containing the
 * candidate.
 *
 * Each rung is evaluated across ALL branches before moving down, so a weaker
 * match on one branch can never beat a stronger match on another. A rung with
 * two or more distinct branches is ambiguous and stops the ladder — falling
 * through to a looser rung after a tie would resolve by luck.
 */
function resolveRelaxed(
  hotelName: string,
  platform: IdentityPlatform,
  branches: readonly IdentityBranch[],
): IdentityResolution | null {
  const key = hotelNameKey(hotelName);
  if (key.length === 0) return null;

  const rungs: { reason: IdentityMatchReason; hit: (branchKey: string) => boolean }[] = [
    { reason: 'NORMALIZED_NAME', hit: (b) => b === key },
    // The mail carries extra words around the configured name.
    { reason: 'NAME_CONTAINS', hit: (b) => hotelNameContains(key, b) },
    // The mail carries a shortened form of the configured name.
    { reason: 'NAME_CONTAINS', hit: (b) => hotelNameContains(b, key) },
  ];

  for (const rung of rungs) {
    const hits: { branch: IdentityBranch; matched: string }[] = [];
    for (const branch of branches) {
      if (!routable(branch)) continue;
      const matched = recognisableNames(branch, platform).find((name) => {
        const branchKey = hotelNameKey(name);
        return branchKey.length > 0 && rung.hit(branchKey);
      });
      if (matched !== undefined) hits.push({ branch, matched });
    }

    if (hits.length === 1) return resolved(hits[0]!.branch, hits[0]!.matched, rung.reason);
    if (hits.length > 1) {
      return unresolved('AMBIGUOUS', rankCandidates(hotelName, platform, branches), 100);
    }
  }

  return null;
}

/**
 * Runs {@link resolveBranchIdentity} over every candidate line of pasted text.
 *
 * Pasted OTA pages rarely label the property cleanly — the name may sit in a
 * navigation crumb, a heading or a confirmation block. Trying each line means an
 * exact identity is found wherever it appears, instead of depending on which
 * line a heuristic happened to pick as "the hotel line".
 *
 * The FIRST exact match wins and stops the scan. An ambiguous line also stops it
 * (ambiguity must be surfaced, never skipped past in the hope a later line is
 * cleaner). Otherwise the best-scoring unresolved answer is returned so the
 * operator still gets ranked suggestions.
 */
export function resolveBranchIdentityFromLines(
  lines: readonly (string | null | undefined)[],
  platform: IdentityPlatform,
  branches: readonly IdentityBranch[],
  options: ResolveOptions = {},
): { resolution: IdentityResolution; matchedLine: string | null } {
  const usable = lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);

  let best: { resolution: IdentityResolution; matchedLine: string | null } = {
    resolution: unresolved(usable.length === 0 ? 'NO_INPUT' : 'UNKNOWN'),
    matchedLine: null,
  };

  for (const line of usable) {
    const resolution = resolveBranchIdentity(line, platform, branches, options);
    if (resolution.branchId !== null || resolution.reason === 'AMBIGUOUS') {
      return { resolution, matchedLine: line };
    }
    if (resolution.confidence > best.resolution.confidence) {
      best = { resolution, matchedLine: line };
    }
  }

  return best;
}
