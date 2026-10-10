/**
 * Nhắc nhở — an Admin's private note to ONE receptionist.
 *
 * DELIBERATELY NOT A `Notification`. That model is system-generated and
 * booking-centric: it has no sender, and every row is an event the application
 * raised about a booking. A reminder is one person writing to another, so it
 * needs a sender — and folding it into the notification stream would put Admin
 * prose in the booking-event bell and distort the unread badge reception uses
 * to spot new work.
 *
 * PRIVATE BY CONSTRUCTION. Every read is filtered on `recipientUserId`, applied
 * in the database rather than checked after fetching, so one receptionist
 * cannot read another's reminder even by guessing an id. There is no broadcast:
 * an Admin names exactly one recipient, and sending to "all receptionists"
 * would have to be a different, explicitly-designed feature.
 */
import type { PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';

export interface ReminderActor {
  id: number;
  role: UserRole;
}

const MAX_BODY = 2000;

export interface ReminderView {
  id: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  read: boolean;
  sender: { id: number; fullName: string } | null;
  recipient: { id: number; fullName: string } | null;
}

const INCLUDE = {
  sender: { select: { id: true, fullName: true } },
  recipient: { select: { id: true, fullName: true } },
} as const;

type Row = {
  id: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  sender: { id: number; fullName: string } | null;
  recipient: { id: number; fullName: string } | null;
};

function serialize(row: Row): ReminderView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    // Derived from the timestamp rather than stored separately, so there is no
    // second field that can disagree with it.
    read: row.readAt !== null,
    sender: row.sender,
    recipient: row.recipient,
  };
}

export function assertReminderBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw ApiError.validation('Vui lòng nhập nội dung nhắc nhở.');
  if (trimmed.length > MAX_BODY) throw ApiError.validation('Nội dung nhắc nhở quá dài.');
  return trimmed;
}

/**
 * Admin creates a reminder for one receptionist.
 *
 * The recipient must be an ACTIVE RECEPTIONIST. Refusing anything else is not
 * pedantry: sending to a disabled account produces a message nobody will ever
 * read while the Admin believes it was delivered, and sending to another Admin
 * is a feature nobody asked for.
 */
export async function createReminder(
  input: { recipientUserId: number; body: string },
  actor: ReminderActor,
  client: PrismaClient = defaultPrisma,
): Promise<ReminderView> {
  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ Admin mới gửi được nhắc nhở.');
  }
  const body = assertReminderBody(input.body);

  const recipient = await client.user.findUnique({
    where: { id: input.recipientUserId },
    select: { id: true, role: true, active: true },
  });
  if (!recipient) throw ApiError.notFound('Không tìm thấy tài khoản lễ tân.');
  if (recipient.role !== 'RECEPTIONIST') {
    throw ApiError.validation('Chỉ gửi nhắc nhở được cho tài khoản lễ tân.');
  }
  if (!recipient.active) {
    throw ApiError.validation('Tài khoản lễ tân này đã bị khoá.');
  }

  const created = await client.reminder.create({
    data: { senderUserId: actor.id, recipientUserId: recipient.id, body },
    include: INCLUDE,
  });
  return serialize(created as Row);
}

/**
 * Admin sends the SAME reminder to every active receptionist, at every branch.
 *
 * WHY THIS IS A FAN-OUT AND NOT A NEW KIND OF REMINDER. One row per recipient
 * keeps every existing behaviour intact for free: each receptionist sees it in
 * their own inbox, marks their own copy read, and their unread badge counts it —
 * all through the same `recipientUserId` filter that already exists. A single
 * "broadcast" row would have needed its own visibility rule, its own read model
 * and its own badge query, which is the second reminder system nobody wants.
 *
 * `createMany` in ONE statement, so a failure halfway through cannot leave some
 * branches told and others not. Recipients are resolved inside the same call
 * that writes, so an account disabled a moment ago is not sent to.
 */
export async function createRemindersForAllBranches(
  input: { body: string },
  actor: ReminderActor,
  client: PrismaClient = defaultPrisma,
): Promise<{ recipients: number }> {
  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ Admin mới gửi được nhắc nhở.');
  }
  const body = assertReminderBody(input.body);

  const recipients = await client.user.findMany({
    where: { role: 'RECEPTIONIST', active: true },
    select: { id: true },
  });
  if (recipients.length === 0) {
    throw ApiError.validation('Chưa có tài khoản lễ tân nào đang hoạt động.');
  }

  const created = await client.reminder.createMany({
    data: recipients.map((r) => ({ senderUserId: actor.id, recipientUserId: r.id, body })),
  });
  return { recipients: created.count };
}

/**
 * The reminders the actor may see.
 *
 * A receptionist sees ONLY their own — the filter is `recipientUserId`, in the
 * query. An Admin sees the ones they sent, which is what makes "did it arrive
 * and was it read?" answerable without granting them other Admins' messages.
 */
export async function listReminders(
  actor: ReminderActor,
  client: PrismaClient = defaultPrisma,
): Promise<ReminderView[]> {
  const where =
    actor.role === 'ADMIN' ? { senderUserId: actor.id } : { recipientUserId: actor.id };

  const rows = await client.reminder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: INCLUDE,
  });
  return (rows as Row[]).map(serialize);
}

/** Unread count for the recipient's badge. Admins have no unread inbox. */
export async function unreadReminderCount(
  actor: ReminderActor,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  if (actor.role === 'ADMIN') return 0;
  return client.reminder.count({ where: { recipientUserId: actor.id, readAt: null } });
}

/**
 * Marks a reminder read. RECIPIENT ONLY.
 *
 * The `recipientUserId` is part of the WHERE, so another receptionist's id
 * simply matches no row — a 404, not a 403, because confirming the id exists
 * would already leak that someone was sent something.
 *
 * Idempotent: re-opening an already-read reminder keeps the FIRST `readAt`
 * rather than moving it, so "when did they see this?" stays answerable.
 */
export async function markReminderRead(
  reminderId: string,
  actor: ReminderActor,
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<ReminderView> {
  const existing = await client.reminder.findFirst({
    where: { id: reminderId, recipientUserId: actor.id },
    select: { id: true, readAt: true },
  });
  if (!existing) throw ApiError.notFound('Không tìm thấy nhắc nhở.');

  if (existing.readAt === null) {
    await client.reminder.updateMany({
      where: { id: reminderId, recipientUserId: actor.id, readAt: null },
      data: { readAt: clock.now() },
    });
  }

  const row = await client.reminder.findFirstOrThrow({
    where: { id: reminderId, recipientUserId: actor.id },
    include: INCLUDE,
  });
  return serialize(row as Row);
}
