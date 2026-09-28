/**
 * BOOKING_DEPARTMENT ("Bộ phận đặt phòng") is GLOBAL like an admin — it has no
 * branch and picks one per charge document — but it is not an admin: it reaches
 * the Chứng từ module and nothing else that is admin-only.
 */
/**
 * TECHNICAL ("Bộ phận kỹ thuật") is GLOBAL too: one maintenance team serves all
 * eight properties, so it has no branch and works incidents from every one. It is
 * the ONLY role that may move an incident through its workflow — an Admin sees
 * everything and changes nothing.
 *
 * TECHNICAL_MANAGER ("Quản lý kỹ thuật") is global like TECHNICAL, and judges
 * that team's finished repairs — "Nghiệm thu". It inspects and nothing else: it
 * cannot accept or complete a repair, and it is not an admin.
 *
 * NOTE: this union is hand-written and is NOT generated from the Prisma enum, so
 * adding a role to the schema does not update it. `ROLE_LABEL` below is the one
 * place that fails to compile when the two drift — keep it exhaustive.
 */
export type UserRole = 'ADMIN' | 'RECEPTIONIST' | 'BOOKING_DEPARTMENT' | 'TECHNICAL' | 'TECHNICAL_MANAGER';

/** How each role is named to a person. */
export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'Quản trị viên',
  RECEPTIONIST: 'Lễ tân',
  BOOKING_DEPARTMENT: 'Bộ phận đặt phòng',
  TECHNICAL: 'Bộ phận kỹ thuật',
  TECHNICAL_MANAGER: 'Quản lý kỹ thuật',
};

export interface Branch {
  id: number;
  code: string;
  hotelName: string;
  address: string;
  /**
   * The operator-facing "Chi nhánh N" label, added in Milestone C.3.7. Optional
   * because older cached payloads (and fixtures) may predate it — never use it
   * for identity or authorization, which always key off `id` / `code`.
   */
  branchNumber?: number;
  breakfastIncluded?: boolean;
}

/** "Chi nhánh 2 — 260 Lý Tự Trọng", falling back to the address alone. */
export function branchLabel(branch: Pick<Branch, 'address' | 'branchNumber'>): string {
  return branch.branchNumber ? `Chi nhánh ${branch.branchNumber} — ${branch.address}` : branch.address;
}

/** The safe authenticated user as returned by GET /api/auth/me. */
export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
  branch: Branch | null;
  active: boolean;
  mustChangePassword: boolean;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: AuthUser;
  mustChangePassword: boolean;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}
