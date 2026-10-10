import { describe, expect, it } from 'vitest';
import { branchOptionLabel, branchTone } from './branchTone';

describe('branchTone', () => {
  it('is the same tone for the same branch every time', () => {
    expect(branchTone({ id: 7, branchNumber: 3 })).toBe(branchTone({ id: 99, branchNumber: 3 }));
  });

  it('follows the branch number, not the row id', () => {
    expect(branchTone({ id: 1, branchNumber: 1 })).not.toBe(branchTone({ id: 1, branchNumber: 2 }));
  });

  it('falls back to the id when the branch has no number', () => {
    expect(branchTone({ id: 2, branchNumber: null })).toBe(branchTone({ id: 99, branchNumber: 2 }));
    expect(branchTone({ id: 2 })).toBe(branchTone({ id: 2, branchNumber: 0 }));
  });

  it('gives a branch added later a tone, wrapping rather than failing', () => {
    for (const n of [9, 16, 40, 1000]) {
      expect(branchTone({ id: n, branchNumber: n }).solid).toMatch(/^bg-/);
    }
    expect(branchTone({ id: 9, branchNumber: 9 })).toBe(branchTone({ id: 1, branchNumber: 1 }));
  });

  it('never throws on a nonsensical key', () => {
    expect(branchTone({ id: 0 }).solid).toMatch(/^bg-/);
    expect(branchTone({ id: -5, branchNumber: -1 }).solid).toMatch(/^bg-/);
  });
});

describe('branchOptionLabel', () => {
  it('reads "<address> - Chi nhánh NN"', () => {
    expect(branchOptionLabel({ address: '05 Trương Định', branchNumber: 1 })).toBe('05 Trương Định - Chi nhánh 01');
    expect(branchOptionLabel({ address: '99 Đường Mới', branchNumber: 12 })).toBe('99 Đường Mới - Chi nhánh 12');
  });

  it('is just the address when the branch has no number', () => {
    expect(branchOptionLabel({ address: '05 Trương Định', branchNumber: null })).toBe('05 Trương Định');
  });
});
