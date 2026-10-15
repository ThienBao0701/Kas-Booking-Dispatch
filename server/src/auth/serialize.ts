import type { Prisma, Branch } from '@prisma/client';

/** A user loaded together with its branch relation. */
export type UserWithBranch = Prisma.UserGetPayload<{ include: { branch: true } }>;

export interface PublicBranch {
  id: number;
  code: string;
  hotelName: string;
  address: string;
  /** Human-readable "Chi nhánh N" label. Never an authorization key. */
  branchNumber: number;
  breakfastIncluded: boolean;
}

export interface PublicUser {
  id: number;
  username: string;
  fullName: string;
  role: UserWithBranch['role'];
  branch: PublicBranch | null;
  active: boolean;
  mustChangePassword: boolean;
  /** Quản lý lễ tân only: the ids of the branches it supervises. */
  managedBranchIds?: number[];
}

/** Managed accounts add audit timestamps for the Admin listing. */
export interface ManagedUser extends PublicUser {
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  /** Quản lý lễ tân: the branches it supervises (empty for every other role). */
  managedBranches: PublicBranch[];
}

export function serializeBranch(branch: Branch | null): PublicBranch | null {
  if (!branch) return null;
  return {
    id: branch.id,
    code: branch.code,
    hotelName: branch.hotelName,
    address: branch.address,
    branchNumber: branch.branchNumber,
    breakfastIncluded: branch.breakfastIncluded,
  };
}

/**
 * The single source of truth for what a user object looks like on the wire.
 * `passwordHash` is never referenced here, so it cannot leak through any
 * endpoint that serializes a user this way.
 */
export function serializeUser(user: UserWithBranch & { managedBranchIds?: number[] }): PublicUser {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    branch: serializeBranch(user.branch),
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    // Only a Quản lý lễ tân carries it; the screens scope their branch pickers
    // by it. The SERVER never trusts it back — every request reloads the rows.
    ...(user.managedBranchIds ? { managedBranchIds: user.managedBranchIds } : {}),
  };
}

export function serializeManagedUser(
  user: UserWithBranch & { branchAssignments?: { branch: Branch }[] },
): ManagedUser {
  return {
    ...serializeUser(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    managedBranches: (user.branchAssignments ?? []).map((a) => serializeBranch(a.branch)!),
  };
}
