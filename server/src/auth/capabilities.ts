/**
 * WHAT EACH ROLE MAY DO — named capabilities, one table.
 *
 * Roles stay the identity of an account (and `branchScope.ts` still answers
 * WHICH branches it reaches). This file answers WHICH ACTIONS: a route or a
 * service asks `can(role, 'reports.delete')` instead of repeating a list of role
 * strings, so the next rule is one line here and a future "Phân quyền" screen
 * has a single table to read from (see docs/engineering/permissions.md).
 *
 * THE SERVER IS THE AUTHORITY. The client keeps a mirror of this table
 * (`client/src/auth/capabilities.ts`) only to decide which buttons to show; every
 * action is checked again here, with the branch scope, on every request.
 *
 * Capabilities are `module.action` and never removed or renamed once shipped:
 * a stored permission set would point at them.
 */
import type { RequestHandler } from 'express';
import type { UserRole } from '@prisma/client';
import { ApiError } from '../lib/errors';
import { CAPABILITY_TABLE } from './capabilityTable';

/** The shared table (`capabilityTable.ts`), checked here against the database's roles. */
export const CAPABILITIES = CAPABILITY_TABLE satisfies Record<string, readonly UserRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  return role != null && (CAPABILITIES[capability] as readonly UserRole[]).includes(role);
}

/** Refuses with 403 when the role lacks the capability. Branch scope is the service's. */
export function assertCan(role: UserRole, capability: Capability, message?: string): void {
  if (!can(role, capability)) throw ApiError.forbidden(message ?? 'Bạn không có quyền thực hiện thao tác này.');
}

/** Route gate: admits a request whose user holds ANY of the capabilities. Needs `requireAuth` first. */
export function requireCapability(...capabilities: Capability[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.currentUser?.role;
    if (!role) {
      next(ApiError.authRequired());
      return;
    }
    if (!capabilities.some((c) => can(role, c))) {
      next(ApiError.forbidden());
      return;
    }
    next();
  };
}
