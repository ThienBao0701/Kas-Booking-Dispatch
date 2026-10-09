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
  /** Quản lý lễ tân / Quản lý kỹ thuật: the branches ticked. Empty for every other role. */
  managedBranches?: Branch[];
}

/** The roles this screen can create. An admin is bootstrapped, never minted here. */
export type ManageableRole =
  | 'RECEPTIONIST'
  | 'BOOKING_DEPARTMENT'
  | 'TECHNICAL'
  | 'TECHNICAL_MANAGER'
  | 'HOUSEKEEPING'
  | 'RECEPTION_MANAGER'
  | 'RECEPTION_GENERAL_MANAGER'
  | 'HOUSEKEEPING_MANAGER'
  | 'TECHNICAL_GENERAL_MANAGER';

/**
 * The accounts with NO single branch — the global departments, and the two
 * reception supervisors (a Quản lý lễ tân has SEVERAL branches, chosen with
 * checkboxes; a Tổng quản lý lễ tân has all of them).
 *
 * Derived from a list rather than tested as `!== 'BOOKING_DEPARTMENT'`: that
 * negative form silently classified any NEW branchless role as a receptionist,
 * demanded a branch for it, and was then refused by the server.
 */
export const GLOBAL_ROLES: readonly ManageableRole[] = [
  'BOOKING_DEPARTMENT',
  'TECHNICAL',
  'TECHNICAL_MANAGER',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
  'TECHNICAL_GENERAL_MANAGER',
];

export function requiresBranch(role: ManageableRole | undefined): boolean {
  return !GLOBAL_ROLES.includes(role ?? 'RECEPTIONIST');
}

/**
 * Quản lý buồng phòng and Bộ phận buồng phòng: exactly ONE branch, chosen in the
 * same checkbox list — the worker's "Vào ca" opens the shift there.
 */
export function requiresSingleBranchChoice(role: UserRole | undefined): boolean {
  return role === 'HOUSEKEEPING_MANAGER' || role === 'HOUSEKEEPING';
}

/** Quản lý lễ tân, Quản lý kỹ thuật and Tổng quản lý kỹ thuật pick their branches — one or more, with checkboxes. */
export function requiresBranchSet(role: UserRole | undefined): boolean {
  return role === 'RECEPTION_MANAGER' || role === 'TECHNICAL_MANAGER' || role === 'TECHNICAL_GENERAL_MANAGER';
}

/**
 * Kỹ thuật viên: the branches it can be GIVEN WORK at ("Giao kỹ thuật" lists
 * only the technicians of the incident's branch). Ticked like a manager's set;
 * an older account without any keeps working but cannot be assigned anywhere.
 */
export function isTechnicianBranchRole(role: UserRole | undefined): boolean {
  return role === 'TECHNICAL';
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  temporaryPassword: string;
  /** Omitted means RECEPTIONIST, as it always did. */
  role?: ManageableRole;
  /** Required for a receptionist; must be absent for a global department. */
  branchId?: number;
  /** Quản lý lễ tân only: the branches it supervises (at least one). */
  branchIds?: number[];
}

export const adminUsersApi = {
  /** `includeAdmins` adds ADMIN accounts, read-only — only the account screen asks. */
  list: (params: { includeAdmins?: boolean } = {}) =>
    api.get<{ users: ManagedUser[] }>(params.includeAdmins ? '/admin/users?includeAdmins=true' : '/admin/users'),
  create: (input: CreateUserInput) => api.post<{ user: ManagedUser }>('/admin/users', input),
  /** Replaces a Quản lý lễ tân's supervised branches, as a set. Records it created stay put. */
  setBranches: (id: number, branchIds: number[]) =>
    api.put<{ user: ManagedUser }>(`/admin/users/${id}`, { branchIds }),
  /** "Sửa": the name, and the branch or branches the role carries. */
  update: (id: number, input: { fullName?: string; branchId?: number; branchIds?: number[] }) =>
    api.put<{ user: ManagedUser }>(`/admin/users/${id}`, input),
  /** "Xóa": permanent; the account's history stays, under its recorded names. */
  remove: (id: number) => api.del<{ deleted: true; id: number }>(`/admin/users/${id}`),
  enable: (id: number) => api.post<{ user: ManagedUser }>(`/admin/users/${id}/enable`),
  disable: (id: number) => api.post<{ user: ManagedUser }>(`/admin/users/${id}/disable`),
  resetPassword: (id: number, temporaryPassword: string) =>
    api.post<{ success: true }>(`/admin/users/${id}/reset-password`, { temporaryPassword }),
};

/** "Mật khẩu ghi đè Admin": whether one is set — never the password itself. */
export interface AdminOverrideStatus {
  configured: boolean;
  updatedAt: string | null;
  setByName: string | null;
}

export const adminOverrideApi = {
  status: () => api.get<AdminOverrideStatus>('/admin/override-password'),
  set: (password: string, confirmPassword: string) =>
    api.put<AdminOverrideStatus>('/admin/override-password', { password, confirmPassword }),
  clear: () => api.del<AdminOverrideStatus>('/admin/override-password'),
};
