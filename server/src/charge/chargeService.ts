/**
 * The Chứng từ domain service.
 *
 * Everything the module does to the database goes through here, for one reason
 * above all: this is the only place a card number is encrypted or decrypted, so
 * there is exactly one code path to audit rather than several to keep in step.
 *
 * THE SERIALISED SHAPE NEVER CARRIES A CARD NUMBER. `serializeChargeDocument`
 * returns `cardLast4` and nothing else, so no list, detail, report or export
 * response can leak a PAN even if a future caller forgets to think about it.
 * The full number leaves this module through `revealCardNumber` alone, which
 * writes an audit row every time.
 *
 * There is no CVV anywhere in this file, this module, or the schema behind it.
 */
import type { ChargeAttachmentCategory, ChargeStatus, PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import {
  decryptCardNumber,
  encryptCardNumber,
  isPlausibleCardNumber,
  maskedCardNumber,
  normalizeCardNumber,
} from './cardCrypto';

/** Who is acting. Mirrors the shape the rest of the app already passes around. */
export interface ChargeActor {
  id: number;
  role: UserRole;
}

/** The two roles that may touch this module at all. */
export const CHARGE_ROLES: readonly UserRole[] = ['ADMIN', 'BOOKING_DEPARTMENT'];

export function assertChargeAccess(actor: ChargeActor): void {
  if (!CHARGE_ROLES.includes(actor.role)) {
    throw ApiError.forbidden('Bạn không có quyền truy cập Chứng từ.');
  }
}

/**
 * Only an Admin may CHANGE the charge reason.
 *
 * Bộ phận đặt phòng keeps full read access and keeps every other edit it
 * already had — this narrows one field, not the role. The reason is what the
 * monthly report is read against and what an operator justifies a charge with,
 * so it is the Admin's word.
 *
 * ENFORCED HERE, IN THE DOMAIN, not in the router and not by hiding a textarea:
 * the UI hint is a courtesy, this is the control. It is deliberately called
 * only when the trimmed reason actually DIFFERS from the stored one — a PUT
 * that echoes the existing reason back while changing the status is not an
 * edit of the reason, and failing it would break status transitions that Bộ
 * phận đặt phòng is entitled to make.
 */
export function assertReasonEditable(actor: ChargeActor): void {
  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ Admin mới được sửa lý do charge.');
  }
}

const DOCUMENT_INCLUDE = {
  branch: { select: { id: true, code: true, branchNumber: true, hotelName: true, address: true } },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
  attachments: {
    orderBy: { uploadedAt: 'asc' },
    include: { uploadedBy: { select: { id: true, fullName: true } } },
  },
} as const;

type DocumentWithRelations = Awaited<
  ReturnType<PrismaClient['chargeDocument']['findFirstOrThrow']>
> & {
  branch: { id: number; code: string; branchNumber: number; hotelName: string; address: string };
  createdBy: { id: number; fullName: string } | null;
  updatedBy: { id: number; fullName: string } | null;
  attachments: {
    id: string;
    category: ChargeAttachmentCategory;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
    uploadedAt: Date;
    uploadedBy: { id: number; fullName: string } | null;
  }[];
};

/**
 * The wire shape.
 *
 * `cardLast4` and `cardMasked` only — deliberately no field that could ever
 * hold a full number, so the type system itself prevents one being added to a
 * list response by accident.
 */
export function serializeChargeDocument(doc: DocumentWithRelations) {
  return {
    id: doc.id,
    branch: doc.branch,
    bookingId: doc.bookingId,
    guestName: doc.guestName,
    bookingCode: doc.bookingCode,
    amount: doc.amount,
    cardLast4: doc.cardLast4,
    cardMasked: maskedCardNumber(doc.cardLast4),
    cardExpiry: doc.cardExpiry,
    checkIn: doc.checkIn.toISOString().slice(0, 10),
    checkOut: doc.checkOut.toISOString().slice(0, 10),
    reason: doc.reason,
    status: doc.status,
    chargedAt: doc.chargedAt ? doc.chargedAt.toISOString() : null,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    attachments: doc.attachments.map((a) => ({
      id: a.id,
      category: a.category,
      originalFileName: a.originalFileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      uploadedAt: a.uploadedAt.toISOString(),
      uploadedBy: a.uploadedBy,
    })),
  };
}

export type ChargeDocumentView = ReturnType<typeof serializeChargeDocument>;

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/**
 * Writes one audit row.
 *
 * Callers pass only values that are safe to keep forever. A card change is
 * recorded as its masked form; the number itself never reaches this function,
 * which is why the parameters are plain strings rather than the document.
 */
async function audit(
  client: PrismaClient,
  chargeDocumentId: string,
  action: 'CREATED' | 'UPDATED' | 'STATUS_CHANGED' | 'ATTACHMENT_ADDED' | 'ATTACHMENT_REMOVED' | 'CARD_REVEALED',
  actor: ChargeActor,
  detail: { field?: string; oldValue?: string | null; newValue?: string | null } = {},
): Promise<void> {
  await client.chargeDocumentAudit.create({
    data: {
      chargeDocumentId,
      action,
      field: detail.field ?? null,
      oldValue: detail.oldValue ?? null,
      newValue: detail.newValue ?? null,
      actorUserId: actor.id,
      actorRole: actor.role,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Create / update                                                     */
/* ------------------------------------------------------------------ */

export interface ChargeDocumentInput {
  branchId: number;
  guestName: string;
  bookingCode: string;
  amount: number;
  cardNumber: string;
  cardExpiry: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  status?: ChargeStatus;
}

/** ISO "YYYY-MM-DD" → the UTC midnight the rest of the system stores. */
function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw ApiError.validation('Vui lòng nhập lý do charge.');
  }
  return trimmed;
}

function assertCardNumber(raw: string): string {
  const digits = normalizeCardNumber(raw);
  if (!isPlausibleCardNumber(digits)) {
    // Says the number looks wrong without echoing any part of it back.
    throw ApiError.validation('Số thẻ không hợp lệ.');
  }
  return digits;
}

async function assertBranchExists(client: PrismaClient, branchId: number): Promise<void> {
  const branch = await client.branch.findFirst({ where: { id: branchId, active: true } });
  if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ.');
}

export async function createChargeDocument(
  input: ChargeDocumentInput,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ChargeDocumentView> {
  assertChargeAccess(actor);
  await assertBranchExists(client, input.branchId);

  const reason = assertReason(input.reason);
  const digits = assertCardNumber(input.cardNumber);
  const { cipher, last4, keyVersion } = encryptCardNumber(digits);

  const status = input.status ?? 'CHUA_XU_LY';

  const created = await client.chargeDocument.create({
    data: {
      branchId: input.branchId,
      guestName: input.guestName.trim(),
      bookingCode: input.bookingCode.trim(),
      amount: input.amount,
      cardNumberCipher: cipher,
      cardLast4: last4,
      cardExpiry: input.cardExpiry.trim(),
      cardKeyVersion: keyVersion,
      checkIn: toUtcDate(input.checkIn),
      checkOut: toUtcDate(input.checkOut),
      reason,
      status,
      // Only a document created already-charged carries a charge time.
      chargedAt: status === 'DA_BI_CHARGE' ? now : null,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
    },
    include: DOCUMENT_INCLUDE,
  });

  await audit(client, created.id, 'CREATED', actor, {
    newValue: `${created.guestName} · ${created.bookingCode}`,
  });

  return serializeChargeDocument(created as DocumentWithRelations);
}

export type ChargeDocumentPatch = Partial<Omit<ChargeDocumentInput, 'cardNumber'>> & {
  cardNumber?: string;
};

export async function updateChargeDocument(
  id: string,
  patch: ChargeDocumentPatch,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ChargeDocumentView> {
  assertChargeAccess(actor);

  const existing = await client.chargeDocument.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('Không tìm thấy chứng từ.');

  const data: Record<string, unknown> = { updatedByUserId: actor.id };
  const changes: { field: string; oldValue: string; newValue: string }[] = [];

  if (patch.branchId !== undefined && patch.branchId !== existing.branchId) {
    await assertBranchExists(client, patch.branchId);
    data.branchId = patch.branchId;
    changes.push({ field: 'branchId', oldValue: String(existing.branchId), newValue: String(patch.branchId) });
  }
  if (patch.guestName !== undefined && patch.guestName.trim() !== existing.guestName) {
    data.guestName = patch.guestName.trim();
    changes.push({ field: 'guestName', oldValue: existing.guestName, newValue: patch.guestName.trim() });
  }
  if (patch.bookingCode !== undefined && patch.bookingCode.trim() !== existing.bookingCode) {
    data.bookingCode = patch.bookingCode.trim();
    changes.push({ field: 'bookingCode', oldValue: existing.bookingCode, newValue: patch.bookingCode.trim() });
  }
  if (patch.amount !== undefined && patch.amount !== existing.amount) {
    data.amount = patch.amount;
    changes.push({ field: 'amount', oldValue: String(existing.amount), newValue: String(patch.amount) });
  }
  if (patch.reason !== undefined) {
    const reason = assertReason(patch.reason);
    if (reason !== existing.reason) {
      assertReasonEditable(actor);
      data.reason = reason;
      changes.push({ field: 'reason', oldValue: existing.reason, newValue: reason });
    }
  }
  if (patch.cardExpiry !== undefined && patch.cardExpiry.trim() !== existing.cardExpiry) {
    data.cardExpiry = patch.cardExpiry.trim();
    changes.push({ field: 'cardExpiry', oldValue: existing.cardExpiry, newValue: patch.cardExpiry.trim() });
  }
  if (patch.checkIn !== undefined) data.checkIn = toUtcDate(patch.checkIn);
  if (patch.checkOut !== undefined) data.checkOut = toUtcDate(patch.checkOut);

  if (patch.cardNumber !== undefined && patch.cardNumber.trim().length > 0) {
    const digits = assertCardNumber(patch.cardNumber);
    const { cipher, last4, keyVersion } = encryptCardNumber(digits);
    data.cardNumberCipher = cipher;
    data.cardLast4 = last4;
    data.cardKeyVersion = keyVersion;
    if (last4 !== existing.cardLast4) {
      // MASKED ON BOTH SIDES. An audit row never carries a card number.
      changes.push({
        field: 'cardNumber',
        oldValue: maskedCardNumber(existing.cardLast4),
        newValue: maskedCardNumber(last4),
      });
    }
  }

  // Status is handled last so chargedAt follows the final decision.
  let statusChange: { from: ChargeStatus; to: ChargeStatus } | null = null;
  if (patch.status !== undefined && patch.status !== existing.status) {
    statusChange = { from: existing.status, to: patch.status };
    data.status = patch.status;
    // chargedAt is set when a charge SUCCEEDS and cleared when it stops being
    // a success — the monthly report reads this field and nothing else, so a
    // stale timestamp on a failed document would silently inflate a month.
    data.chargedAt = patch.status === 'DA_BI_CHARGE' ? (existing.chargedAt ?? now) : null;
  }

  const updated = await client.chargeDocument.update({
    where: { id },
    data,
    include: DOCUMENT_INCLUDE,
  });

  for (const change of changes) {
    await audit(client, id, 'UPDATED', actor, change);
  }
  if (statusChange) {
    await audit(client, id, 'STATUS_CHANGED', actor, {
      field: 'status',
      oldValue: statusChange.from,
      newValue: statusChange.to,
    });
  }

  return serializeChargeDocument(updated as DocumentWithRelations);
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export interface ChargeListFilters {
  branchId?: number;
  status?: ChargeStatus;
  chargedFrom?: string;
  chargedTo?: string;
  checkInFrom?: string;
  checkInTo?: string;
  guestName?: string;
  bookingCode?: string;
}

/**
 * Builds the Prisma filter. Every filter is applied HERE, in the database —
 * the browser never receives rows it is going to discard.
 */
function whereFrom(filters: ChargeListFilters) {
  const where: Record<string, unknown> = {};
  if (filters.branchId !== undefined) where.branchId = filters.branchId;
  if (filters.status !== undefined) where.status = filters.status;

  if (filters.chargedFrom || filters.chargedTo) {
    const range: Record<string, Date> = {};
    if (filters.chargedFrom) range.gte = toUtcDate(filters.chargedFrom);
    // Inclusive end: everything before the following midnight.
    if (filters.chargedTo) range.lt = new Date(toUtcDate(filters.chargedTo).getTime() + 86_400_000);
    where.chargedAt = range;
  }
  if (filters.checkInFrom || filters.checkInTo) {
    const range: Record<string, Date> = {};
    if (filters.checkInFrom) range.gte = toUtcDate(filters.checkInFrom);
    if (filters.checkInTo) range.lt = new Date(toUtcDate(filters.checkInTo).getTime() + 86_400_000);
    where.checkIn = range;
  }
  if (filters.guestName) where.guestName = { contains: filters.guestName, mode: 'insensitive' };
  if (filters.bookingCode) where.bookingCode = { contains: filters.bookingCode, mode: 'insensitive' };
  return where;
}

export async function listChargeDocuments(
  filters: ChargeListFilters,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChargeDocumentView[]> {
  assertChargeAccess(actor);
  const rows = await client.chargeDocument.findMany({
    where: whereFrom(filters),
    include: DOCUMENT_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return rows.map((r) => serializeChargeDocument(r as DocumentWithRelations));
}

export async function getChargeDocument(
  id: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChargeDocumentView> {
  assertChargeAccess(actor);
  const row = await client.chargeDocument.findUnique({ where: { id }, include: DOCUMENT_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy chứng từ.');
  return serializeChargeDocument(row as DocumentWithRelations);
}

export async function listChargeAudit(
  id: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
) {
  assertChargeAccess(actor);
  const events = await client.chargeDocumentAudit.findMany({
    where: { chargeDocumentId: id },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { id: true, fullName: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    action: e.action,
    field: e.field,
    oldValue: e.oldValue,
    newValue: e.newValue,
    actor: e.actor,
    actorRole: e.actorRole,
    createdAt: e.createdAt.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* The reveal                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns the full card number, and records that it was shown.
 *
 * The audit row names the actor and the moment — never the number. That is the
 * whole point: someone reviewing the trail later must be able to see who looked
 * at a card without the trail itself becoming a place cards are stored.
 */
export async function revealCardNumber(
  id: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
): Promise<{ cardNumber: string }> {
  assertChargeAccess(actor);
  const row = await client.chargeDocument.findUnique({
    where: { id },
    select: { id: true, cardNumberCipher: true, cardLast4: true },
  });
  if (!row) throw ApiError.notFound('Không tìm thấy chứng từ.');

  const cardNumber = decryptCardNumber(row.cardNumberCipher);
  await audit(client, id, 'CARD_REVEALED', actor, {
    field: 'cardNumber',
    // The MASKED form, so the trail says which card without storing it.
    newValue: maskedCardNumber(row.cardLast4),
  });
  return { cardNumber };
}

/* ------------------------------------------------------------------ */
/* Monthly report — ONE query, used by both the UI and the export      */
/* ------------------------------------------------------------------ */

export interface MonthlyChargeReport {
  month: string;
  from: string;
  to: string;
  totals: {
    documentCount: number;
    chargedCount: number;
    chargedAmount: number;
    failedCount: number;
    failedAmount: number;
    pendingCount: number;
    pendingAmount: number;
  };
  rows: ChargeDocumentView[];
}

/** "2026-08" → the UTC half-open range [from, to). */
function monthRange(month: string): { from: Date; to: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw ApiError.validation('Tháng không hợp lệ (định dạng YYYY-MM).');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw ApiError.validation('Tháng không hợp lệ.');
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)),
    to: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

/**
 * The month's charge report.
 *
 * THE SINGLE SOURCE OF TRUTH. The JSON endpoint and the XLSX export both call
 * this and neither recomputes anything, so the spreadsheet and the screen
 * cannot disagree about a total.
 *
 * MEMBERSHIP IS BY `chargedAt`, never by createdAt, checkIn or checkOut — the
 * question being answered is "who did we charge this month", and a document
 * raised in July for a charge that succeeded in August belongs to August.
 *
 * Documents that were never charged have no `chargedAt` at all, so they cannot
 * fall in any month by that rule. They are still counted, by their CREATION
 * month, so the operator can see what is outstanding — but their amounts are
 * reported in separate fields and are never added to `chargedAmount`.
 */
export async function monthlyChargeReport(
  month: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
): Promise<MonthlyChargeReport> {
  assertChargeAccess(actor);
  const { from, to } = monthRange(month);

  // Charged documents: selected by when the charge actually happened.
  const charged = await client.chargeDocument.findMany({
    where: { status: 'DA_BI_CHARGE', chargedAt: { gte: from, lt: to } },
    include: DOCUMENT_INCLUDE,
    orderBy: { chargedAt: 'asc' },
  });

  // Everything else has no charge time, so it is grouped by when it was raised.
  const others = await client.chargeDocument.findMany({
    where: {
      status: { in: ['CHARGE_THAT_BAI', 'CHUA_XU_LY'] },
      createdAt: { gte: from, lt: to },
    },
    include: DOCUMENT_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });

  const failed = others.filter((d) => d.status === 'CHARGE_THAT_BAI');
  const pending = others.filter((d) => d.status === 'CHUA_XU_LY');
  const sum = (rows: { amount: number }[]) => rows.reduce((acc, r) => acc + r.amount, 0);

  return {
    month,
    from: from.toISOString().slice(0, 10),
    to: new Date(to.getTime() - 86_400_000).toISOString().slice(0, 10),
    totals: {
      documentCount: charged.length + others.length,
      chargedCount: charged.length,
      // The primary KPI. ONLY successful charges reach this number.
      chargedAmount: sum(charged),
      failedCount: failed.length,
      failedAmount: sum(failed),
      pendingCount: pending.length,
      pendingAmount: sum(pending),
    },
    rows: charged.map((r) => serializeChargeDocument(r as DocumentWithRelations)),
  };
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export async function addAttachment(
  chargeDocumentId: string,
  file: {
    category: ChargeAttachmentCategory;
    storedFileName: string;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
  },
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
) {
  assertChargeAccess(actor);
  const created = await client.chargeDocumentAttachment.create({
    data: { chargeDocumentId, ...file, uploadedByUserId: actor.id },
  });
  await audit(client, chargeDocumentId, 'ATTACHMENT_ADDED', actor, {
    field: file.category,
    newValue: file.originalFileName,
  });
  return created;
}

/** Resolves an attachment and re-checks the caller may have it. */
export async function authorizeAttachment(
  attachmentId: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
) {
  assertChargeAccess(actor);
  const found = await client.chargeDocumentAttachment.findUnique({ where: { id: attachmentId } });
  if (!found) throw ApiError.notFound('Không tìm thấy tệp.');
  return found;
}

export async function removeAttachment(
  attachmentId: string,
  actor: ChargeActor,
  client: PrismaClient = defaultPrisma,
) {
  assertChargeAccess(actor);
  const found = await authorizeAttachment(attachmentId, actor, client);
  await client.chargeDocumentAttachment.delete({ where: { id: attachmentId } });
  await audit(client, found.chargeDocumentId, 'ATTACHMENT_REMOVED', actor, {
    field: found.category,
    oldValue: found.originalFileName,
  });
  return found;
}
