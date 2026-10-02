/**
 * MONEY INPUT, as a pure function.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. What the operator sees while typing: "3150000" reads back "3.150.000".
 *   2. Empty input is NULL, never 0. "Nothing entered" and "zero đồng" are
 *      different answers, and conflating them is how a blank field becomes a
 *      zero-đồng payment nobody can explain against the drawer.
 *   3. The round trip: whatever the field shows, `parseVnd` recovers the integer
 *      that will be sent.
 */
import { describe, expect, it } from 'vitest';
import { formatVnd, groupDigits, parseVnd, parseVndOrZero } from './money';

describe('groupDigits', () => {
  it('groups in threes from the right', () => {
    expect(groupDigits('300000')).toBe('300.000');
    expect(groupDigits('3150000')).toBe('3.150.000');
    expect(groupDigits('7570000')).toBe('7.570.000');
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1.000');
  });

  it('stays empty rather than becoming zero', () => {
    expect(groupDigits('')).toBe('');
    expect(groupDigits('   ')).toBe('');
    expect(groupDigits('abc')).toBe('');
  });

  it('ignores everything that is not a digit, including its own separators', () => {
    // The field's own output is valid input — that is what makes it round-trip
    // while the operator keeps typing into the middle of it.
    expect(groupDigits('3.150.000')).toBe('3.150.000');
    expect(groupDigits('3.150.000 ₫')).toBe('3.150.000');
    expect(groupDigits('1a2b3c')).toBe('123');
  });

  it('drops leading zeros so "0300" is never stored as three hundred', () => {
    expect(groupDigits('0300000')).toBe('300.000');
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('000')).toBe('0');
  });
});

describe('parseVnd', () => {
  it('returns the integer the server will receive', () => {
    expect(parseVnd('3.150.000')).toBe(3150000);
    expect(parseVnd('300000')).toBe(300000);
    expect(parseVnd('0')).toBe(0);
  });

  it('returns null for an empty field — NOT zero', () => {
    expect(parseVnd('')).toBeNull();
    expect(parseVnd('   ')).toBeNull();
    expect(parseVnd('đ')).toBeNull();
  });

  it('gives an explicit zero only where the caller asked for one', () => {
    expect(parseVndOrZero('')).toBe(0);
    expect(parseVndOrZero('100.000')).toBe(100000);
  });

  it('refuses a number too large to be exact', () => {
    expect(parseVnd('9'.repeat(20))).toBeNull();
  });
});

describe('formatVnd', () => {
  it('renders whole đồng with Vietnamese grouping', () => {
    expect(formatVnd(11870000)).toBe('11.870.000 ₫');
    expect(formatVnd(0)).toBe('0 ₫');
  });

  it('never invents an amount', () => {
    expect(formatVnd(null)).toBe('—');
    expect(formatVnd(undefined)).toBe('—');
  });

  it('round-trips through the input format', () => {
    for (const value of [0, 1, 999, 1000, 300000, 3150000, 7570000, 11870000]) {
      expect(parseVnd(groupDigits(String(value)))).toBe(value);
    }
  });
});
