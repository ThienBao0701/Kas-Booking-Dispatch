/**
 * Booking.com branch resolution — the 5.1 hotfix.
 *
 * THE PRODUCTION SYMPTOM: Booking.com prints whatever public name a listing
 * carries, which is rarely character-equal to the internal name an Admin
 * maintains. "Modern Luxury Dilly Hotel & Spa" and "Modern Luxury Dilly" are
 * the same property; before this change neither resolved and every such booking
 * had to be assigned by hand.
 *
 * THE LINE THIS MUST NOT CROSS: relaxed matching applies to BOOKING.COM ONLY.
 * Every Agoda property here shares the tokens "KAS" and "Hotel", so the same
 * relaxation there could rate two different properties alike and dispatch a
 * guest to the wrong hotel — the failure the exact-only rule was introduced to
 * prevent. Half of this file exists to prove Agoda and CTrip did not move.
 *
 * And in no case does the resolver guess: two candidate branches is AMBIGUOUS
 * and assigns nothing, exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { resolveBranchIdentity, type IdentityBranch } from '../src/booking/identityResolver';

/**
 * Two branches whose names share vocabulary, as the real eight do. Both carry a
 * Booking.com identity, an internal name and (for one) an Admin alias.
 */
const DILLY: IdentityBranch = {
  id: 8,
  code: 'LE_THANH_TON_191',
  hotelName: 'Modern Luxury Dilly Hotel',
  address: '191 Le Thanh Ton',
  identities: [
    { platform: 'BOOKING_COM', name: 'Kas Dilly Hotel', normalizedName: 'kas dilly hotel' },
    { platform: 'AGODA', name: 'KAS Dilly Hotel', normalizedName: 'kas dilly hotel' },
  ],
};

const ELIANA: IdentityBranch = {
  id: 7,
  code: 'BUI_THI_XUAN_13',
  hotelName: 'Modern Luxury Eliana Hotel',
  address: '13 Bui Thi Xuan',
  identities: [
    { platform: 'BOOKING_COM', name: 'Kas Eliana Hotel', normalizedName: 'kas eliana hotel' },
    { platform: 'AGODA', name: 'KAS Eliana Luxury Hotel', normalizedName: 'kas eliana luxury hotel' },
  ],
  aliases: [{ source: 'BOOKING_COM', alias: 'Eliana Riverside Residence', matchMode: 'SIMILARITY' }],
};

/** Its Agoda name shares no word with its Booking.com name or internal name. */
const ZEPHYR: IdentityBranch = {
  id: 9,
  code: 'TEST_ZEPHYR',
  hotelName: 'Alpha House',
  address: '1 Alpha',
  identities: [
    { platform: 'BOOKING_COM', name: 'Alpha House', normalizedName: 'alpha house' },
    { platform: 'AGODA', name: 'KAS Zephyr Hotel', normalizedName: 'kas zephyr hotel' },
  ],
};

const BRANCHES = [DILLY, ELIANA, ZEPHYR];

const resolveBooking = (name: string | null) => resolveBranchIdentity(name, 'BOOKING_COM', BRANCHES);
const resolveAgoda = (name: string | null) => resolveBranchIdentity(name, 'AGODA', BRANCHES);

/* ================================================================== */
/* Precedence: the exact rungs still win                               */
/* ================================================================== */
describe('exact matching is unchanged and still takes precedence', () => {
  it('resolves on the platform identity', () => {
    const r = resolveBooking('Kas Dilly Hotel');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('EXACT_PLATFORM_IDENTITY');
    expect(r.requiresManualBranch).toBe(false);
  });

  it('resolves on the internal name', () => {
    const r = resolveBooking('Modern Luxury Dilly Hotel');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('EXACT_INTERNAL_NAME');
  });

  it('ignores case, accents and punctuation as it always did', () => {
    expect(resolveBooking('KAS DILLY HOTEL').branchCode).toBe('LE_THANH_TON_191');
    expect(resolveBooking('  kas   dilly   hotel  ').branchCode).toBe('LE_THANH_TON_191');
  });
});

/* ================================================================== */
/* The new rungs                                                       */
/* ================================================================== */
describe('the relaxed ladder resolves the names that used to fail', () => {
  it('matches once the generic words are dropped', () => {
    // "Kas Dilly Hotel" configured; the mail says "KAS DILLY HOTEL & SPA".
    const r = resolveBooking('KAS DILLY HOTEL & SPA');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('NORMALIZED_NAME');
    expect(r.requiresManualBranch).toBe(false);
  });

  it('matches a bare name with the establishment noun missing', () => {
    const r = resolveBooking('KAS DILLY');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('NORMALIZED_NAME');
  });

  it('matches when the mail carries extra words around the configured name', () => {
    const r = resolveBooking('Kas Dilly Hotel Saigon District 1');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('NAME_CONTAINS');
  });

  it('matches a shortened form of the configured name (reverse containment)', () => {
    // Configured internal name is "Modern Luxury Dilly Hotel" -> key
    // "modern luxury dilly"; the mail says only "Luxury Dilly", which sits
    // inside it.
    const r = resolveBooking('Luxury Dilly');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('NAME_CONTAINS');
  });

  it('drops the establishment noun before comparing, not after', () => {
    // "Modern Luxury Dilly" becomes key-equal to the internal name once
    // "Hotel" is gone, so it resolves on the normalised rung rather than by
    // containment. Pinned because the rung that fires is the audit trail.
    expect(resolveBooking('Modern Luxury Dilly').reason).toBe('NORMALIZED_NAME');
  });

  it('uses an existing Admin alias without inventing one', () => {
    const r = resolveBooking('Eliana Riverside Residence & Spa');
    expect(r.branchCode).toBe('BUI_THI_XUAN_13');
    expect(r.requiresManualBranch).toBe(false);
  });

  it('reports which configured name won, so the decision is auditable', () => {
    expect(resolveBooking('KAS DILLY HOTEL & SPA').matchedIdentity).toBe('Kas Dilly Hotel');
  });
});

/* ================================================================== */
/* It still refuses to guess                                           */
/* ================================================================== */
describe('nothing is ever guessed', () => {
  it('leaves an unknown property unresolved', () => {
    const r = resolveBooking('Completely Different Hotel');
    expect(r.branchId).toBeNull();
    expect(r.reason).toBe('UNKNOWN');
    expect(r.requiresManualBranch).toBe(true);
  });

  it('is ambiguous when a name fits two branches', () => {
    // "Modern Luxury" is inside both internal names; neither may be chosen.
    const r = resolveBooking('Modern Luxury');
    expect(r.branchId).toBeNull();
    expect(r.reason).toBe('AMBIGUOUS');
    expect(r.requiresManualBranch).toBe(true);
  });

  it('does not fall through to a looser rung after an ambiguous one', () => {
    // A tie must stop the ladder. Continuing would resolve by whichever rung
    // happened to break the tie first, which is resolution by luck.
    const r = resolveBooking('Modern Luxury');
    expect(r.reason).toBe('AMBIGUOUS');
    expect(r.branchCode).toBeNull();
  });

  it('never resolves a partial word', () => {
    // "Dil" half-spells Dilly; that belongs in front of an operator.
    expect(resolveBooking('Kas Dil').branchId).toBeNull();
  });

  it('never resolves empty or punctuation-only input', () => {
    expect(resolveBooking(null).reason).toBe('NO_INPUT');
    expect(resolveBooking('   ').reason).toBe('NO_INPUT');
    expect(resolveBooking('!!!').reason).toBe('NO_INPUT');
  });

  it('never routes to an inactive branch', () => {
    const closed = [{ ...DILLY, active: false }, ELIANA];
    const r = resolveBranchIdentity('KAS DILLY HOTEL & SPA', 'BOOKING_COM', closed);
    expect(r.branchId).toBeNull();
  });
});

/* ================================================================== */
/* Agoda and CTrip are untouched                                       */
/* ================================================================== */
describe('other platforms keep exact-only resolution', () => {
  it('still resolves an exact Agoda name', () => {
    const r = resolveAgoda('KAS Dilly Hotel');
    expect(r.branchCode).toBe('LE_THANH_TON_191');
    expect(r.reason).toBe('EXACT_PLATFORM_IDENTITY');
  });

  it('does NOT relax an Agoda name — this is the wrong-hotel guard', () => {
    // The same string Booking.com now resolves must stay unresolved on Agoda.
    expect(resolveBooking('KAS DILLY HOTEL & SPA').branchId).not.toBeNull();
    const agoda = resolveAgoda('KAS DILLY HOTEL & SPA');
    expect(agoda.branchId).toBeNull();
    expect(agoda.reason).toBe('UNKNOWN');
  });

  it('does not let Agoda match by containment either', () => {
    expect(resolveAgoda('KAS Dilly Hotel Saigon District 1').branchId).toBeNull();
    expect(resolveAgoda('KAS Dilly').branchId).toBeNull();
  });

  it('leaves CTrip resolving on exact names only', () => {
    const ctrip = resolveBranchIdentity('KAS DILLY HOTEL & SPA', 'CTRIP', BRANCHES);
    expect(ctrip.branchId).toBeNull();
  });

  it('never reads another platform’s identity', () => {
    // ZEPHYR is reachable on Agoda as "KAS Zephyr Hotel" and on Booking.com
    // only as "Alpha House". A Booking.com mail naming the Agoda listing must
    // not resolve, or a per-platform name would leak across platforms.
    expect(resolveAgoda('KAS Zephyr Hotel').branchCode).toBe('TEST_ZEPHYR');
    expect(resolveBooking('KAS Zephyr').branchId).toBeNull();
    expect(resolveBooking('KAS Zephyr Hotel').branchId).toBeNull();
  });
});
