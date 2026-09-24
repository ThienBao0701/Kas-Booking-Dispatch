import { api } from './client';
import type { Branch, UserRole } from '../auth/types';

export interface ManagedUser {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
  branch: Branch | null;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** The roles this screen can create. An admin is bootstrapped, never minted here. */
export type ManageableRole = 'RECEPTIONIST' | 'BOOKING_DEPARTMENT' | 'TECHNICAL';

/**
 * The departments that are GLOBAL — no branch, by definition.
 *
 * Derived from a list rather than tested as `!== 'BOOKING_DEPARTMENT'`: that
 * negative form silently classified any NEW branchless role as a receptionist,
 * demanded a branch for it, and was then refused by the server.
 */
export const GLOBAL_ROLES: readonly ManageableRole[] = ['BOOKING_DEPARTMENT', 'TECHNICAL'];

export function requiresBranch(role: ManageableRole | undefined): boolean {
  return !GLOBAL_ROLES.includes(role ?? 'RECEPTIONIST');
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  temporaryPassword: string;
  /** Omitted means RECEPTIONIST, as it always did. */
  role?: ManageableRole;
  /** Required for a receptionist; must be absent for a global department. */
  branchId?: number;
}

export const adminUsersApi = {
  /** `includeAdmins` adds ADMIN accounts, read-only — only the account screen asks. */
  list: (params: { includeAdmins?: boolean } = {}) =>
    api.get<{ users: ManagedUser[] }>(params.includeAdmins ? '/admin/users?includeAdmins=true' : '/admin/users'),
  create: (input: CreateUserInput) => api.post<{ user: ManagedUser }>('/admin/users', input),
  enable: (id: number) => api.post<{ user: ManagedUser }>(`/admin/users/${id}/enable`),
  disable: (id: number) => api.post<{ user: ManagedUser }>(`/admin/users/${id}/disable`),
  resetPassword: (id: number, temporaryPassword: string) =>
    api.post<{ success: true }>(`/admin/users/${id}/reset-password`, { temporaryPassword }),
};
