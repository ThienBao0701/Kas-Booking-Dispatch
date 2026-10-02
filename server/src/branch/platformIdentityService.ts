/**
 * Admin management of the ONE current hotel name per (branch, platform).
 *
 * Invariants, all enforced by the DATABASE rather than by read-then-write
 * checks (two writers under READ COMMITTED can interleave a check and a write):
 *   - exactly one current identity per (branch, platform);
 *   - a normalised name resolves to exactly ONE branch on a platform.
 *
 * Both unique violations are translated into operator-facing Vietnamese errors,
 * so a concurrent request never surfaces a raw constraint name.
 *
 * Nothing is ever hard-lost: replacing or deleting an identity writes the old
 * value to the immutable BranchPlatformIdentityEvent trail first.
 */
import type { OtaPlatform, Prisma, PrismaClient, UserRole } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { normalizeText } from '../booking/text';
import { OTA_PLATFORMS } from '../db/platformIdentitySeed';

export { OTA_PLATFORMS };

/**
 * Server-side platform validation. The client's value is never trusted: only
 * these five strings are accepted, and anything else is a 422 before a query
 * is issued.
 */
export const platformSchema = z.enum([
  'BOOKING_COM',
  'AGODA',
  'CTRIP',
  'TRIPADVISOR',
  'TRAVELOKA',
]);

export const setIdentitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Tên khách sạn không được để trống.')
    .max(200, 'Tên khách sạn quá dài.'),
});

export type SetIdentityInput = z.infer<typeof setIdentitySchema>;

export interface Actor {
  id: number | null;
  role: UserRole | null;
  correlationId?: string | null;
}

export interface PlatformIdentityView {
  platform: OtaPlatform;
  /** null means "Chưa thiết lập" — no current name on this platform. */
  name: string | null;
  normalizedName: string | null;
  needsConfirmation: boolean;
  updatedAt: string | null;
}

export interface IdentityHistoryEntry {
  id: string;
  platform: OtaPlatform;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actor: { id: number; fullName: string } | null;
  correlationId: string | null;
  createdAt: string;
}

/** Parses and validates a platform from an untrusted route parameter. */
export function parsePlatform(raw: string | undefined): OtaPlatform {
  const parsed = platformSchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      `Nền tảng không hợp lệ. Chỉ chấp nhận: ${OTA_PLATFORMS.join(', ')}.`,
    );
  }
  return parsed.data;
}

async function assertBranchExists(client: PrismaClient, branchId: number): Promise<void> {
  const branch = await client.branch.findUnique({ where: { id: branchId }, select: { id: true } });
  if (!branch) throw ApiError.notFound('Không tìm thấy chi nhánh.');
}

/**
 * Every platform row for one branch, including the ones with no value yet, so
 * the UI can render a complete five-row table with a clear empty state.
 */
export async function listIdentities(
  branchId: number,
  client: PrismaClient = defaultPrisma,
): Promise<PlatformIdentityView[]> {
  await assertBranchExists(client, branchId);
  const rows = await client.branchPlatformIdentity.findMany({ where: { branchId } });
  const byPlatform = new Map(rows.map((r) => [r.platform, r]));

  return OTA_PLATFORMS.map((platform) => {
    const row = byPlatform.get(platform);
    return {
      platform,
      name: row?.name ?? null,
      normalizedName: row?.normalizedName ?? null,
      needsConfirmation: row?.identityNeedsConfirmation ?? false,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });
}

/** Translates the two unique constraints into operator-facing messages. */
function translateUniqueViolation(error: unknown, name: string): never {
  if (
    error instanceof PrismaNS.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    const target = String(error.meta?.target ?? '');
    if (target.includes('normalizedName')) {
      throw ApiError.conflict(
        `Tên "${name}" đã được dùng cho một chi nhánh khác trên nền tảng này.`,
      );
    }
    throw ApiError.conflict(
      'Chi nhánh này vừa được cập nhật ở nơi khác. Vui lòng tải lại và thử lại.',
    );
  }
  throw error;
}

/**
 * Creates or replaces the current identity — one call, one row.
 *
 * Replacement rather than a second row is the whole contract: `upsert` on the
 * (branchId, platform) unique key means two concurrent requests cannot leave
 * two current names behind. The previous value is written to the audit trail in
 * the same transaction, so history can never diverge from the current value.
 */
export async function setIdentity(
  branchId: number,
  platform: OtaPlatform,
  input: SetIdentityInput,
  actor: Actor,
  client: PrismaClient = defaultPrisma,
): Promise<PlatformIdentityView[]> {
  await assertBranchExists(client, branchId);

  const name = input.name.trim();
  const normalizedName = normalizeText(name);
  if (normalizedName.length === 0) {
    throw ApiError.validation('Tên khách sạn không hợp lệ.');
  }

  try {
    await client.$transaction(async (tx) => {
      const existing = await tx.branchPlatformIdentity.findUnique({
        where: { branchId_platform: { branchId, platform } },
      });

      await tx.branchPlatformIdentity.upsert({
        where: { branchId_platform: { branchId, platform } },
        create: {
          branchId,
          platform,
          name,
          normalizedName,
          createdByUserId: actor.id,
          updatedByUserId: actor.id,
        },
        update: {
          name,
          normalizedName,
          updatedByUserId: actor.id,
          // An explicit Admin edit resolves any migration ambiguity.
          identityNeedsConfirmation: false,
        },
      });

      await tx.branchPlatformIdentityEvent.create({
        data: {
          branchId,
          platform,
          action: existing ? 'IDENTITY_UPDATED' : 'IDENTITY_CREATED',
          oldValue: existing?.name ?? null,
          newValue: name,
          reason: existing?.identityNeedsConfirmation ? 'AMBIGUITY_RESOLVED' : null,
          actorUserId: actor.id,
          actorRole: actor.role,
          correlationId: actor.correlationId ?? null,
        },
      });
    });
  } catch (error) {
    translateUniqueViolation(error, name);
  }

  return listIdentities(branchId, client);
}

/**
 * Removes the identity from active recognition.
 *
 * The row goes; the history stays. From the next extraction onwards the name no
 * longer resolves to anything, which is the point — but every booking already
 * dispatched keeps its stored branch and its snapshots untouched, because
 * nothing here writes to Booking.
 */
export async function deleteIdentity(
  branchId: number,
  platform: OtaPlatform,
  actor: Actor,
  client: PrismaClient = defaultPrisma,
): Promise<PlatformIdentityView[]> {
  await assertBranchExists(client, branchId);

  await client.$transaction(async (tx) => {
    const existing = await tx.branchPlatformIdentity.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) {
      throw ApiError.notFound('Chi nhánh chưa thiết lập tên trên nền tảng này.');
    }

    await tx.branchPlatformIdentity.delete({
      where: { branchId_platform: { branchId, platform } },
    });

    await tx.branchPlatformIdentityEvent.create({
      data: {
        branchId,
        platform,
        action: 'IDENTITY_DELETED',
        oldValue: existing.name,
        newValue: null,
        actorUserId: actor.id,
        actorRole: actor.role,
        correlationId: actor.correlationId ?? null,
      },
    });
  });

  return listIdentities(branchId, client);
}

/** The immutable trail, newest first. Never mixed into the current-value list. */
export async function listIdentityHistory(
  branchId: number,
  client: PrismaClient = defaultPrisma,
): Promise<IdentityHistoryEntry[]> {
  await assertBranchExists(client, branchId);
  const rows = await client.branchPlatformIdentityEvent.findMany({
    where: { branchId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { actor: { select: { id: true, fullName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    action: r.action,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    actor: r.actor ? { id: r.actor.id, fullName: r.actor.fullName } : null,
    correlationId: r.correlationId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Clears the migration ambiguity flag once an Admin has checked the value. */
export async function confirmIdentity(
  branchId: number,
  platform: OtaPlatform,
  actor: Actor,
  client: PrismaClient = defaultPrisma,
): Promise<PlatformIdentityView[]> {
  await assertBranchExists(client, branchId);

  await client.$transaction(async (tx) => {
    const existing = await tx.branchPlatformIdentity.findUnique({
      where: { branchId_platform: { branchId, platform } },
    });
    if (!existing) {
      throw ApiError.notFound('Chi nhánh chưa thiết lập tên trên nền tảng này.');
    }
    if (!existing.identityNeedsConfirmation) return;

    await tx.branchPlatformIdentity.update({
      where: { branchId_platform: { branchId, platform } },
      data: { identityNeedsConfirmation: false, updatedByUserId: actor.id },
    });
    await tx.branchPlatformIdentityEvent.create({
      data: {
        branchId,
        platform,
        action: 'IDENTITY_CONFIRMED',
        oldValue: existing.name,
        newValue: existing.name,
        actorUserId: actor.id,
        actorRole: actor.role,
        correlationId: actor.correlationId ?? null,
      },
    });
  });

  return listIdentities(branchId, client);
}

/** Shape the branch-config loader needs; keeps Prisma out of the resolver. */
export interface PlatformIdentityConfig {
  platform: OtaPlatform;
  name: string;
  normalizedName: string;
}

export async function loadIdentitiesByBranch(
  client: PrismaClient = defaultPrisma,
): Promise<Map<number, PlatformIdentityConfig[]>> {
  const rows = await client.branchPlatformIdentity.findMany({
    select: { branchId: true, platform: true, name: true, normalizedName: true },
  });
  const map = new Map<number, PlatformIdentityConfig[]>();
  for (const row of rows) {
    const list = map.get(row.branchId) ?? [];
    list.push({ platform: row.platform, name: row.name, normalizedName: row.normalizedName });
    map.set(row.branchId, list);
  }
  return map;
}

/** Convenience for tests/tools: the Prisma include shape is intentionally local. */
export type IdentityRow = Prisma.BranchPlatformIdentityGetPayload<Record<string, never>>;
