/**
 * One-time creation of the first production administrator.
 *
 * Nothing here is hardcoded and nothing is committed: the operator supplies the
 * username and password at execution time, the password is read without echo,
 * and it is never printed, logged or written to an audit row — only the fact
 * that an account was created is recorded.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { hashPassword } from '../auth/password';
import { normalizeUsername } from '../auth/username';

/** Minimum length for a first production Admin password. */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export interface PasswordStrength {
  ok: boolean;
  problems: string[];
}

/**
 * Password policy for the initial Admin — deliberately stricter than the normal
 * account policy, because this one account can reach every branch's data.
 * The password itself is never included in a message.
 */
export function checkAdminPasswordStrength(password: string): PasswordStrength {
  const problems: string[] = [];
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    problems.push(`Mật khẩu phải có ít nhất ${ADMIN_PASSWORD_MIN_LENGTH} ký tự.`);
  }
  if (!/[a-z]/.test(password)) problems.push('Cần ít nhất một chữ thường.');
  if (!/[A-Z]/.test(password)) problems.push('Cần ít nhất một chữ hoa.');
  if (!/[0-9]/.test(password)) problems.push('Cần ít nhất một chữ số.');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('Cần ít nhất một ký tự đặc biệt.');
  if (/\s/.test(password)) problems.push('Mật khẩu không được chứa khoảng trắng.');
  if (/^(admin|password|changeme|change-me|kas)/i.test(password)) {
    problems.push('Mật khẩu quá dễ đoán.');
  }
  return { ok: problems.length === 0, problems };
}

export type CreateAdminOutcome =
  | { created: true; adminId: number; username: string }
  | { created: false; reason: 'admin-exists' | 'username-taken'; username: string };

export interface CreateAdminOptions {
  username: string;
  password: string;
  fullName: string;
  /**
   * Allow creating an additional Admin when one already exists. Off by default:
   * an accidental second bootstrap must not silently mint another superuser.
   */
  allowAdditional?: boolean;
  client?: PrismaClient;
}

export async function createInitialAdmin(options: CreateAdminOptions): Promise<CreateAdminOutcome> {
  const client = options.client ?? defaultPrisma;
  const username = normalizeUsername(options.username);

  if (username.length === 0) throw new Error('Tên đăng nhập không được để trống.');
  if (options.fullName.trim().length === 0) throw new Error('Họ tên không được để trống.');

  const strength = checkAdminPasswordStrength(options.password);
  if (!strength.ok) {
    // The password is never echoed back — only what is wrong with it.
    throw new Error(`Mật khẩu chưa đủ mạnh:\n  - ${strength.problems.join('\n  - ')}`);
  }

  const existingAdmin = await client.user.findFirst({ where: { role: 'ADMIN' } });
  if (existingAdmin && !options.allowAdditional) {
    return { created: false, reason: 'admin-exists', username: existingAdmin.username };
  }

  if (await client.user.findUnique({ where: { username } })) {
    return { created: false, reason: 'username-taken', username };
  }

  const admin = await client.user.create({
    data: {
      username,
      passwordHash: await hashPassword(options.password),
      fullName: options.fullName.trim(),
      role: 'ADMIN',
      branchId: null,
      active: true,
      // The operator must rotate the bootstrap password at first login.
      mustChangePassword: true,
    },
  });

  return { created: true, adminId: admin.id, username };
}
