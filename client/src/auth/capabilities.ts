/**
 * WHAT EACH ROLE MAY DO — for DISPLAY only: which buttons a screen shows.
 *
 * The table is NOT copied: it is the server's own file
 * (`server/src/auth/capabilityTable.ts`, dependency-free), imported here so the
 * client and the server can never disagree about a capability. The server
 * checks every action again, with the branch scope, on every request — a button
 * shown here grants nothing.
 */
import type { UserRole } from './types';
import { CAPABILITY_TABLE } from '../../../server/src/auth/capabilityTable';

/** Every role named in the shared table must be one this client knows. */
export const CAPABILITIES = CAPABILITY_TABLE satisfies Record<string, readonly UserRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  return role != null && (CAPABILITIES[capability] as readonly UserRole[]).includes(role);
}
