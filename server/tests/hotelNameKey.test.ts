/**
 * The hotel-name comparison key.
 *
 * The first describe block is the one that matters. Dropping generic words
 * makes matching work; it also makes two properties easier to confuse, and this
 * system runs eight hotels whose names deliberately share vocabulary. If any
 * two configured names ever collapse to the same key — or one becomes a
 * word-aligned substring of another — the resolver would confidently dispatch a
 * guest to the wrong hotel. These tests fail the moment a noise word is added
 * that makes that possible.
 */
import { describe, expect, it } from 'vitest';
import { hotelNameContains, hotelNameKey } from '../src/booking/hotelNameKey';
import { BRANCHES } from '../src/db/branches';
import { BRANCH_ALIASES, AGODA_HOTEL_NAMES } from '../src/booking/branchMatcher';
import { PLATFORM_IDENTITY_SEED } from '../src/db/platformIdentitySeed';

/* ================================================================== */
/* The safety property                                                 */
/* ================================================================== */
describe('no two branches may share a key', () => {
  /** Every name any branch can be recognised by, grouped by branch code. */
  const namesByBranch = new Map<string, string[]>();
  for (const b of BRANCHES) {
    namesByBranch.set(b.code, [b.hotelName, ...(BRANCH_ALIASES[b.code] ?? [])]);
  }
  for (const identity of PLATFORM_IDENTITY_SEED) {
    const list = namesByBranch.get(identity.branchCode);
    if (list) list.push(identity.name);
  }
  for (const agoda of AGODA_HOTEL_NAMES) {
    if (agoda.branchCode === null) continue;
    const list = namesByBranch.get(agoda.branchCode);
    if (list) list.push(agoda.name);
  }

  const entries = [...namesByBranch.entries()];

  it('covers all eight branches, so the checks below are not vacuous', () => {
    expect(entries.length).toBe(8);
    for (const [, names] of entries) expect(names.length).toBeGreaterThan(0);
  });

  it('never maps one key to two different branches', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const [code, names] of entries) {
      for (const name of names) {
        const key = hotelNameKey(name);
        const existing = owner.get(key);
        if (existing !== undefined && existing !== code) {
          collisions.push(`"${key}" claimed by ${existing} and ${code}`);
        }
        owner.set(key, code);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('never leaves one branch name contained inside another branch name', () => {
    // Containment is a matching rung, so an overlap here would be resolved by
    // whichever rung fired first rather than by the operator.
    const overlaps: string[] = [];
    for (const [codeA, namesA] of entries) {
      for (const [codeB, namesB] of entries) {
        if (codeA === codeB) continue;
        for (const a of namesA) {
          for (const b of namesB) {
            const keyA = hotelNameKey(a);
            const keyB = hotelNameKey(b);
            if (keyA !== keyB && hotelNameContains(keyA, keyB)) {
              overlaps.push(`${codeB} "${keyB}" sits inside ${codeA} "${keyA}"`);
            }
          }
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('keeps the words that tell the KAS properties apart', () => {
    // These read like filler and are deliberately NOT stripped.
    expect(hotelNameKey('KAS Passion Boutique Hotel')).toBe('kas passion boutique');
    expect(hotelNameKey('KAS Zody Boutique Hotel')).toBe('kas zody boutique');
    expect(hotelNameKey('Luxury Ancient Boutique Hotel')).toBe('luxury ancient boutique');
    expect(hotelNameKey('INDOCHINA Premium')).toBe('indochina premium');
  });
});

/* ================================================================== */
/* Normalisation                                                       */
/* ================================================================== */
describe('the key itself', () => {
  it('folds the four spellings from the hotfix report to one key', () => {
    for (const name of [
      'KAS DILLY HOTEL',
      'KAS DILLY',
      'Kas Dilly',
      'Kas Dilly Hotel',
      'KAS DILLY HOTEL & SPA',
    ]) {
      expect(hotelNameKey(name)).toBe('kas dilly');
    }
  });

  it('lower-cases, trims and collapses whitespace', () => {
    expect(hotelNameKey('   KAS    DILLY   ')).toBe('kas dilly');
    expect(hotelNameKey('KAS\tDILLY')).toBe('kas dilly');
  });

  it('removes punctuation', () => {
    expect(hotelNameKey('Ben Thanh Market - Luxur')).toBe('ben thanh market luxur');
    expect(hotelNameKey('Saigon Hotel & Ben Thanh')).toBe('saigon ben thanh');
  });

  it('removes Vietnamese accents', () => {
    expect(hotelNameKey('Khách Sạn Đông Dương')).toBe('khach san dong duong');
  });

  it('returns empty for nothing at all', () => {
    expect(hotelNameKey(null)).toBe('');
    expect(hotelNameKey(undefined)).toBe('');
    expect(hotelNameKey('   ')).toBe('');
    expect(hotelNameKey('!!!')).toBe('');
  });

  it('does not reduce an all-noise name to the empty string', () => {
    // An empty key would match every other name. A property really called
    // "The Hotel" keeps its normalised form instead.
    expect(hotelNameKey('The Hotel')).toBe('the hotel');
    expect(hotelNameKey('Hotel')).toBe('hotel');
  });
});

/* ================================================================== */
/* Containment                                                         */
/* ================================================================== */
describe('containment is word-aligned', () => {
  it('accepts a whole word sequence', () => {
    expect(hotelNameContains('kas dilly riverside', 'kas dilly')).toBe(true);
    expect(hotelNameContains('kas dilly', 'kas dilly')).toBe(true);
    expect(hotelNameContains('saigon ben thanh market', 'ben thanh')).toBe(true);
  });

  it('rejects a partial word', () => {
    // "kas dil" must not claim "kas dilly": a truncation that only half-spells
    // a property is exactly the case that should reach an operator.
    expect(hotelNameContains('kas dilly', 'kas dil')).toBe(false);
    expect(hotelNameContains('kas dilly', 'illy')).toBe(false);
  });

  it('rejects an empty side, which would otherwise match everything', () => {
    expect(hotelNameContains('kas dilly', '')).toBe(false);
    expect(hotelNameContains('', 'kas dilly')).toBe(false);
  });

  it('is directional', () => {
    expect(hotelNameContains('kas dilly riverside', 'kas dilly')).toBe(true);
    expect(hotelNameContains('kas dilly', 'kas dilly riverside')).toBe(false);
  });
});
