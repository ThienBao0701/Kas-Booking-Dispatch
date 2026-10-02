import { describe, expect, it } from 'vitest';
import { parseQuantity } from './quantity';

describe('parseQuantity', () => {
  it('accepts a whole number of at least 1, trimmed', () => {
    expect(parseQuantity('1')).toBe(1);
    expect(parseQuantity(' 12 ')).toBe(12);
  });

  it('never coerces what is not yet a quantity', () => {
    for (const bad of ['', '   ', '0', '-3', '1.5', '1,5', 'abc', '2 cái', '1e3', '+4']) {
      expect(parseQuantity(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses a number too large to be exact', () => {
    expect(parseQuantity('99999999999999999999')).toBeNull();
  });
});
