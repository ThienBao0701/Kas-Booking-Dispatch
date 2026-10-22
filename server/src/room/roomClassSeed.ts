/**
 * Materialises the confirmed room-class catalogue as each branch's version 1.
 *
 * Idempotent and non-destructive, in the same spirit as the branch seed:
 *  - a branch that ALREADY has any mapping version is left completely alone,
 *    so re-running never disturbs a configuration an Admin has since edited,
 *    never resurrects a class they deactivated and never renumbers versions;
 *  - branches are found by their STABLE code, never by number or row order;
 *  - a branch code that does not exist is skipped and reported, never created.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { BRANCH_ROOM_CLASS_SEED } from './roomClassCatalog';
import { normalizePmsCode, normalizeRoomClassName } from './roomClassResolver';

export interface RoomClassSeedResult {
  /** Branches that received a brand-new version 1. */
  branchesSeeded: string[];
  /** Branches skipped because they already have a mapping version. */
  branchesSkipped: string[];
  /** Seed entries whose branch code is not in the database. */
  branchesMissing: string[];
  roomClassesCreated: number;
  aliasesCreated: number;
}

/**
 * Seeds version 1 for every branch that has no mapping at all.
 *
 * The whole of one branch is written inside a transaction, so a branch can
 * never end up with a half-populated ACTIVE version.
 */
export async function seedBranchRoomClasses(
  client: PrismaClient = defaultPrisma,
): Promise<RoomClassSeedResult> {
  const result: RoomClassSeedResult = {
    branchesSeeded: [],
    branchesSkipped: [],
    branchesMissing: [],
    roomClassesCreated: 0,
    aliasesCreated: 0,
  };

  for (const seed of BRANCH_ROOM_CLASS_SEED) {
    const branch = await client.branch.findUnique({ where: { code: seed.branchCode } });
    if (!branch) {
      result.branchesMissing.push(seed.branchCode);
      continue;
    }

    const existing = await client.branchRoomMappingVersion.count({ where: { branchId: branch.id } });
    if (existing > 0) {
      result.branchesSkipped.push(seed.branchCode);
      continue;
    }

    await client.$transaction(async (tx) => {
      const version = await tx.branchRoomMappingVersion.create({
        data: {
          branchId: branch.id,
          versionNumber: 1,
          status: 'ACTIVE',
          activatedAt: new Date(),
          changeReason: `Cấu hình hạng phòng ban đầu (${seed.cnLabel}).`,
        },
      });

      for (const [index, cls] of seed.classes.entries()) {
        const normalizedName = normalizeRoomClassName(cls.displayName);
        const created = await tx.branchRoomClass.create({
          data: {
            branchId: branch.id,
            versionId: version.id,
            stableKey: cls.stableKey,
            displayName: cls.displayName,
            normalizedName,
            pmsCode: normalizePmsCode(cls.pmsCode),
            active: true,
            sortOrder: index,
          },
        });
        result.roomClassesCreated += 1;

        // Aliases that normalise to the class's own name, or that collide with
        // another alias already claimed in this version, are dropped rather
        // than failing the seed — the unique index is the real guarantee.
        const claimed = new Set<string>([normalizedName]);
        for (const alias of cls.aliases) {
          const normalizedAlias = normalizeRoomClassName(alias);
          if (normalizedAlias.length === 0 || claimed.has(normalizedAlias)) continue;
          claimed.add(normalizedAlias);
          await tx.branchRoomClassAlias.create({
            data: {
              roomClassId: created.id,
              versionId: version.id,
              branchId: branch.id,
              alias,
              normalizedAlias,
              source: 'SEED',
              active: true,
            },
          });
          result.aliasesCreated += 1;
        }
      }
    });

    result.branchesSeeded.push(seed.branchCode);
  }

  return result;
}

/**
 * Cross-class alias collisions inside ONE branch would make resolution
 * ambiguous, so they must be impossible. The seed builds `claimed` per class,
 * but two different classes could still propose the same alias; the
 * `(versionId, normalizedAlias)` unique index rejects that at write time.
 * This helper reports such conflicts up-front for tests and for draft
 * validation, where a friendly error is better than a constraint violation.
 */
export function findSeedAliasConflicts(): { branchCode: string; alias: string; classes: string[] }[] {
  const conflicts: { branchCode: string; alias: string; classes: string[] }[] = [];

  for (const seed of BRANCH_ROOM_CLASS_SEED) {
    const owner = new Map<string, string[]>();
    for (const cls of seed.classes) {
      const keys = new Set<string>([
        normalizeRoomClassName(cls.displayName),
        ...cls.aliases.map(normalizeRoomClassName),
      ]);
      for (const key of keys) {
        if (key.length === 0) continue;
        owner.set(key, [...(owner.get(key) ?? []), cls.stableKey]);
      }
    }
    for (const [key, owners] of owner) {
      if (owners.length > 1) {
        conflicts.push({ branchCode: seed.branchCode, alias: key, classes: owners });
      }
    }
  }

  return conflicts;
}
