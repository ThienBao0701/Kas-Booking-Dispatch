/**
 * "XÓA TÀI KHOẢN" — PERMANENT deletion of an account, WITHOUT losing history.
 *
 * The account row is removed: it can never sign in again, and its username is
 * free. What it DID stays on file and readable: every operational record
 * (bookings, incidents, assignments, repair attempts and stages, journal entries,
 * audits, shifts, inspections) keeps its own snapshot of the person's name, and
 * its reference to the account is moved to ONE shared placeholder account,
 * "Tài khoản đã xóa" — inactive, unusable, never listed. Nothing is cascaded
 * away and no constraint is altered.
 *
 * Only what belongs to the account alone is deleted with it: its sessions, its
 * notifications, its chat read markers and its branch ticks.
 *
 * REFUSED while the account has live work, so nothing is orphaned mid-flight:
 * an open reception shift, an incident it holds or is repairing, an open
 * housekeeping workday, or an order it is creating right now.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { hashPassword } from './password';
import { randomBytes } from 'node:crypto';

/** The one account every deleted account's history is moved to. */
export const DELETED_ACCOUNT_USERNAME = '__deleted_account__';
export const DELETED_ACCOUNT_NAME = 'Tài khoản đã xóa';

/** Rows that are the account's own, deleted with it rather than re-pointed. */
const PERSONAL_TABLES = new Set(['Session', 'Notification', 'ChatReadState', 'UserBranchAssignment']);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function placeholderId(tx: Prisma.TransactionClient): Promise<number> {
  const existing = await tx.user.findUnique({ where: { username: DELETED_ACCOUNT_USERNAME }, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.user.create({
    data: {
      username: DELETED_ACCOUNT_USERNAME,
      fullName: DELETED_ACCOUNT_NAME,
      // The least-privileged department, inactive, with a password nobody knows.
      role: 'BOOKING_DEPARTMENT',
      active: false,
      mustChangePassword: true,
      passwordHash: await hashPassword(randomBytes(32).toString('base64')),
    },
    select: { id: true },
  });
  return created.id;
}

/** Live work that would be orphaned by the deletion, in words, or null. */
async function liveWork(userId: number): Promise<string | null> {
  const now = getClock().now();
  const [shift, issues, housekeeping, cleaning, claims] = await Promise.all([
    prisma.receptionShiftSession.count({ where: { userId, closedAt: null } }),
    prisma.hotelIssue.count({
      where: {
        voidedAt: null,
        OR: [
          { status: 'IN_PROGRESS', acceptedByUserId: userId },
          { status: 'NEW', assignedTechnicianUserId: userId },
        ],
      },
    }),
    prisma.housekeepingWorkSession.count({ where: { userId, endedAt: null } }),
    // A room being cleaned right now ("đang dọn") — counted with the shift.
    prisma.housekeepingRoomTask.count({ where: { assigneeUserId: userId, state: 'IN_PROGRESS', voidedAt: null } }),
    prisma.booking.count({ where: { claimedByUserId: userId, claimExpiresAt: { gt: now } } }),
  ]);
  if (shift > 0) return 'Tài khoản đang trong ca lễ tân. Hãy kết thúc ca trước khi xóa.';
  if (issues > 0) return `Tài khoản đang được giao hoặc đang sửa ${issues} sự cố. Hãy giao lại cho kỹ thuật viên khác trước khi xóa.`;
  if (housekeeping > 0) return 'Tài khoản đang trong ca buồng phòng. Hãy kết thúc ca trước khi xóa.';
  if (cleaning > 0) return `Tài khoản đang dọn ${cleaning} phòng. Hãy giao lại cho nhân viên khác trước khi xóa.`;
  if (claims > 0) return 'Tài khoản đang nhận một đơn. Hãy đợi đơn được xử lý trước khi xóa.';
  return null;
}

/**
 * Deletes the account. Every foreign key that points at it is found in the
 * database's own catalog (so a table added later is covered without editing
 * this file) and re-pointed to the placeholder, then the row is deleted — one
 * transaction, all or nothing.
 */
export async function deleteAccount(userId: number): Promise<void> {
  const blocked = await liveWork(userId);
  if (blocked) throw ApiError.conflict(blocked);

  await prisma.$transaction(
    async (tx) => {
      const keepId = await placeholderId(tx);
      const refs = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = current_schema()
          AND ccu.table_name = 'User' AND ccu.column_name = 'id'`;
      for (const { table_name: table, column_name: column } of refs) {
        if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) throw new Error(`unexpected identifier ${table}.${column}`);
        if (PERSONAL_TABLES.has(table)) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}" = $1`, userId);
        } else {
          await tx.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2`, keepId, userId);
        }
      }
      await tx.user.delete({ where: { id: userId } });
    },
    { timeout: 60_000 },
  );
}
