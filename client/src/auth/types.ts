/**
 * BOOKING_DEPARTMENT ("Bộ phận đặt phòng") is GLOBAL like an admin — it has no
 * branch and picks one per charge document — but it is not an admin: it reaches
 * the Chứng từ module and nothing else that is admin-only.
 */
/**
 * HOUSEKEEPING ("Bộ phận buồng phòng") is bound to ONE branch, like a receptionist,
 * but reaches only its own screens: room inspections and the deliveries addressed
 * to it. The server confines it to those routes; nothing here grants more.
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
export type UserRole =
  | 'ADMIN'
  | 'RECEPTIONIST'
  | 'BOOKING_DEPARTMENT'
  | 'TECHNICAL'
  | 'TECHNICAL_MANAGER'
  | 'HOUSEKEEPING'
  | 'RECEPTION_MANAGER'
  | 'RECEPTION_GENERAL_MANAGER'
  /** "Quản lý buồng phòng" — the housekeeping of exactly one branch (`branch`). */
  | 'HOUSEKEEPING_MANAGER'
  /** "Tổng quản lý kỹ thuật" — the incidents of its ticked branches, handed to a Quản lý kỹ thuật or a technician. */
  | 'TECHNICAL_GENERAL_MANAGER';

/** How each role is named to a person. */
export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'Quản trị viên',
  RECEPTIONIST: 'Lễ tân',
  BOOKING_DEPARTMENT: 'Bộ phận đặt phòng',
  TECHNICAL: 'Bộ phận kỹ thuật',
  TECHNICAL_MANAGER: 'Quản lý kỹ thuật',
  HOUSEKEEPING: 'Bộ phận buồng phòng',
  RECEPTION_MANAGER: 'Quản lý lễ tân',
  RECEPTION_GENERAL_MANAGER: 'Tổng quản lý lễ tân',
  HOUSEKEEPING_MANAGER: 'Quản lý buồng phòng',
  TECHNICAL_GENERAL_MANAGER: 'Tổng quản lý kỹ thuật',
};

/** Who runs the daily room work: the Admin (every branch), the Quản lý buồng phòng (its one). */
export function isRoomWorkManager(role: UserRole | undefined): boolean {
  return role === 'ADMIN' || role === 'HOUSEKEEPING_MANAGER';
}

/**
 * THE RECEPTION SUPERVISORS — Admin, Quản lý lễ tân (its assigned branches) and
 * Tổng quản lý lễ tân (every branch). They share the supervision screens; the
 * SERVER scopes every read and write by branch, these screens only follow it.
 */
export const RECEPTION_SUPERVISOR_ROLES: readonly UserRole[] = [
  'ADMIN',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
];

/** Who gives an incident to a technician: the reception supervisors and the two technical managers. */
export function isTechnicalAssigner(role: UserRole | undefined): boolean {
  return isReceptionSupervisor(role) || role === 'TECHNICAL_MANAGER' || role === 'TECHNICAL_GENERAL_MANAGER';
}

/** The technical managers' workspace — "Quản lý sự cố kỹ thuật". */
export function isTechnicalManagerRole(role: UserRole | undefined): boolean {
  return role === 'TECHNICAL_MANAGER' || role === 'TECHNICAL_GENERAL_MANAGER';
}

export function isReceptionSupervisor(role: UserRole | undefined): boolean {
  return role !== undefined && RECEPTION_SUPERVISOR_ROLES.includes(role);
}

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
  /** Quản lý lễ tân only: the branches it supervises. */
  managedBranchIds?: number[];
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
