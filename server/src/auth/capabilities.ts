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

const RECEPTION_SUPERVISORS = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'] as const;
const RECEPTION_MANAGERS = ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'] as const;

export const CAPABILITIES = {
  /** "Xóa" a journal record from the overview and the category pages (a void, audited). */
  'reports.delete': [...RECEPTION_SUPERVISORS],
  /** The desk's own "Hủy" on its branch's records — unchanged, existing behaviour. */
  'reports.voidOwnBranch': ['RECEPTIONIST'],
  /** "Lịch sử xóa" — the deleted records of the reader's branches. */
  'reports.deletionHistory': ['RECEPTIONIST', ...RECEPTION_SUPERVISORS],
  /** "Nhập bù" — a record the receptionist missed, entered on its original shift. */
  'reports.lateEntry': [...RECEPTION_SUPERVISORS],
  /** A correction made for a receptionist must say why ("Lý do sửa" required). */
  'reports.editRequiresReason': [...RECEPTION_MANAGERS],

  /** "Giao việc → Nhân sự": hand an incident to a Quản lý kỹ thuật. */
  'technical.dispatchToManager': ['TECHNICAL_GENERAL_MANAGER'],
  /** "Giao kỹ thuật" to an in-house technician. */
  'technical.assignTechnician': [
    ...RECEPTION_SUPERVISORS,
    'TECHNICAL_MANAGER',
    'TECHNICAL_GENERAL_MANAGER',
  ],
  /** "Giao cho kĩ thuật bên ngoài". */
  'technical.dispatchExternal': ['TECHNICAL_MANAGER'],
  /** Complete an outside contractor's work and record its cost. */
  'technical.completeExternal': ['TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  /** Read an outside contractor's name, phone and company. */
  'technical.viewContractor': ['ADMIN', 'TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],

  /** "Bắt đầu dọn" — only the housekeeper the room is given to. */
  'housekeeping.startCleaning': ['HOUSEKEEPING'],
} as const satisfies Record<string, readonly UserRole[]>;

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
