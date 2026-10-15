/**
 * Seeds the per-platform OTA room mappings.
 *
 * Idempotent and non-destructive, like every other seed here:
 *  - a (branch, platform, OTA room name) that already exists is left untouched,
 *    so an Admin edit is never overwritten and a re-run changes nothing;
 *  - branches are found by STABLE code, never by number or row order;
 *  - a branch code that is not in the database is skipped and reported.
 *
 * AGODA AND CTRIP ARE WRITTEN AS INDEPENDENT ROWS. The names are identical
 * today, which is exactly why they must not share storage: renaming a room on
 * Agoda must never change what a CTrip booking resolves to. Agoda rows carry
 * Agoda's real room-type id; CTrip rows carry NULL, because no CTrip identifier
 * has been supplied and borrowing Agoda's would be a fabricated fact.
 *
 * Every seeded PMS code is validated against the branch's ACTIVE room-class
 * catalogue: a mapping that names a code the branch does not have would produce
 * a PMS note the hotel system cannot accept, so it is refused and reported
 * rather than written.
 */
import type { OtaPlatform, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { normalizeText } from '../booking/text';
import { BRANCH_OTA_ROOM_MAPPING_SEED, MAPPED_PLATFORMS } from './otaRoomMappingCatalog';

export interface OtaRoomMappingSeedResult {
  /** Rows created, per platform. */
  created: Record<string, number>;
  /** Rows already present and therefore left alone. */
  skipped: number;
  /** Seed entries whose branch code is not in the database. */
  branchesMissing: string[];
  /**
   * Mappings refused because the branch's active catalogue has no such PMS
   * code. Reported, never written — a bad code would reach the hotel PMS.
   */
  unknownPmsCodes: { branchCode: string; otaRoomName: string; pmsCode: string }[];
}

export async function seedOtaRoomMappings(
  client: PrismaClient = defaultPrisma,
): Promise<OtaRoomMappingSeedResult> {
  const result: OtaRoomMappingSeedResult = {
    created: Object.fromEntries(MAPPED_PLATFORMS.map((p) => [p, 0])),
    skipped: 0,
    branchesMissing: [],
    unknownPmsCodes: [],
  };

  const existing = await client.branchOtaRoomMapping.findMany({
    select: { branchId: true, platform: true, normalizedOtaRoomName: true },
  });
  const present = new Set(
    existing.map((m) => `${m.branchId}:${m.platform}:${m.normalizedOtaRoomName}`),
  );

  for (const seed of BRANCH_OTA_ROOM_MAPPING_SEED) {
    const branch = await client.branch.findUnique({ where: { code: seed.branchCode } });
    if (!branch) {
      result.branchesMissing.push(seed.branchCode);
      continue;
    }

    // The branch's own live catalogue decides which codes are legal.
    const activeVersion = await client.branchRoomMappingVersion.findFirst({
      where: { branchId: branch.id, status: 'ACTIVE' },
      select: { id: true },
    });
    const validCodes = new Set(
      activeVersion
        ? (
            await client.branchRoomClass.findMany({
              where: { versionId: activeVersion.id, active: true },
              select: { pmsCode: true },
            })
          ).map((c) => c.pmsCode)
        : [],
    );

    for (const room of seed.rooms) {
      const normalizedOtaRoomName = normalizeText(room.otaRoomName);
      if (normalizedOtaRoomName.length === 0) continue;

      if (validCodes.size > 0 && !validCodes.has(room.pmsCode)) {
        result.unknownPmsCodes.push({
          branchCode: seed.branchCode,
          otaRoomName: room.otaRoomName,
          pmsCode: room.pmsCode,
        });
        continue;
      }

      for (const platform of MAPPED_PLATFORMS) {
        const key = `${branch.id}:${platform}:${normalizedOtaRoomName}`;
        if (present.has(key)) {
          result.skipped += 1;
          continue;
        }

        await client.branchOtaRoomMapping.create({
          data: {
            branchId: branch.id,
            platform: platform as OtaPlatform,
            otaRoomName: room.otaRoomName,
            normalizedOtaRoomName,
            // Agoda's real identifier only. CTrip has supplied none, and an
            // Agoda id is never borrowed to fill the gap.
            otaRoomTypeId: platform === 'AGODA' ? (room.agodaRoomTypeId ?? null) : null,
            pmsCode: room.pmsCode,
          },
        });
        await client.branchOtaRoomMappingEvent.create({
          data: {
            branchId: branch.id,
            platform: platform as OtaPlatform,
            action: 'MAPPING_CREATED',
            otaRoomName: room.otaRoomName,
            oldPmsCode: null,
            newPmsCode: room.pmsCode,
            reason: 'SEED',
          },
        });

        present.add(key);
        result.created[platform] = (result.created[platform] ?? 0) + 1;
      }
    }
  }

  return result;
}
