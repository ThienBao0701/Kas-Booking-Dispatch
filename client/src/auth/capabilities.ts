/**
 * WHAT EACH ROLE MAY DO — the client's MIRROR of `server/src/auth/capabilities.ts`.
 *
 * Display only: it decides which buttons a screen shows. The server checks every
 * action again, with the branch scope, on every request — a button shown here
 * by mistake is refused there. Keep the two tables in step (names never change
 * once shipped; see docs/engineering/permissions.md).
 */
import type { UserRole } from './types';

const RECEPTION_SUPERVISORS: UserRole[] = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'];

export const CAPABILITIES = {
  'reports.delete': RECEPTION_SUPERVISORS,
  'reports.voidOwnBranch': ['RECEPTIONIST'],
  'reports.deletionHistory': ['RECEPTIONIST', ...RECEPTION_SUPERVISORS],
  'reports.lateEntry': RECEPTION_SUPERVISORS,
  'reports.editRequiresReason': ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'],
  'technical.dispatchToManager': ['TECHNICAL_GENERAL_MANAGER'],
  'technical.assignTechnician': [...RECEPTION_SUPERVISORS, 'TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  'technical.dispatchExternal': ['TECHNICAL_MANAGER'],
  'technical.completeExternal': ['TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  'technical.viewContractor': ['ADMIN', 'TECHNICAL_MANAGER', 'TECHNICAL_GENERAL_MANAGER'],
  'housekeeping.startCleaning': ['HOUSEKEEPING'],
} satisfies Record<string, UserRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  return role != null && (CAPABILITIES[capability] as UserRole[]).includes(role);
}
