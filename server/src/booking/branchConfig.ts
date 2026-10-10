/**
 * The one place the database-backed branch routing configuration is loaded.
 *
 * Architecture (Milestone C.3.7 §8): a route/service loads active branches with
 * their active platform aliases **once**, and passes the plain configuration to
 * the parser/resolver. No regex or parser helper ever touches Prisma, so the
 * extraction engine stays a pure, testable function of (text, configuration).
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { hasLegacyDefaults } from './branchMatcher';
import type { BranchIdentity } from './identityResolver';
import type { BranchAliasConfig, MatchableBranch } from './types';

/** An active branch plus the platform names that route to it. */
export interface BranchConfig extends MatchableBranch {
  active: boolean;
  branchNumber: number;
  aliases?: readonly BranchAliasConfig[];
  /**
   * The branch's CURRENT name on each platform. This is what recognition
   * resolves against; `aliases` is the superseded model kept for one release.
   */
  identities: readonly BranchIdentity[];
}

/**
 * Active branches, ordered by branch number, each with its ACTIVE aliases.
 *
 * One of the eight originally seeded branches that has no alias row at all (a
 * database migrated but not yet seeded/backfilled) deliberately gets
 * `aliases: undefined`, which makes the matcher fall back to the legacy in-code
 * names — so routing keeps working immediately after the migration. As soon as
 * such a branch owns at least one alias row, its configuration is authoritative
 * and the fallback stops: an Admin who deactivates a name really does stop
 * routing it. A branch added later has no legacy defaults and therefore routes
 * strictly by its configured aliases.
 */
export async function loadBranchConfigs(
  client: PrismaClient = defaultPrisma,
): Promise<BranchConfig[]> {
  const branches = await client.branch.findMany({
    where: { active: true },
    orderBy: [{ branchNumber: 'asc' }, { id: 'asc' }],
    include: { aliases: true, platformIdentities: true },
  });

  return branches.map((b) => ({
    id: b.id,
    code: b.code,
    hotelName: b.hotelName,
    address: b.address,
    active: b.active,
    branchNumber: b.branchNumber,
    identities: b.platformIdentities.map((i) => ({
      platform: i.platform,
      name: i.name,
      normalizedName: i.normalizedName,
    })),
    aliases:
      b.aliases.length === 0 && hasLegacyDefaults(b.code)
        ? undefined
        : b.aliases
            .filter((a) => a.active)
            .map((a) => ({
              source: a.source,
              alias: a.alias,
              matchMode: a.matchMode,
              priority: a.priority,
            })),
  }));
}
