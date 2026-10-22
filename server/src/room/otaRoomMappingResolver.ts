/**
 * Resolves an OTA's room name to the branch's internal PMS code.
 *
 * EXACT ONLY, deliberately. A room code goes verbatim into the note a
 * receptionist pastes into the hotel system: guessing "Standard Double Room No
 * Window" is probably STAN would eventually put the wrong room on a real
 * reservation. An unmapped name resolves to nothing, is reported, and waits for
 * an Admin to map it.
 *
 * The lookup key is (branch, platform, normalised name) — never the name alone.
 * The same OTA name means different classes at different branches, and Agoda
 * and CTrip hold independent rows even when their names are identical.
 */
import type { OtaPlatform, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { normalizeText } from '../booking/text';

/** One branch's mappings for one platform, as the resolver needs them. */
export interface OtaRoomMappingConfig {
  otaRoomName: string;
  normalizedOtaRoomName: string;
  otaRoomTypeId: string | null;
  pmsCode: string;
}

export interface RoomMappingResolution {
  /** The internal code, or null when the name is not mapped for this branch. */
  pmsCode: string | null;
  /** The configured OTA name that matched, for the review screen. */
  matchedOtaRoomName: string | null;
  /** True when an Admin must choose the mapping before dispatch. */
  requiresManualMapping: boolean;
}

/**
 * Loads one branch's mappings for one platform. Kept separate from the resolver
 * so the resolver stays pure and testable without a database.
 */
export async function loadOtaRoomMappings(
  branchId: number,
  platform: OtaPlatform,
  client: PrismaClient = defaultPrisma,
): Promise<OtaRoomMappingConfig[]> {
  const rows = await client.branchOtaRoomMapping.findMany({
    where: { branchId, platform, active: true },
    select: {
      otaRoomName: true,
      normalizedOtaRoomName: true,
      otaRoomTypeId: true,
      pmsCode: true,
    },
    orderBy: { otaRoomName: 'asc' },
  });
  return rows;
}

/**
 * Exact, normalised lookup. Case, accents, punctuation and repeated whitespace
 * are folded — none of those change which room a name refers to — but no token
 * is ever dropped and no similarity is attempted.
 */
export function resolveOtaRoomCode(
  otaRoomName: string | null | undefined,
  mappings: readonly OtaRoomMappingConfig[],
): RoomMappingResolution {
  if (!otaRoomName) {
    return { pmsCode: null, matchedOtaRoomName: null, requiresManualMapping: true };
  }
  const key = normalizeText(otaRoomName);
  if (key.length === 0) {
    return { pmsCode: null, matchedOtaRoomName: null, requiresManualMapping: true };
  }

  const hit = mappings.find((m) => m.normalizedOtaRoomName === key);
  if (!hit) {
    return { pmsCode: null, matchedOtaRoomName: null, requiresManualMapping: true };
  }
  return {
    pmsCode: hit.pmsCode,
    matchedOtaRoomName: hit.otaRoomName,
    requiresManualMapping: false,
  };
}

/**
 * Optional secondary lookup by the platform's own room-type id.
 *
 * Only used when the platform actually supplies one (Agoda does; CTrip has not
 * given us any, so its rows carry null and this never matches for CTrip).
 */
export function resolveOtaRoomCodeById(
  otaRoomTypeId: string | null | undefined,
  mappings: readonly OtaRoomMappingConfig[],
): RoomMappingResolution {
  if (!otaRoomTypeId) {
    return { pmsCode: null, matchedOtaRoomName: null, requiresManualMapping: true };
  }
  const hit = mappings.find((m) => m.otaRoomTypeId === otaRoomTypeId);
  if (!hit) {
    return { pmsCode: null, matchedOtaRoomName: null, requiresManualMapping: true };
  }
  return {
    pmsCode: hit.pmsCode,
    matchedOtaRoomName: hit.otaRoomName,
    requiresManualMapping: false,
  };
}
