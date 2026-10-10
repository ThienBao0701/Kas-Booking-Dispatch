import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';
import { BRANCHES } from './branches';
import { AGODA_HOTEL_NAMES, BRANCH_ALIASES } from '../booking/branchMatcher';
import { normalizeText } from '../booking/text';
import { seedBranchRoomClasses } from '../room/roomClassSeed';
import { seedOtaRoomMappings } from '../room/otaRoomMappingSeed';
import { seedPlatformIdentities } from './platformIdentitySeed';

/**
 * Seeds the initial branches. Upserts by `code`, so running it repeatedly updates
 * names/addresses in place and never creates duplicates — and never deletes a
 * branch the Admin added afterwards.
 *
 * `branchNumber` is only ever *filled in* here: an existing branch the Admin has
 * renumbered keeps its number, so re-seeding can never silently renumber live
 * branches. Internal name and address are refreshed from the seed as before.
 */
export async function seedBranches(client: PrismaClient = defaultPrisma): Promise<number> {
  for (const branch of BRANCHES) {
    const existing = await client.branch.findUnique({ where: { code: branch.code } });
    await client.branch.upsert({
      where: { code: branch.code },
      update: {
        hotelName: branch.hotelName,
        address: branch.address,
        // Backfill only: 0 means "never numbered" (a database migrated before
        // branch numbers existed). An operator-chosen number is preserved.
        ...(existing && existing.branchNumber > 0 ? {} : { branchNumber: branch.branchNumber }),
      },
      create: {
        code: branch.code,
        hotelName: branch.hotelName,
        address: branch.address,
        branchNumber: branch.branchNumber,
        active: true,
      },
    });
  }

  await backfillBranchAliases(client);
  // The ONE current hotel name per (branch, platform). Runs after the alias
  // backfill so the legacy rows it migrates from already exist, and it only
  // ever fills gaps — an Admin-edited identity is never overwritten.
  await seedPlatformIdentities(client);
  // Version 1 of each branch's room classes. Skips any branch that already has
  // a mapping, so an Admin-edited configuration is never disturbed.
  await seedBranchRoomClasses(client);
  // Per-platform OTA room mappings. Runs AFTER the room classes so every PMS
  // code can be validated against the branch's active catalogue.
  await seedOtaRoomMappings(client);

  return client.branch.count();
}

/** One platform hotel name to backfill, resolved by stable branch code. */
interface AliasSeed {
  branchCode: string;
  source: 'BOOKING_COM' | 'AGODA';
  alias: string;
  matchMode: 'EXACT' | 'SIMILARITY';
}

/**
 * Every Booking.com and Agoda hotel name the application used to hardcode, as
 * database alias rows. Ordering is by stable branch code — never by row order —
 * so a re-run can never attach a name to the wrong branch.
 *
 * Booking.com names keep SIMILARITY matching (Booking.com truncates names in its
 * own emails: "Ben Than", "Luxur"). Agoda names are EXACT: every "KAS …" name
 * shares the tokens KAS/Hotel, so fuzzy matching could dispatch to the wrong
 * property.
 */
export function branchAliasSeeds(): AliasSeed[] {
  const seeds: AliasSeed[] = [];

  for (const branch of BRANCHES) {
    // The branch's original Booking.com name (also its internal display name).
    seeds.push({
      branchCode: branch.code,
      source: 'BOOKING_COM',
      alias: branch.hotelName,
      matchMode: 'SIMILARITY',
    });
    // Current and historical Booking.com public names.
    for (const alias of BRANCH_ALIASES[branch.code] ?? []) {
      seeds.push({ branchCode: branch.code, source: 'BOOKING_COM', alias, matchMode: 'SIMILARITY' });
    }
  }

  for (const entry of AGODA_HOTEL_NAMES) {
    if (!entry.branchCode) continue; // an unconfirmed pairing is never guessed
    seeds.push({
      branchCode: entry.branchCode,
      source: 'AGODA',
      alias: entry.name,
      matchMode: 'EXACT',
    });
  }

  return seeds;
}

/**
 * Idempotent backfill of the platform aliases. Existing rows are left untouched
 * (an Admin may have renamed or deactivated one), so re-seeding never resurrects
 * a name the operator deliberately disabled and never creates duplicates.
 */
export async function backfillBranchAliases(
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  const branchIdByCode = new Map(
    (await client.branch.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id]),
  );
  const existing = await client.branchSourceAlias.findMany({
    select: { branchId: true, source: true, normalizedAlias: true, active: true },
  });
  // Already stored for this branch (active or not) — leave it exactly as it is.
  const stored = new Set(existing.map((a) => `${a.branchId}:${a.source}:${a.normalizedAlias}`));
  // Already routed by some branch — a second owner would make the name ambiguous.
  const activeOwners = new Set(
    existing.filter((a) => a.active).map((a) => `${a.source}:${a.normalizedAlias}`),
  );

  const rows = [];
  for (const seed of branchAliasSeeds()) {
    const branchId = branchIdByCode.get(seed.branchCode);
    if (branchId === undefined) continue;

    const normalizedAlias = normalizeText(seed.alias);
    if (normalizedAlias.length === 0) continue;
    if (stored.has(`${branchId}:${seed.source}:${normalizedAlias}`)) continue;
    if (activeOwners.has(`${seed.source}:${normalizedAlias}`)) continue;

    rows.push({
      branchId,
      source: seed.source,
      alias: seed.alias,
      normalizedAlias,
      matchMode: seed.matchMode,
      active: true,
    });
    stored.add(`${branchId}:${seed.source}:${normalizedAlias}`);
    activeOwners.add(`${seed.source}:${normalizedAlias}`);
  }

  if (rows.length === 0) return 0;
  await client.branchSourceAlias.createMany({ data: rows });
  return rows.length;
}

async function main(): Promise<void> {
  const total = await seedBranches();
  const aliases = await defaultPrisma.branchSourceAlias.count();
  // eslint-disable-next-line no-console
  console.log(
    `Seed hoàn tất: ${BRANCHES.length} chi nhánh đã được ghi, tổng cộng ${total} chi nhánh trong cơ sở dữ liệu, ${aliases} tên khách sạn trên các nền tảng.`,
  );
}

// Only run when executed directly (npm run db:seed), not when imported by tests.
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Seed thất bại:', error);
      process.exitCode = 1;
    })
    .finally(() => {
      void defaultPrisma.$disconnect();
    });
}
