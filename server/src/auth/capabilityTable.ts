/**
 * THE CAPABILITY TABLE — the ONE source of truth for "which role may do which
 * action", shared by the server (which enforces it, `capabilities.ts`) and the
 * client (which only decides which buttons to show, `client/src/auth/capabilities.ts`).
 *
 * DEPENDENCY-FREE ON PURPOSE: no imports, plain string role names, so the
 * client bundle can import this very file and the two can never drift. The
 * server checks every name against Prisma's `UserRole`, the client against its
 * own `UserRole`; a misspelt role fails both typechecks.
 *
 * The server stays the authority: this table grants nothing by being read in a
 * browser — every action is checked again, with the branch scope, per request.
 *
 * Capabilities are `module.action`; a shipped name is never renamed or removed
 * (a stored permission set would point at it). See docs/engineering/permissions.md.
 */
const RECEPTION_SUPERVISORS = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'] as const;
const RECEPTION_MANAGERS = ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'] as const;

export const CAPABILITY_TABLE = {
  /** "Xóa" a journal record from the overview and the category pages (a void, audited). */
  'reports.delete': [...RECEPTION_SUPERVISORS],
  /**
   * The desk's own "Hủy": ONLY a record the receptionist entered itself on its
   * still-open shift (a mistake fixed before handover) — never a general delete.
   */
  'reports.voidOwnShiftEntry': ['RECEPTIONIST'],
  /** "Lịch sử xóa" — the deleted records of the reader's branches. */
  'reports.deletionHistory': ['RECEPTIONIST', ...RECEPTION_SUPERVISORS],
  /** "Nhập bù" — a record the receptionist missed, entered on its original shift. */
  'reports.lateEntry': [...RECEPTION_SUPERVISORS],
  /** A correction made for a receptionist must say why ("Lý do sửa" required). */
  'reports.editRequiresReason': [...RECEPTION_MANAGERS],

  /** "Giao việc → Nhân sự": hand an incident to a Quản lý kỹ thuật. */
  'technical.dispatchToManager': ['TECHNICAL_GENERAL_MANAGER'],
  /** "Giao kỹ thuật" to an in-house technician (of the incident's branch). */
  'technical.assignTechnician': [...RECEPTION_SUPERVISORS, 'TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  /** "Giao cho kĩ thuật bên ngoài". */
  'technical.dispatchExternal': ['TECHNICAL_MANAGER'],
  /** Complete an outside contractor's work and record its cost. */
  'technical.completeExternal': ['TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  /** Read an outside contractor's phone, specialty and company. */
  'technical.viewContractor': ['ADMIN', 'TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],

  /** "Bắt đầu dọn" — only the housekeeper the room is given to. */
  'housekeeping.startCleaning': ['HOUSEKEEPING'],
} as const;

export type CapabilityName = keyof typeof CAPABILITY_TABLE;
