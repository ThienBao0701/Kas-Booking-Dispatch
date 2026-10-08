/**
 * "MẬT KHẨU GHI ĐÈ ADMIN" — ONE password, set by an Admin, that signs in as any
 * NON-Admin account without knowing that account's own password.
 *
 *   letan / 123456aa   its own password  → an ordinary sign-in
 *   letan / 123456bb   the override      → signed in AS letan, audited
 *
 * It is never the account's password and never changes it: the account's own
 * password keeps working, and the override cannot be used to change it (that
 * needs the current password). The session is the target account's, with its
 * role and branch, so every authorization rule applies exactly as for that
 * account — nothing is bypassed after sign-in. The session is marked
 * `adminOverride` and every such sign-in is written to AccountAudit.
 *
 * Only the bcrypt hash is stored, in a single row (id 1); no endpoint returns it.
 * An Admin account can never be entered with it: the override grants what a
 * reception, housekeeping or technical account can do, never the Admin's power.
 */
import type { AdminOverrideCredential, User } from '@prisma/client';
import { prisma } from '../db/prisma';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';
import { sessionStore } from './session';

const ROW_ID = 1;

export interface OverrideActor {
  id: number;
  fullName: string;
}

/** Whether one is set, and by whom — never the password or its hash. */
export async function adminOverrideStatus() {
  const row = await prisma.adminOverrideCredential.findUnique({ where: { id: ROW_ID } });
  return row
    ? { configured: true, updatedAt: row.updatedAt.toISOString(), setByName: row.setByNameSnapshot }
    : { configured: false, updatedAt: null, setByName: null };
}

/**
 * Sets or replaces it. Every session opened with the previous one ends, so a
 * replaced password stops working everywhere at once.
 */
export async function setAdminOverridePassword(admin: OverrideActor, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const data = { passwordHash, setByUserId: admin.id, setByNameSnapshot: admin.fullName };
  await prisma.$transaction([
    prisma.adminOverrideCredential.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data }, update: data }),
    prisma.accountAudit.create({
      data: { userId: admin.id, action: 'ADMIN_OVERRIDE_SET', actorUserId: admin.id, actorNameSnapshot: admin.fullName },
    }),
  ]);
  await sessionStore.destroyAdminOverrideSessions();
}

/** Turns it off, and ends every session opened with it. */
export async function clearAdminOverridePassword(admin: OverrideActor): Promise<void> {
  await prisma.$transaction([
    prisma.adminOverrideCredential.deleteMany({ where: { id: ROW_ID } }),
    prisma.accountAudit.create({
      data: { userId: admin.id, action: 'ADMIN_OVERRIDE_CLEARED', actorUserId: admin.id, actorNameSnapshot: admin.fullName },
    }),
  ]);
  await sessionStore.destroyAdminOverrideSessions();
}

/**
 * Called by the login ONLY after the account's own password has failed. The
 * credential when `password` is the override and `target` may be entered with
 * it; null otherwise.
 *
 * Always spends one bcrypt comparison — against the dummy hash when none is set
 * — so the response time does not reveal whether an override is configured.
 */
export async function matchAdminOverride(
  password: string,
  target: Pick<User, 'role'>,
): Promise<AdminOverrideCredential | null> {
  const row = await prisma.adminOverrideCredential.findUnique({ where: { id: ROW_ID } });
  if (!row) {
    await verifyAgainstDummy(password);
    return null;
  }
  const ok = await verifyPassword(password, row.passwordHash);
  return ok && target.role !== 'ADMIN' ? row : null;
}

/**
 * "Signed in as X with the override" — written BEFORE the session is opened, so
 * an override sign-in that cannot be recorded does not happen.
 */
export async function auditAdminOverrideLogin(targetUserId: number, row: AdminOverrideCredential): Promise<void> {
  await prisma.accountAudit.create({
    data: {
      userId: targetUserId,
      action: 'ADMIN_OVERRIDE_LOGIN',
      actorUserId: row.setByUserId,
      actorNameSnapshot: row.setByNameSnapshot,
    },
  });
}
