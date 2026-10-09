/**
 * THE CLIENT CANNOT DRIFT FROM THE SERVER'S CAPABILITIES — it reads the server's
 * own table (`server/src/auth/capabilityTable.ts`), never a copy. These checks
 * pin that, and the rules the screens lean on for display. Every action is still
 * re-checked by the server; nothing here grants access.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITY_TABLE } from '../../../server/src/auth/capabilityTable';
import { CAPABILITIES, can } from './capabilities';
import { ROLE_LABEL } from './types';

describe('the shared capability table', () => {
  it('is the server’s table itself, not a copy', () => {
    expect(CAPABILITIES).toBe(CAPABILITY_TABLE);
  });

  it('names only roles this client knows', () => {
    const known = new Set(Object.keys(ROLE_LABEL));
    for (const [name, roles] of Object.entries(CAPABILITIES)) {
      for (const role of roles) expect(known.has(role), `${name}: ${role}`).toBe(true);
    }
  });

  it('keeps the rules the screens show buttons by', () => {
    expect(can('RECEPTIONIST', 'reports.delete')).toBe(false);
    expect(can('RECEPTIONIST', 'reports.voidOwnShiftEntry')).toBe(true);
    expect(can('RECEPTION_MANAGER', 'reports.delete')).toBe(true);
    expect(can('TECHNICAL_GENERAL_MANAGER', 'technical.dispatchToManager')).toBe(true);
    expect(can('RECEPTION_MANAGER', 'technical.viewContractor')).toBe(false);
    expect(can(null, 'reports.deletionHistory')).toBe(false);
  });
});
