/**
 * "VII. BÁO CÁO CÁC VẤN ĐỀ VÀ TÌNH HÌNH QUAN TRỌNG" — a PRIVATE UPWARD REPORT.
 *
 *   Lễ tân  ──▶  Quản lý lễ tân (its own branch)  ──▶  Tổng quản lý  ──▶  Admin
 *
 * WHO MAY READ ONE: the superiors the sender chose, and every Admin — always.
 * The Admin is SHOWN to the sender as an ordinary choice, and the server adds
 * every active Admin whether it is chosen or not. Nobody
 * else: not the sender's peers, not the sender (it is not in their inbox), not
 * another branch, not Buồng phòng or Kỹ thuật. A report outside the reader's
 * reach answers 404 — its existence is not confirmed either.
 *
 * WHO MAY BE CHOSEN is decided HERE from the sender's own role and branch, and
 * every id the request names is checked against that list. A receptionist of
 * branch 1 can never address the Quản lý lễ tân of branch 2, however the request
 * is written.
 *
 * NOT ANONYMOUS. The authenticated sender is stored (name and role as they were)
 * for accountability, and shown to the readers. One report, one row: the readers
 * are rows of `ConfidentialReportRecipient`, each with its own read state.
 */
import type { ConfidentialReportCategory, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';

export const CONFIDENTIAL_TITLE = 'Báo cáo các vấn đề và tình hình quan trọng';

/** Exactly four kinds, in the order of the form. */
export const CONFIDENTIAL_CATEGORIES: readonly ConfidentialReportCategory[] = [
  'WORK_ENVIRONMENT',
  'PROCESS_RULES',
  'COLLEAGUES',
  'OTHER_IMPORTANT',
];

export const CONFIDENTIAL_CATEGORY_LABELS: Record<ConfidentialReportCategory, string> = {
  WORK_ENVIRONMENT: 'Môi trường làm việc',
  PROCESS_RULES: 'Quy trình, quy định',
  COLLEAGUES: 'Đồng nghiệp, nhân viên',
  OTHER_IMPORTANT: 'Các vấn đề tình hình quan trọng khác',
};

const ROLE_LABELS: Partial<Record<UserRole, string>> = {
  ADMIN: 'Admin',
  RECEPTIONIST: 'Lễ tân',
  RECEPTION_MANAGER: 'Quản lý lễ tân',
  RECEPTION_GENERAL_MANAGER: 'Tổng quản lý',
};

/** The longest report one submission may carry. */
export const MAX_CONFIDENTIAL_LENGTH = 5000;

export interface ConfidentialActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
}

/** The roles that report upward. The Admin has nobody above it. */
const SENDER_ROLES: readonly UserRole[] = ['RECEPTIONIST', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'];
/** The roles with an inbox. */
const READER_ROLES: readonly UserRole[] = ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'ADMIN'];

export function canSend(role: UserRole): boolean {
  return SENDER_ROLES.includes(role);
}

export function canRead(role: UserRole): boolean {
  return READER_ROLES.includes(role);
}

/** The order the sender reads them in: the nearest superior first. */
const UPWARD_ORDER: readonly UserRole[] = ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'ADMIN'];

/**
 * THE ROLES A SENDER MAY ADDRESS, nearest first — whether or not an account of
 * that role exists right now. The sender's form shows exactly these, so a
 * receptionist always sees "Quản lí lễ tân" even when its branch has none yet.
 */
export function allowedRecipientRoles(role: UserRole): UserRole[] {
  if (role === 'RECEPTIONIST') return [...UPWARD_ORDER];
  if (role === 'RECEPTION_MANAGER') return ['RECEPTION_GENERAL_MANAGER', 'ADMIN'];
  if (role === 'RECEPTION_GENERAL_MANAGER') return ['ADMIN'];
  return [];
}

/**
 * THE SUPERIORS THIS SENDER MAY ADDRESS, nearest first:
 *
 *   Lễ tân           its OWN branch's Quản lý lễ tân, the Tổng quản lý lễ tân, Admin
 *   Quản lý lễ tân   the Tổng quản lý lễ tân, Admin
 *   Tổng quản lý     Admin
 *   Admin            nobody — it cannot send
 *
 * Every Admin is listed with `always: true`: the sender may tick it or not —
 * the server adds every active Admin to every report anyway, once.
 * Never a peer, a lower role or another branch's manager. A receptionist with no
 * branch matches no manager (fail closed); its report still reaches the Admin.
 */
export async function allowedRecipients(actor: ConfidentialActor) {
  if (!canSend(actor.role)) throw ApiError.forbidden('Bạn không gửi được báo cáo này.');
  const superiors: Prisma.UserWhereInput[] = [{ role: 'ADMIN' }];
  if (actor.role === 'RECEPTIONIST') {
    superiors.push(
      { role: 'RECEPTION_MANAGER', branchAssignments: { some: { branchId: actor.branchId ?? -1 } } },
      { role: 'RECEPTION_GENERAL_MANAGER' },
    );
  } else if (actor.role === 'RECEPTION_MANAGER') {
    superiors.push({ role: 'RECEPTION_GENERAL_MANAGER' });
  }
  const users = await prisma.user.findMany({
    where: { AND: [{ OR: superiors }, { active: true, id: { not: actor.id } }] },
    select: { id: true, fullName: true, role: true },
    orderBy: { fullName: 'asc' },
  });
  return users
    .sort((a, b) => UPWARD_ORDER.indexOf(a.role) - UPWARD_ORDER.indexOf(b.role))
    .map((u) => ({
      id: u.id,
      fullName: u.fullName,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role] ?? u.role,
      /** The Admin: always a recipient, whatever the sender ticks. */
      always: u.role === 'ADMIN',
    }));
}

export interface CreateConfidentialInput {
  category: ConfidentialReportCategory;
  content: string;
  /** The chosen superiors. The Admin may be named or not: it always receives it. */
  recipientIds?: number[];
}

export async function createConfidentialReport(actor: ConfidentialActor, input: CreateConfidentialInput) {
  if (!canSend(actor.role)) throw ApiError.forbidden('Bạn không gửi được báo cáo này.');
  if (!CONFIDENTIAL_CATEGORIES.includes(input.category)) throw ApiError.validation('Vui lòng chọn loại vấn đề.');
  const content = input.content.trim();
  if (!content) throw ApiError.validation('Vui lòng nhập nội dung.');
  if (content.length > MAX_CONFIDENTIAL_LENGTH) {
    throw ApiError.validation(`Nội dung không được vượt quá ${MAX_CONFIDENTIAL_LENGTH} ký tự.`);
  }

  const allowed = await allowedRecipients(actor);
  const allowedIds = new Set(allowed.map((u) => u.id));
  const requested = [...new Set(input.recipientIds ?? [])];
  for (const id of requested) {
    if (!allowedIds.has(id)) throw ApiError.forbidden('Người nhận không thuộc cấp quản lý của bạn.');
  }
  // ONE report, one row per reader: the chosen managers, then every Admin.
  const admins = allowed.filter((u) => u.always);
  const chosen = requested.filter((id) => !admins.some((a) => a.id === id));

  const report = await prisma.confidentialReport.create({
    data: {
      senderUserId: actor.id,
      senderNameSnapshot: actor.fullName,
      senderRole: actor.role,
      senderBranchId: actor.role === 'RECEPTIONIST' ? actor.branchId : null,
      category: input.category,
      content,
      createdAt: getClock().now(),
      recipients: {
        create: [
          ...chosen.map((userId) => ({ userId })),
          ...admins.map((a) => ({ userId: a.id, automatic: true })),
        ],
      },
    },
    select: { id: true, createdAt: true },
  });
  return { id: report.id, createdAt: report.createdAt.toISOString() };
}

const INCLUDE = {
  senderBranch: { select: { id: true, branchNumber: true, address: true } },
  recipients: { include: { user: { select: { id: true, fullName: true, role: true } } } },
} satisfies Prisma.ConfidentialReportInclude;

type ReportRow = Prisma.ConfidentialReportGetPayload<{ include: typeof INCLUDE }>;

/** Everything an Admin reads; only what is addressed to them for anyone else. */
function inboxWhere(actor: ConfidentialActor): Prisma.ConfidentialReportWhereInput {
  if (actor.role === 'ADMIN') return {};
  if (!canRead(actor.role)) return { id: { in: [] } };
  return { recipients: { some: { userId: actor.id } } };
}

function serialize(row: ReportRow, actor: ConfidentialActor, full: boolean) {
  const mine = row.recipients.find((r) => r.userId === actor.id);
  return {
    id: row.id,
    category: row.category,
    categoryLabel: CONFIDENTIAL_CATEGORY_LABELS[row.category],
    sender: {
      id: row.senderUserId,
      name: row.senderNameSnapshot,
      role: row.senderRole,
      roleLabel: ROLE_LABELS[row.senderRole] ?? row.senderRole,
    },
    branch: row.senderBranch
      ? { id: row.senderBranch.id, branchNumber: row.senderBranch.branchNumber, address: row.senderBranch.address }
      : null,
    createdAt: row.createdAt.toISOString(),
    preview: row.content.length > 140 ? `${row.content.slice(0, 140)}…` : row.content,
    content: full ? row.content : undefined,
    /** Who it was sent to — the chosen superiors, then the Admin (always). */
    recipients: [...row.recipients]
      .sort((a, b) => UPWARD_ORDER.indexOf(a.user.role) - UPWARD_ORDER.indexOf(b.user.role))
      .map((r) => ({
        id: r.user.id,
        name: r.user.fullName,
        roleLabel: ROLE_LABELS[r.user.role] ?? r.user.role,
        always: r.automatic,
      })),
    /** THIS reader's state; another reader opening it changes nothing here. */
    read: Boolean(mine?.readAt),
    readAt: mine?.readAt ? mine.readAt.toISOString() : null,
  };
}

/** The reader's inbox, newest first, with its unread / read counts. */
export async function listInbox(actor: ConfidentialActor, state?: 'UNREAD' | 'READ') {
  if (!canRead(actor.role)) throw ApiError.forbidden('Bạn không có hộp thư báo cáo quan trọng.');
  const rows = await prisma.confidentialReport.findMany({
    where: inboxWhere(actor),
    include: INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const all = rows.map((r) => serialize(r, actor, false));
  const unread = all.filter((r) => !r.read).length;
  const shown = state === 'UNREAD' ? all.filter((r) => !r.read) : state === 'READ' ? all.filter((r) => r.read) : all;
  return { reports: shown, counts: { unread, read: all.length - unread } };
}

async function loadVisible(actor: ConfidentialActor, id: string): Promise<ReportRow> {
  if (!canRead(actor.role)) throw ApiError.notFound('Không tìm thấy báo cáo.');
  const row = await prisma.confidentialReport.findFirst({ where: { AND: [{ id }, inboxWhere(actor)] }, include: INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy báo cáo.');
  return row;
}

export async function getConfidentialReport(actor: ConfidentialActor, id: string) {
  return serialize(await loadVisible(actor, id), actor, true);
}

/**
 * "Đã đọc" — for THIS reader only. An Admin who was not on the list when the
 * report was sent (an account created later) gets its own row the first time.
 */
export async function markConfidentialRead(actor: ConfidentialActor, id: string) {
  await loadVisible(actor, id);
  const now = getClock().now();
  if (actor.role === 'ADMIN') {
    await prisma.confidentialReportRecipient.upsert({
      where: { reportId_userId: { reportId: id, userId: actor.id } },
      create: { reportId: id, userId: actor.id, automatic: true, readAt: now },
      update: {},
    });
  }
  await prisma.confidentialReportRecipient.updateMany({
    where: { reportId: id, userId: actor.id, readAt: null },
    data: { readAt: now },
  });
  return getConfidentialReport(actor, id);
}
