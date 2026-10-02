/**
 * Seeds and migrates the ONE current platform identity per (branch, platform).
 *
 * Two different kinds of data meet here, and they are treated differently on
 * purpose:
 *
 *  1. BOOKING_COM — the operator supplied the eight current public names. They
 *     are authoritative, keyed by STABLE BRANCH CODE, and they supersede
 *     whatever the legacy alias table happened to contain. Every active legacy
 *     Booking.com alias is still written to the audit trail as IDENTITY_MIGRATED
 *     so a superseded name is never lost.
 *
 *  2. Every other platform — migrated from `BranchSourceAlias` deterministically
 *     (priority DESC, then id ASC, among ACTIVE rows). When more than one alias
 *     competes, one is chosen so recognition keeps working, the identity is
 *     flagged `identityNeedsConfirmation`, and each competing name is preserved
 *     as its own IDENTITY_MIGRATED event. Nothing is silently discarded.
 *
 * Idempotent: an identity that already exists is never overwritten, because an
 * Admin may have edited it since the first run. Re-running only fills gaps.
 *
 * Nothing here assumes branch database ids, branch ordering, or list position —
 * every lookup is by stable code.
 */
import type { OtaPlatform, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';
import { normalizeText } from '../booking/text';

/** Every platform an operator can configure. The single source for the UI/API. */
export const OTA_PLATFORMS: readonly OtaPlatform[] = [
  'BOOKING_COM',
  'AGODA',
  'CTRIP',
  'TRIPADVISOR',
  'TRAVELOKA',
] as const;

/**
 * The platforms an OTA booking can currently be taken in through. Tripadvisor
 * and Traveloka remain valid identity platforms — an operator may configure a
 * name for them — but no intake parser produces them yet.
 */
export const OPERATIONAL_PLATFORMS: readonly OtaPlatform[] = [
  'BOOKING_COM',
  'AGODA',
  'CTRIP',
] as const;

/** One branch's current public name on one platform, keyed by stable code. */
export interface PlatformIdentitySeed {
  branchCode: string;
  platform: OtaPlatform;
  name: string;
}

/**
 * The authoritative current public names, by STABLE BRANCH CODE.
 *
 * SEED CONFIGURATION, NOT PARSER LOGIC. Once seeded the value lives in the
 * database and the Admin renames it from the UI, so a property being renamed on
 * an OTA never needs a code change. No matcher reads this table at runtime —
 * recognition resolves against `BranchPlatformIdentity` rows loaded by
 * `loadBranchConfigs`.
 *
 * The three platforms are INDEPENDENT records. CTrip starts out identical to
 * Agoda because the properties are listed under the same names today, but the
 * rows are separate from the moment they are created: editing or deleting one
 * platform never touches another.
 */
export const PLATFORM_IDENTITY_SEED: readonly PlatformIdentitySeed[] = [
  // Branch 1
  { branchCode: 'TRUONG_DINH_05', platform: 'BOOKING_COM', name: 'Market Ben Thanh Kas Hotel Passion' },
  { branchCode: 'TRUONG_DINH_05', platform: 'AGODA', name: 'KAS Passion Boutique Hotel' },
  { branchCode: 'TRUONG_DINH_05', platform: 'CTRIP', name: 'KAS Passion Boutique Hotel' },
  // Branch 2
  { branchCode: 'LY_TU_TRONG_260', platform: 'BOOKING_COM', name: 'Elegance Hotel - Ben Thanh Market - Central HCMC' },
  { branchCode: 'LY_TU_TRONG_260', platform: 'AGODA', name: 'KAS Elegance Hotel' },
  { branchCode: 'LY_TU_TRONG_260', platform: 'CTRIP', name: 'KAS Elegance Hotel' },
  // Branch 3
  { branchCode: 'NGUYEN_TRAI_47A', platform: 'BOOKING_COM', name: 'Boutique KAS Luxury Hotel' },
  { branchCode: 'NGUYEN_TRAI_47A', platform: 'AGODA', name: 'KAS Ancient Boutique Hotel' },
  { branchCode: 'NGUYEN_TRAI_47A', platform: 'CTRIP', name: 'KAS Ancient Boutique Hotel' },
  // Branch 4
  { branchCode: 'NGUYEN_THAI_BINH_170', platform: 'BOOKING_COM', name: 'Grand KAS Premium Hotel & Sky Bar' },
  { branchCode: 'NGUYEN_THAI_BINH_170', platform: 'AGODA', name: 'KAS Milestone Premium Hotel' },
  { branchCode: 'NGUYEN_THAI_BINH_170', platform: 'CTRIP', name: 'KAS Milestone Premium Hotel' },
  // Branch 5
  { branchCode: 'LE_THANH_TON_278', platform: 'BOOKING_COM', name: 'Zody KAS Hotel - Saigon Center' },
  { branchCode: 'LE_THANH_TON_278', platform: 'AGODA', name: 'KAS Zody Boutique Hotel' },
  { branchCode: 'LE_THANH_TON_278', platform: 'CTRIP', name: 'KAS Zody Boutique Hotel' },
  // Branch 6
  {
    branchCode: 'BUI_THI_XUAN_40',
    platform: 'BOOKING_COM',
    name: 'Ben Thanh Market - Luxury Kas Boutique Hotel - Thai Cuisine Restaurant',
  },
  { branchCode: 'BUI_THI_XUAN_40', platform: 'AGODA', name: 'KAS Sonata Luxury Hotel' },
  { branchCode: 'BUI_THI_XUAN_40', platform: 'CTRIP', name: 'KAS Sonata Luxury Hotel' },
  // Branch 7
  { branchCode: 'BUI_THI_XUAN_13', platform: 'BOOKING_COM', name: 'My Eliana Luxury Hotel Saigon Saigon & Spa' },
  { branchCode: 'BUI_THI_XUAN_13', platform: 'AGODA', name: 'KAS Eliana Luxury Hotel' },
  { branchCode: 'BUI_THI_XUAN_13', platform: 'CTRIP', name: 'KAS Eliana Luxury Hotel' },
  // Branch 8
  { branchCode: 'LE_THANH_TON_191', platform: 'BOOKING_COM', name: 'Ben Thanh Luxury Hotel - Premium Kas Dilly & Spa' },
  { branchCode: 'LE_THANH_TON_191', platform: 'AGODA', name: 'KAS Dilly Hotel' },
  { branchCode: 'LE_THANH_TON_191', platform: 'CTRIP', name: 'KAS Dilly Hotel' },
] as const;

/** Backwards-compatible view: just the Booking.com rows. */
export const BOOKING_COM_IDENTITIES: readonly { branchCode: string; name: string }[] =
  PLATFORM_IDENTITY_SEED.filter((s) => s.platform === 'BOOKING_COM').map((s) => ({
    branchCode: s.branchCode,
    name: s.name,
  }));

/** Legacy alias sources that map onto a real platform. MANUAL/OTHER do not. */
const LEGACY_SOURCE_TO_PLATFORM: Partial<Record<string, OtaPlatform>> = {
  BOOKING_COM: 'BOOKING_COM',
  AGODA: 'AGODA',
};

/** One branch whose legacy aliases competed, so the pick needs confirming. */
export interface AmbiguousIdentity {
  branchCode: string;
  platform: OtaPlatform;
  chosen: string;
  competing: string[];
}

export interface IdentityMigrationReport {
  /** Identities created from the operator-supplied Booking.com list. */
  seeded: number;
  /** Identities created by migrating a legacy alias. */
  migrated: number;
  /** Legacy names preserved as audit events without becoming the current value. */
  supersededRecorded: number;
  /** Branches where the migration had to choose between competing aliases. */
  ambiguous: AmbiguousIdentity[];
  /** Names refused because another branch already owns them on that platform. */
  collisions: { branchCode: string; platform: OtaPlatform; name: string }[];
}

/**
 * Creates the missing current identities and records the superseded ones.
 * Returns a report so a migration run is observable rather than silent.
 */
export async function seedPlatformIdentities(
  client: PrismaClient = defaultPrisma,
): Promise<IdentityMigrationReport> {
  const report: IdentityMigrationReport = {
    seeded: 0,
    migrated: 0,
    supersededRecorded: 0,
    ambiguous: [],
    collisions: [],
  };

  const branches = await client.branch.findMany({ select: { id: true, code: true } });
  const branchByCode = new Map(branches.map((b) => [b.code, b.id]));

  const existing = await client.branchPlatformIdentity.findMany({
    select: { branchId: true, platform: true, normalizedName: true },
  });
  /** (branchId, platform) that already has a current identity. */
  const configured = new Set(existing.map((i) => `${i.branchId}:${i.platform}`));
  /** (platform, normalizedName) already owned by SOME branch. */
  const owned = new Set(existing.map((i) => `${i.platform}:${i.normalizedName}`));

  /** Creates one identity, honouring both uniqueness rules. */
  const create = async (
    branchId: number,
    branchCode: string,
    platform: OtaPlatform,
    name: string,
    needsConfirmation: boolean,
  ): Promise<boolean> => {
    const normalizedName = normalizeText(name);
    if (normalizedName.length === 0) return false;
    if (configured.has(`${branchId}:${platform}`)) return false;
    if (owned.has(`${platform}:${normalizedName}`)) {
      report.collisions.push({ branchCode, platform, name });
      return false;
    }

    await client.branchPlatformIdentity.create({
      data: {
        branchId,
        platform,
        name,
        normalizedName,
        identityNeedsConfirmation: needsConfirmation,
      },
    });
    await client.branchPlatformIdentityEvent.create({
      data: {
        branchId,
        platform,
        action: 'IDENTITY_CREATED',
        oldValue: null,
        newValue: name,
        reason: needsConfirmation ? 'LEGACY_MIGRATION_AMBIGUOUS' : 'SEED',
      },
    });
    configured.add(`${branchId}:${platform}`);
    owned.add(`${platform}:${normalizedName}`);
    return true;
  };

  // Superseded events already written by an earlier run. Re-running the seed
  // must not append a second copy of the same historical fact: the trail is
  // append-only, so a duplicate would be indistinguishable from a real repeat.
  const recorded = new Set(
    (
      await client.branchPlatformIdentityEvent.findMany({
        where: { action: 'IDENTITY_MIGRATED' },
        select: { branchId: true, platform: true, oldValue: true },
      })
    ).map((e) => `${e.branchId}:${e.platform}:${e.oldValue ?? ''}`),
  );

  /** Preserves a name that did NOT become the current identity. Idempotent. */
  const recordSuperseded = async (
    branchId: number,
    platform: OtaPlatform,
    name: string,
    reason: string,
  ): Promise<void> => {
    const key = `${branchId}:${platform}:${name}`;
    if (recorded.has(key)) return;

    await client.branchPlatformIdentityEvent.create({
      data: {
        branchId,
        platform,
        action: 'IDENTITY_MIGRATED',
        oldValue: name,
        newValue: null,
        reason,
      },
    });
    recorded.add(key);
    report.supersededRecorded += 1;
  };

  // ---- 1. Operator-supplied current names (authoritative) ------------------
  // Every platform in the seed is created as its OWN row. `create` skips a
  // (branch, platform) that already has a value, so an Admin edit is never
  // overwritten and re-running this changes nothing.
  for (const entry of PLATFORM_IDENTITY_SEED) {
    const branchId = branchByCode.get(entry.branchCode);
    if (branchId === undefined) continue; // a branch that does not exist here
    if (await create(branchId, entry.branchCode, entry.platform, entry.name, false)) {
      report.seeded += 1;
    }
  }

  // ---- 2. Deterministic migration from the legacy alias table --------------
  // ACTIVE aliases only: a name an Admin deliberately disabled must not come
  // back as the current identity.
  const aliases = await client.branchSourceAlias.findMany({
    where: { active: true },
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
    select: { branchId: true, source: true, alias: true },
  });

  /** branchId -> platform -> aliases, already in (priority DESC, id ASC) order. */
  const grouped = new Map<string, string[]>();
  for (const alias of aliases) {
    const platform = LEGACY_SOURCE_TO_PLATFORM[alias.source];
    if (!platform) continue; // MANUAL / OTHER are not platforms
    const key = `${alias.branchId}:${platform}`;
    const list = grouped.get(key) ?? [];
    list.push(alias.alias);
    grouped.set(key, list);
  }

  const codeById = new Map(branches.map((b) => [b.id, b.code]));

  for (const [key, names] of grouped) {
    const [branchIdRaw, platformRaw] = key.split(':');
    const branchId = Number(branchIdRaw);
    const platform = platformRaw as OtaPlatform;
    const branchCode = codeById.get(branchId) ?? String(branchId);

    if (configured.has(key)) {
      // A current identity already exists (seeded above, or Admin-configured).
      // Every active legacy name is therefore superseded — preserve them all.
      for (const name of names) {
        await recordSuperseded(branchId, platform, name, 'SUPERSEDED_BY_CURRENT_IDENTITY');
      }
      continue;
    }

    const chosen = names[0]!;
    const competing = names.slice(1);
    const ambiguous = competing.length > 0;

    if (await create(branchId, branchCode, platform, chosen, ambiguous)) {
      report.migrated += 1;
      if (ambiguous) {
        report.ambiguous.push({ branchCode, platform, chosen, competing });
      }
    }
    // Whether or not the create succeeded, the names that are not current must
    // survive somewhere an operator can find them.
    for (const name of competing) {
      await recordSuperseded(branchId, platform, name, 'LEGACY_COMPETING_ALIAS');
    }
  }

  return report;
}
