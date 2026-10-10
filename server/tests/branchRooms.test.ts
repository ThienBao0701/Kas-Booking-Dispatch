/**
 * The branch room catalog — the one list every room selector reads and the
 * server validates against. Pins the operator's corrections for Chi nhánh 3 and 6.
 */
import { describe, expect, it } from 'vitest';
import { catalogRoom, roomsForBranchCode } from '../src/room/branchRooms';

describe('the branch room catalog', () => {
  it('Chi nhánh 3 has 802, 901, 902, 1001, 1002 and 1101 — and no 903, 1003 or 1103', () => {
    const rooms = roomsForBranchCode('NGUYEN_TRAI_47A')!;
    for (const room of ['802', '901', '902', '1001', '1002', '1101']) expect(rooms).toContain(room);
    for (const room of ['903', '1003', '1103']) {
      expect(rooms).not.toContain(room);
      expect(() => catalogRoom('NGUYEN_TRAI_47A', room)).toThrow();
    }
    // Unique, and walked floor by floor.
    expect(new Set(rooms).size).toBe(rooms.length);
    expect(rooms.slice(-3)).toEqual(['1001', '1002', '1101']);
  });

  it('Chi nhánh 6 has 801, with its other rooms unchanged', () => {
    const rooms = roomsForBranchCode('BUI_THI_XUAN_40')!;
    expect(rooms).toContain('801');
    expect(catalogRoom('BUI_THI_XUAN_40', '801')).toBe('801');
    expect(rooms).toHaveLength(42);
  });
});
