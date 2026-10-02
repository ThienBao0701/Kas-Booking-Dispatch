/**
 * Branch fixtures for the pure parser suites.
 *
 * These mirror the seed and carry each branch's CURRENT Booking.com and Agoda
 * platform identities, because that is what a production database looks like
 * after `seedPlatformIdentities` runs. Attaching them here is what lets the
 * fixture suites keep asserting the strong outcome — an exact identity match
 * assigns the branch confidently — instead of relying on similarity, which is
 * no longer allowed to assign anything.
 *
 * Ids are deterministic 1..8 for readability ONLY. Nothing under test resolves
 * a branch by id: recognition keys off the identity name, the internal name, or
 * the stable code.
 */
import { BRANCHES } from '../../src/db/branches';
import { BOOKING_COM_IDENTITIES } from '../../src/db/platformIdentitySeed';
import { AGODA_HOTEL_NAMES } from '../../src/booking/branchMatcher';
import { normalizeText } from '../../src/booking/text';
import type { BranchIdentity, IdentityBranch } from '../../src/booking/identityResolver';

function identitiesFor(branchCode: string): BranchIdentity[] {
  const out: BranchIdentity[] = [];

  const booking = BOOKING_COM_IDENTITIES.find((b) => b.branchCode === branchCode);
  if (booking) {
    out.push({
      platform: 'BOOKING_COM',
      name: booking.name,
      normalizedName: normalizeText(booking.name),
    });
  }

  const agoda = AGODA_HOTEL_NAMES.find((a) => a.branchCode === branchCode);
  if (agoda) {
    out.push({ platform: 'AGODA', name: agoda.name, normalizedName: normalizeText(agoda.name) });
  }

  return out;
}

/** The eight seeded branches, each with its current platform identities. */
export const fixtureBranches: IdentityBranch[] = BRANCHES.map((b, i) => ({
  id: i + 1,
  code: b.code,
  hotelName: b.hotelName,
  address: b.address,
  identities: identitiesFor(b.code),
}));

/** Looks a fixture branch up by stable code — never by index or id. */
export function fixtureBranch(code: string): IdentityBranch {
  const found = fixtureBranches.find((b) => b.code === code);
  if (!found) throw new Error(`Unknown fixture branch code: ${code}`);
  return found;
}

/** The current Booking.com public name of a branch, by stable code. */
export function bookingComName(code: string): string {
  const found = BOOKING_COM_IDENTITIES.find((b) => b.branchCode === code);
  if (!found) throw new Error(`No Booking.com identity for: ${code}`);
  return found.name;
}
