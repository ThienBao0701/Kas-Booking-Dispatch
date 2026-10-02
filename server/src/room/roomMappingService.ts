/**
 * Versioned branch room-class configuration (Phase C.3.8).
 *
 * The safety model:
 *
 *   An Admin NEVER mutates the live mapping. They create a DRAFT copy, edit it
 *   freely while reception keeps working against the untouched ACTIVE version,
 *   validate it, and then activate it in ONE transaction that archives the old
 *   version and promotes the draft. There is no window in which a branch has
 *   zero, two, or half-updated active mappings — the transaction plus the
 *   partial unique index `BranchRoomMappingVersion_one_active_per_branch`
 *   make the invariant unbreakable, even under concurrent activations.
 *
 * Activating a new version never touches a single existing booking: bookings
 * carry an immutable snapshot of the class they were created with.
 */
import type { BranchChangeAction, Prisma, PrismaClient, RoomClassAliasSource } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { normalizePmsCode, normalizeRoomClassName } from './roomClassResolver';

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const displayNameSchema = z.string().trim().min(1, 'Tên hạng phòng không được để trống.').max(120);
const pmsCodeSchema = z.string().trim().min(1, 'Mã PMS không được để trống.').max(40);

export const roomClassInputSchema = z.object({
  displayName: displayNameSchema,
  pmsCode: pmsCodeSchema,
  stableKey: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});

export const roomClassPatchSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    pmsCode: pmsCodeSchema.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật.' });

export const createDraftSchema = z.object({
  changeReason: z.string().trim().max(500).optional(),
});

export const activateDraftSchema = z.object({
  /**
   * The version the Admin believed was active when they reviewed the change.
   * A mismatch means someone else activated in the meantime — we refuse rather
   * than silently overwriting their work (optimistic concurrency).
   */
  expectedActiveVersionId: z.string().trim().min(1).nullable().optional(),
  changeReason: z.string().trim().max(500).optional(),
});

export type RoomClassInput = z.infer<typeof roomClassInputSchema>;
export type RoomClassPatch = z.infer<typeof roomClassPatchSchema>;

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

export interface RoomClassView {
  id: string;
  stableKey: string;
  displayName: string;
  normalizedName: string;
  pmsCode: string;
  active: boolean;
  sortOrder: number;
  aliases: { id: string; alias: string; source: RoomClassAliasSource; active: boolean }[];
  updatedAt: Date;
}

export interface RoomMappingVersionView {
  id: string;
  branchId: number;
  versionNumber: number;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  changeReason: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  archivedAt: Date | null;
  createdBy: { id: number; fullName: string } | null;
  activatedBy: { id: number; fullName: string } | null;
  roomClasses: RoomClassView[];
}

const VERSION_INCLUDE = {
  createdBy: { select: { id: true, fullName: true } },
  activatedBy: { select: { id: true, fullName: true } },
  roomClasses: {
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    include: { aliases: { orderBy: { alias: 'asc' } } },
  },
} satisfies Prisma.BranchRoomMappingVersionInclude;

type VersionRow = Prisma.BranchRoomMappingVersionGetPayload<{ include: typeof VERSION_INCLUDE }>;

function serializeVersion(row: VersionRow): RoomMappingVersionView {
  return {
    id: row.id,
    branchId: row.branchId,
    versionNumber: row.versionNumber,
    status: row.status,
    changeReason: row.changeReason,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
    activatedBy: row.activatedBy ? { id: row.activatedBy.id, fullName: row.activatedBy.fullName } : null,
    roomClasses: row.roomClasses.map((c) => ({
      id: c.id,
      stableKey: c.stableKey,
      displayName: c.displayName,
      normalizedName: c.normalizedName,
      pmsCode: c.pmsCode,
      active: c.active,
      sortOrder: c.sortOrder,
      updatedAt: c.updatedAt,
      aliases: c.aliases.map((a) => ({ id: a.id, alias: a.alias, source: a.source, active: a.active })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

async function audit(
  client: Prisma.TransactionClient | PrismaClient,
  branchId: number,
  action: BranchChangeAction,
  actorId: number | null,
  field?: string | null,
  oldValue?: string | null,
  newValue?: string | null,
): Promise<void> {
  await client.branchChangeLog.create({
    data: {
      branchId,
      action,
      field: field ?? null,
      oldValue: oldValue ?? null,
      newValue: newValue ?? null,
      changedByUserId: actorId,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

async function loadVersionOrThrow(
  client: PrismaClient,
  branchId: number,
  versionId: string,
): Promise<VersionRow> {
  const version = await client.branchRoomMappingVersion.findUnique({
    where: { id: versionId },
    include: VERSION_INCLUDE,
  });
  if (!version) throw ApiError.notFound('Không tìm thấy phiên bản hạng phòng.');
  // A draft belonging to another branch must never be editable from this one.
  if (version.branchId !== branchId) {
    throw ApiError.forbidden('Phiên bản này thuộc chi nhánh khác.');
  }
  return version;
}

export async function getActiveVersion(
  branchId: number,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView | null> {
  const row = await client.branchRoomMappingVersion.findFirst({
    where: { branchId, status: 'ACTIVE' },
    include: VERSION_INCLUDE,
  });
  return row ? serializeVersion(row) : null;
}

export async function getDraftVersion(
  branchId: number,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView | null> {
  const row = await client.branchRoomMappingVersion.findFirst({
    where: { branchId, status: 'DRAFT' },
    orderBy: { createdAt: 'desc' },
    include: VERSION_INCLUDE,
  });
  return row ? serializeVersion(row) : null;
}

export async function listVersions(
  branchId: number,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView[]> {
  const rows = await client.branchRoomMappingVersion.findMany({
    where: { branchId },
    orderBy: { versionNumber: 'desc' },
    include: VERSION_INCLUDE,
  });
  return rows.map(serializeVersion);
}

/* ------------------------------------------------------------------ */
/* Draft lifecycle                                                     */
/* ------------------------------------------------------------------ */

/**
 * Creates a DRAFT copy of the branch's ACTIVE mapping (or an empty draft when
 * the branch has none yet). Only one open draft per branch: an existing draft
 * is returned rather than silently forking a second one.
 */
export async function createDraft(
  branchId: number,
  changeReason: string | undefined,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView> {
  const branch = await client.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw ApiError.notFound('Không tìm thấy chi nhánh.');

  const existingDraft = await getDraftVersion(branchId, client);
  if (existingDraft) return existingDraft;

  const active = await client.branchRoomMappingVersion.findFirst({
    where: { branchId, status: 'ACTIVE' },
    include: { roomClasses: { include: { aliases: true }, orderBy: { sortOrder: 'asc' } } },
  });

  const highest = await client.branchRoomMappingVersion.aggregate({
    where: { branchId },
    _max: { versionNumber: true },
  });
  const nextNumber = (highest._max.versionNumber ?? 0) + 1;

  const draftId = await client.$transaction(async (tx) => {
    const draft = await tx.branchRoomMappingVersion.create({
      data: {
        branchId,
        versionNumber: nextNumber,
        status: 'DRAFT',
        createdByUserId: actorId,
        changeReason: changeReason ?? null,
      },
    });

    // Deep-copy the active configuration so editing the draft cannot possibly
    // reach a row the live mapping is still using.
    for (const cls of active?.roomClasses ?? []) {
      const copy = await tx.branchRoomClass.create({
        data: {
          branchId,
          versionId: draft.id,
          stableKey: cls.stableKey,
          displayName: cls.displayName,
          normalizedName: cls.normalizedName,
          pmsCode: cls.pmsCode,
          active: cls.active,
          sortOrder: cls.sortOrder,
        },
      });
      for (const alias of cls.aliases) {
        await tx.branchRoomClassAlias.create({
          data: {
            roomClassId: copy.id,
            versionId: draft.id,
            branchId,
            alias: alias.alias,
            normalizedAlias: alias.normalizedAlias,
            source: alias.source,
            active: alias.active,
          },
        });
      }
    }

    await audit(tx, branchId, 'ROOM_MAPPING_DRAFT_CREATED', actorId, 'versionNumber', String(active?.versionNumber ?? 0), String(nextNumber));
    return draft.id;
  });

  return serializeVersion(await loadVersionOrThrow(client, branchId, draftId));
}

/** Guard: only a DRAFT may be edited. An archived/active version is immutable. */
async function loadEditableDraft(
  client: PrismaClient,
  branchId: number,
  draftId: string,
): Promise<VersionRow> {
  const version = await loadVersionOrThrow(client, branchId, draftId);
  if (version.status !== 'DRAFT') {
    throw ApiError.conflict('Chỉ có thể chỉnh sửa bản nháp. Phiên bản đang dùng hoặc đã lưu trữ là bất biến.', {
      status: version.status,
    });
  }
  return version;
}

/** Derives a stable key from a display name, unique within the draft. */
function deriveStableKey(displayName: string, taken: Set<string>): string {
  const base = normalizeRoomClassName(displayName).slice(0, 60) || 'room';
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  return key;
}

export async function addRoomClass(
  branchId: number,
  draftId: string,
  input: RoomClassInput,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView> {
  const draft = await loadEditableDraft(client, branchId, draftId);

  const displayName = input.displayName.trim();
  const normalizedName = normalizeRoomClassName(displayName);
  const pmsCode = normalizePmsCode(input.pmsCode);
  if (normalizedName.length === 0) throw ApiError.validation('Tên hạng phòng không hợp lệ.');
  if (pmsCode.length === 0) throw ApiError.validation('Mã PMS không hợp lệ.');

  if (draft.roomClasses.some((c) => c.normalizedName === normalizedName)) {
    throw ApiError.conflict(`Hạng phòng "${displayName}" đã tồn tại trong bản nháp.`);
  }
  if (draft.roomClasses.some((c) => c.pmsCode === pmsCode)) {
    throw ApiError.conflict(`Mã PMS "${pmsCode}" đã được dùng trong bản nháp.`);
  }

  const taken = new Set(draft.roomClasses.map((c) => c.stableKey));
  const stableKey = input.stableKey?.trim() || deriveStableKey(displayName, taken);
  if (taken.has(stableKey)) throw ApiError.conflict('Khoá hạng phòng bị trùng.');

  const aliasKeys = collectAliasKeys(draft);
  const newAliases = uniqueAliases(input.aliases ?? [], normalizedName, aliasKeys);

  await client.$transaction(async (tx) => {
    const created = await tx.branchRoomClass.create({
      data: {
        branchId,
        versionId: draftId,
        stableKey,
        displayName,
        normalizedName,
        pmsCode,
        active: input.active ?? true,
        sortOrder: input.sortOrder ?? draft.roomClasses.length,
      },
    });
    for (const { alias, normalizedAlias } of newAliases) {
      await tx.branchRoomClassAlias.create({
        data: { roomClassId: created.id, versionId: draftId, branchId, alias, normalizedAlias, source: 'ADMIN' },
      });
    }
    await audit(tx, branchId, 'ROOM_CLASS_ADDED', actorId, 'roomClass', null, `${displayName} → ${pmsCode}`);
  });

  return serializeVersion(await loadVersionOrThrow(client, branchId, draftId));
}

export async function updateRoomClass(
  branchId: number,
  draftId: string,
  roomClassId: string,
  patch: RoomClassPatch,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView> {
  const draft = await loadEditableDraft(client, branchId, draftId);
  const target = draft.roomClasses.find((c) => c.id === roomClassId);
  if (!target) throw ApiError.notFound('Không tìm thấy hạng phòng trong bản nháp.');

  const data: Prisma.BranchRoomClassUpdateInput = {};
  const changes: string[] = [];

  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim();
    const normalizedName = normalizeRoomClassName(displayName);
    if (normalizedName.length === 0) throw ApiError.validation('Tên hạng phòng không hợp lệ.');
    if (draft.roomClasses.some((c) => c.id !== roomClassId && c.normalizedName === normalizedName)) {
      throw ApiError.conflict(`Hạng phòng "${displayName}" đã tồn tại trong bản nháp.`);
    }
    data.displayName = displayName;
    data.normalizedName = normalizedName;
    if (displayName !== target.displayName) changes.push(`tên: ${target.displayName} → ${displayName}`);
  }

  if (patch.pmsCode !== undefined) {
    const pmsCode = normalizePmsCode(patch.pmsCode);
    if (pmsCode.length === 0) throw ApiError.validation('Mã PMS không hợp lệ.');
    if (draft.roomClasses.some((c) => c.id !== roomClassId && c.pmsCode === pmsCode)) {
      throw ApiError.conflict(`Mã PMS "${pmsCode}" đã được dùng trong bản nháp.`);
    }
    data.pmsCode = pmsCode;
    if (pmsCode !== target.pmsCode) changes.push(`mã PMS: ${target.pmsCode} → ${pmsCode}`);
  }

  if (patch.active !== undefined) {
    data.active = patch.active;
    if (patch.active !== target.active) changes.push(patch.active ? 'bật lại' : 'ngừng sử dụng');
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;

  await client.$transaction(async (tx) => {
    await tx.branchRoomClass.update({ where: { id: roomClassId }, data });
    if (patch.active === false && target.active) {
      await audit(tx, branchId, 'ROOM_CLASS_DEACTIVATED', actorId, 'roomClass', target.displayName, null);
    } else if (patch.sortOrder !== undefined && changes.length === 0) {
      await audit(tx, branchId, 'ROOM_CLASS_REORDERED', actorId, 'sortOrder', String(target.sortOrder), String(patch.sortOrder));
    } else if (changes.length > 0) {
      await audit(tx, branchId, 'ROOM_CLASS_UPDATED', actorId, target.displayName, target.pmsCode, changes.join('; '));
    }
  });

  return serializeVersion(await loadVersionOrThrow(client, branchId, draftId));
}

/** Every normalized key already claimed in the draft (names + aliases). */
function collectAliasKeys(draft: VersionRow): Set<string> {
  const keys = new Set<string>();
  for (const cls of draft.roomClasses) {
    keys.add(cls.normalizedName);
    for (const alias of cls.aliases) keys.add(alias.normalizedAlias);
  }
  return keys;
}

function uniqueAliases(
  raw: string[],
  ownName: string,
  claimed: Set<string>,
): { alias: string; normalizedAlias: string }[] {
  const out: { alias: string; normalizedAlias: string }[] = [];
  for (const value of raw) {
    const alias = value.trim();
    const normalizedAlias = normalizeRoomClassName(alias);
    if (normalizedAlias.length === 0) continue;
    if (normalizedAlias === ownName) continue; // an alias equal to the name is noise
    if (claimed.has(normalizedAlias)) {
      throw ApiError.conflict(`Tên gọi khác "${alias}" đã được dùng cho một hạng phòng khác trong chi nhánh này.`);
    }
    claimed.add(normalizedAlias);
    out.push({ alias, normalizedAlias });
  }
  return out;
}

export async function addAlias(
  branchId: number,
  draftId: string,
  roomClassId: string,
  aliasText: string,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView> {
  const draft = await loadEditableDraft(client, branchId, draftId);
  const target = draft.roomClasses.find((c) => c.id === roomClassId);
  if (!target) throw ApiError.notFound('Không tìm thấy hạng phòng trong bản nháp.');

  const [entry] = uniqueAliases([aliasText], target.normalizedName, collectAliasKeys(draft));
  if (!entry) throw ApiError.validation('Tên gọi khác không hợp lệ.');

  await client.$transaction(async (tx) => {
    await tx.branchRoomClassAlias.create({
      data: {
        roomClassId,
        versionId: draftId,
        branchId,
        alias: entry.alias,
        normalizedAlias: entry.normalizedAlias,
        source: 'ADMIN',
      },
    });
    await audit(tx, branchId, 'ROOM_CLASS_ALIAS_ADDED', actorId, target.displayName, null, entry.alias);
  });

  return serializeVersion(await loadVersionOrThrow(client, branchId, draftId));
}

export async function removeAlias(
  branchId: number,
  draftId: string,
  aliasId: string,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<RoomMappingVersionView> {
  await loadEditableDraft(client, branchId, draftId);
  const alias = await client.branchRoomClassAlias.findUnique({ where: { id: aliasId } });
  if (!alias || alias.versionId !== draftId) throw ApiError.notFound('Không tìm thấy tên gọi khác.');

  await client.$transaction(async (tx) => {
    await tx.branchRoomClassAlias.delete({ where: { id: aliasId } });
    await audit(tx, branchId, 'ROOM_CLASS_ALIAS_REMOVED', actorId, null, alias.alias, null);
  });

  return serializeVersion(await loadVersionOrThrow(client, branchId, draftId));
}

export async function cancelDraft(
  branchId: number,
  draftId: string,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await loadEditableDraft(client, branchId, draftId);
  await client.$transaction(async (tx) => {
    // Cascades to its room classes and aliases. The ACTIVE version is untouched.
    await tx.branchRoomMappingVersion.delete({ where: { id: draftId } });
    await audit(tx, branchId, 'ROOM_MAPPING_DRAFT_CANCELLED', actorId, 'versionId', draftId, null);
  });
}

/* ------------------------------------------------------------------ */
/* Validation + activation                                             */
/* ------------------------------------------------------------------ */

export interface ValidationProblem {
  code: string;
  message: string;
  roomClassId?: string;
}

export interface DraftValidation {
  ok: boolean;
  problems: ValidationProblem[];
  activeClassCount: number;
}

/**
 * Validates a draft as a whole. Uniqueness is also enforced by database indexes;
 * this produces the friendly, complete list an Admin can act on before they
 * ever press Activate.
 */
export async function validateDraft(
  branchId: number,
  draftId: string,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
  recordAudit = true,
): Promise<DraftValidation> {
  const draft = await loadVersionOrThrow(client, branchId, draftId);
  const problems: ValidationProblem[] = [];

  const names = new Map<string, string>();
  const codes = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const cls of draft.roomClasses) {
    if (cls.displayName.trim().length === 0) {
      problems.push({ code: 'EMPTY_NAME', message: 'Có hạng phòng chưa đặt tên.', roomClassId: cls.id });
    }
    if (cls.pmsCode.trim().length === 0) {
      problems.push({ code: 'EMPTY_PMS_CODE', message: `Hạng phòng "${cls.displayName}" chưa có mã PMS.`, roomClassId: cls.id });
    }
    if (names.has(cls.normalizedName)) {
      problems.push({ code: 'DUPLICATE_NAME', message: `Tên hạng phòng "${cls.displayName}" bị trùng.`, roomClassId: cls.id });
    }
    names.set(cls.normalizedName, cls.id);

    if (cls.active) {
      if (codes.has(cls.pmsCode)) {
        problems.push({ code: 'DUPLICATE_PMS_CODE', message: `Mã PMS "${cls.pmsCode}" bị trùng trong chi nhánh.`, roomClassId: cls.id });
      }
      codes.set(cls.pmsCode, cls.id);
    }

    for (const alias of cls.aliases) {
      if (alias.alias.trim().length === 0) {
        problems.push({ code: 'EMPTY_ALIAS', message: `Hạng phòng "${cls.displayName}" có tên gọi khác rỗng.`, roomClassId: cls.id });
        continue;
      }
      const owner = aliases.get(alias.normalizedAlias) ?? names.get(alias.normalizedAlias);
      if (owner && owner !== cls.id) {
        problems.push({
          code: 'AMBIGUOUS_ALIAS',
          message: `Tên gọi khác "${alias.alias}" trỏ tới nhiều hạng phòng.`,
          roomClassId: cls.id,
        });
      }
      aliases.set(alias.normalizedAlias, cls.id);
    }
  }

  const activeClassCount = draft.roomClasses.filter((c) => c.active).length;
  if (activeClassCount === 0) {
    problems.push({ code: 'EMPTY_MAPPING', message: 'Không thể kích hoạt cấu hình không có hạng phòng nào.' });
  }

  if (recordAudit) {
    await audit(client, branchId, 'ROOM_MAPPING_VALIDATED', actorId, 'versionNumber', String(draft.versionNumber), problems.length === 0 ? 'hợp lệ' : `${problems.length} lỗi`);
  }

  return { ok: problems.length === 0, problems, activeClassCount };
}

export interface ActivationSummary {
  version: RoomMappingVersionView;
  previousVersionNumber: number | null;
  added: string[];
  changed: string[];
  deactivated: string[];
}

/**
 * Atomically promotes a validated draft.
 *
 * Everything happens in one transaction: the current ACTIVE version is archived
 * and the draft promoted. If anything fails, the transaction rolls back and the
 * previous version stays ACTIVE — a failed activation can never leave a branch
 * without a mapping.
 *
 * `expectedActiveVersionId` implements optimistic concurrency: if another Admin
 * activated a different draft since this one was reviewed, activation is
 * rejected with a conflict instead of silently discarding their change.
 */
export async function activateDraft(
  branchId: number,
  draftId: string,
  expectedActiveVersionId: string | null | undefined,
  changeReason: string | undefined,
  actorId: number | null,
  client: PrismaClient = defaultPrisma,
): Promise<ActivationSummary> {
  const validation = await validateDraft(branchId, draftId, actorId, client, false);
  if (!validation.ok) {
    await audit(client, branchId, 'ROOM_MAPPING_ACTIVATION_FAILED', actorId, 'validation', null, validation.problems.map((p) => p.code).join(','));
    throw ApiError.validation('Bản nháp chưa hợp lệ, không thể kích hoạt.', { problems: validation.problems });
  }

  const draft = await loadVersionOrThrow(client, branchId, draftId);
  if (draft.status !== 'DRAFT') {
    throw ApiError.conflict('Chỉ có thể kích hoạt một bản nháp.', { status: draft.status });
  }

  const current = await client.branchRoomMappingVersion.findFirst({
    where: { branchId, status: 'ACTIVE' },
    include: { roomClasses: true },
  });

  // Stale-review check.
  if (expectedActiveVersionId !== undefined && expectedActiveVersionId !== null) {
    if (!current || current.id !== expectedActiveVersionId) {
      await audit(client, branchId, 'ROOM_MAPPING_ACTIVATION_FAILED', actorId, 'staleVersion', expectedActiveVersionId, current?.id ?? null);
      throw ApiError.conflict(
        'Cấu hình đã được người khác cập nhật trong lúc bạn chỉnh sửa. Hãy xem lại thay đổi mới nhất rồi thử lại.',
        { currentActiveVersionId: current?.id ?? null },
      );
    }
  }

  const summary = diffVersions(current?.roomClasses ?? [], draft.roomClasses);

  try {
    await client.$transaction(async (tx) => {
      if (current) {
        // Archive FIRST: the partial unique index permits only one ACTIVE row,
        // so promoting before archiving would violate it.
        const archived = await tx.branchRoomMappingVersion.updateMany({
          where: { id: current.id, status: 'ACTIVE' },
          data: { status: 'ARCHIVED', archivedAt: new Date() },
        });
        // A concurrent activation already moved it — abort rather than race.
        if (archived.count !== 1) {
          throw ApiError.conflict('Cấu hình vừa được người khác kích hoạt. Vui lòng tải lại và thử lại.');
        }
      }

      const promoted = await tx.branchRoomMappingVersion.updateMany({
        where: { id: draftId, status: 'DRAFT' },
        data: {
          status: 'ACTIVE',
          activatedAt: new Date(),
          activatedByUserId: actorId,
          ...(changeReason ? { changeReason } : {}),
        },
      });
      if (promoted.count !== 1) {
        throw ApiError.conflict('Bản nháp không còn ở trạng thái nháp.');
      }

      await audit(tx, branchId, 'ROOM_MAPPING_ACTIVATED', actorId, 'versionNumber', String(current?.versionNumber ?? 0), String(draft.versionNumber));
    });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      await audit(client, branchId, 'ROOM_MAPPING_ACTIVATION_FAILED', actorId, 'transaction', null, 'rollback');
    }
    throw error;
  }

  return {
    version: serializeVersion(await loadVersionOrThrow(client, branchId, draftId)),
    previousVersionNumber: current?.versionNumber ?? null,
    ...summary,
  };
}

/** Human-readable change summary shown in the activation confirmation. */
function diffVersions(
  before: { stableKey: string; displayName: string; pmsCode: string; active: boolean }[],
  after: { stableKey: string; displayName: string; pmsCode: string; active: boolean }[],
): { added: string[]; changed: string[]; deactivated: string[] } {
  const byKey = new Map(before.map((c) => [c.stableKey, c]));
  const added: string[] = [];
  const changed: string[] = [];
  const deactivated: string[] = [];

  for (const cls of after) {
    const old = byKey.get(cls.stableKey);
    if (!old) {
      if (cls.active) added.push(`${cls.displayName} → ${cls.pmsCode}`);
      continue;
    }
    if (old.active && !cls.active) {
      deactivated.push(old.displayName);
      continue;
    }
    if (old.displayName !== cls.displayName || old.pmsCode !== cls.pmsCode) {
      changed.push(`${old.displayName} (${old.pmsCode}) → ${cls.displayName} (${cls.pmsCode})`);
    }
  }
  for (const old of before) {
    if (old.active && !after.some((c) => c.stableKey === old.stableKey)) deactivated.push(old.displayName);
  }

  return { added, changed, deactivated };
}
