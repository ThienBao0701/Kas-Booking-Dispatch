/**
 * WHICH BRANCHES AN ACCOUNT MAY SEE — the one definition every read and write uses.
 *
 * Before this existed, "who sees what" was `role === 'ADMIN'` or
 * `user.branchId === x`, repeated per service. Two new roles break both shapes:
 * a Quản lý lễ tân sees SEVERAL branches (and `branchId` is null), a Tổng quản
 * lý lễ tân sees all of them without being an Admin. One function answers the
 * question; each service applies the answer.
 *
 * FAIL CLOSED. A manager whose assignments were not loaded, a receptionist with
 * no branch, an unknown role — all resolve to the EMPTY list, which matches no
 * row. A scope that silently widened when data was missing is the hole this
 * module exists to prevent.
 */
import type { Prisma, UserRole } from '@prisma/client';
import { ApiError } from '../lib/errors';

/** Every branch, or exactly these. */
export type BranchScope = 'ALL' | readonly number[];

/**
 * The actor shape the scoped services take. `managedBranchIds` is set by
 * `requireAuth` for a Quản lý lễ tân, from `UserBranchAssignment` on EVERY
 * request, so a reassignment by the Admin applies to the next request.
 */
export interface ScopedActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
  managedBranchIds?: readonly number[];
}

/** What the scope itself depends on — any actor shape that carries these works. */
export type ScopeSubject = Pick<ScopedActor, 'role' | 'branchId' | 'managedBranchIds'>;

/**
 * The roles that supervise Reception: they read the operational journal of
 * their branches, create and correct records there, and manage incidents
 * (including assigning technicians). Admin is one of them and keeps everything
 * else it already had.
 */
export const RECEPTION_SUPERVISOR_ROLES = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'] as const;

export type ReceptionSupervisorRole = (typeof RECEPTION_SUPERVISOR_ROLES)[number];

export function isReceptionSupervisor(role: UserRole): role is ReceptionSupervisorRole {
  return (RECEPTION_SUPERVISOR_ROLES as readonly string[]).includes(role);
}

/** "Admin tạo" and its siblings — how a supervisor-entered record is labelled. */
export const SUPERVISOR_SOURCE_LABELS: Record<ReceptionSupervisorRole, string> = {
  ADMIN: 'Admin tạo',
  RECEPTION_MANAGER: 'Quản lý lễ tân tạo',
  RECEPTION_GENERAL_MANAGER: 'Tổng quản lý lễ tân tạo',
};

/** The source label for a creator role, or null for a receptionist / legacy row. */
export function supervisorSourceLabel(role: UserRole | null | undefined): string | null {
  return role && isReceptionSupervisor(role) ? SUPERVISOR_SOURCE_LABELS[role] : null;
}

/**
 * The branch scope of an actor for RECEPTION data (journal, incidents, room
 * collections, chat). Branchless departments (technical, booking) get the empty
 * scope here; their own rules live with the data they are allowed to touch.
 */
export function branchScopeOf(actor: ScopeSubject): BranchScope {
  switch (actor.role) {
    case 'ADMIN':
    case 'RECEPTION_GENERAL_MANAGER':
      return 'ALL';
    case 'RECEPTION_MANAGER':
      return actor.managedBranchIds ?? [];
    case 'RECEPTIONIST':
    case 'HOUSEKEEPING':
      return actor.branchId !== null ? [actor.branchId] : [];
    default:
      return [];
  }
}

export function scopeIncludes(scope: BranchScope, branchId: number): boolean {
  return scope === 'ALL' || scope.includes(branchId);
}

/** Refuses a branch outside the actor's scope — the write-side check. */
export function assertBranchInScope(actor: ScopeSubject, branchId: number | null | undefined): number {
  if (branchId == null || !Number.isInteger(branchId)) {
    throw ApiError.validation('Vui lòng chọn một chi nhánh cụ thể.');
  }
  if (!scopeIncludes(branchScopeOf(actor), branchId)) {
    throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
  }
  return branchId;
}

/**
 * The branch clause for a READ: the actor's scope, narrowed to what the request
 * asked for. A requested branch outside the scope is REFUSED rather than
 * silently dropped — an empty report that looked like "nothing happened there"
 * would be a lie about a branch the reader may not see.
 */
export function scopedBranchFilter(
  actor: ScopeSubject,
  requested?: number | readonly number[],
): { branchId?: number | { in: number[] } } {
  const scope = branchScopeOf(actor);
  const wanted = requested === undefined ? undefined : Array.isArray(requested) ? requested : [requested as number];
  if (wanted !== undefined && wanted.length > 0) {
    for (const id of wanted) {
      if (!scopeIncludes(scope, id)) {
        throw ApiError.branchAccessDenied('Chi nhánh này nằm ngoài phạm vi của bạn.');
      }
    }
    return wanted.length === 1 ? { branchId: wanted[0]! } : { branchId: { in: [...wanted] } };
  }
  if (scope === 'ALL') return {};
  // `in: []` matches nothing — the fail-closed answer for an empty scope.
  return scope.length === 1 ? { branchId: scope[0]! } : { branchId: { in: [...scope] } };
}

/** The same scope as a Branch-table filter, for lists of branches. */
export function scopedBranchRows(actor: ScopeSubject): Prisma.BranchWhereInput {
  const scope = branchScopeOf(actor);
  if (scope === 'ALL') return { active: true };
  return { active: true, id: { in: [...scope] } };
}
