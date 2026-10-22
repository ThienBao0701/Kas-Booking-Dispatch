/**
 * "HỦY" ON THE DESK — shown only where the server would accept it: the
 * receptionist's OWN entry on its still-open shift. A supervisor's "Xóa" reaches
 * any live record of its scope (branch scope is the server's).
 */
import { describe, expect, it } from 'vitest';
import { mayVoidRecord } from './deskVoid';

const DESK = { id: 2, role: 'RECEPTIONIST' as const };
const COLLEAGUE = { id: 9, role: 'RECEPTIONIST' as const };
const row = (over: Partial<Parameters<typeof mayVoidRecord>[0]> = {}) => ({
  voided: false,
  createdBy: { id: 2, fullName: 'Lễ tân Một' },
  shiftSessionId: 's1',
  shiftClosed: false,
  lateEntry: null,
  ...over,
});

describe('mayVoidRecord', () => {
  it('lets the desk withdraw its own entry of the shift still running', () => {
    expect(mayVoidRecord(row(), DESK)).toBe(true);
  });

  it('refuses a colleague’s entry, a finished shift, a shift-less record and a manager’s late entry', () => {
    expect(mayVoidRecord(row(), COLLEAGUE)).toBe(false);
    expect(mayVoidRecord(row({ shiftClosed: true }), DESK)).toBe(false);
    expect(mayVoidRecord(row({ shiftSessionId: null }), DESK)).toBe(false);
    expect(
      mayVoidRecord(
        row({ lateEntry: { enteredBy: { id: 20, name: 'QL' }, enteredByRole: 'RECEPTION_MANAGER', enteredByRoleLabel: 'Quản lý lễ tân', reason: 'x', enteredAt: '' } }),
        DESK,
      ),
    ).toBe(false);
  });

  it('never offers a withdrawn record again, and nothing without a signed-in user', () => {
    expect(mayVoidRecord(row({ voided: true }), DESK)).toBe(false);
    expect(mayVoidRecord(row(), null)).toBe(false);
  });

  it('lets a reception supervisor delete any live record; other departments never', () => {
    expect(mayVoidRecord(row({ shiftClosed: true, createdBy: { id: 7, fullName: 'X' } }), { id: 1, role: 'ADMIN' })).toBe(true);
    expect(mayVoidRecord(row({ shiftClosed: true }), { id: 20, role: 'RECEPTION_MANAGER' })).toBe(true);
    expect(mayVoidRecord(row(), { id: 4, role: 'TECHNICAL' })).toBe(false);
  });
});
