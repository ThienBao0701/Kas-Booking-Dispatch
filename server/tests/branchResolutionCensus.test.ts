/**
 * Which branch every Booking.com fixture resolves to.
 *
 * The 5.1 hotfix widened Booking.com resolution, and the only question that
 * really matters about such a change is whether any booking started going to a
 * DIFFERENT hotel. Flag-level assertions elsewhere ("is it confident?") cannot
 * answer that — they would stay green if a fixture confidently resolved to the
 * wrong branch.
 *
 * So this pins the branch itself, fixture by fixture. It was produced by
 * running the same census before and after the change and diffing: every
 * branch code was identical, and only three fixtures moved from "suggested" to
 * "assigned". If a future change to the resolver, the noise-word list or the
 * alias table sends any fixture somewhere new, this is what fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBooking } from '../src/booking/parser';
import { BRANCHES } from '../src/db/branches';
import { BRANCH_ALIASES } from '../src/booking/branchMatcher';
import { PLATFORM_IDENTITY_SEED } from '../src/db/platformIdentitySeed';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'booking');

/** The branch configuration as the seed defines it — no database needed. */
const CONFIGS = BRANCHES.map((b, i) => ({
  id: i + 1,
  code: b.code,
  hotelName: b.hotelName,
  address: b.address,
  active: true,
  aliases: (BRANCH_ALIASES[b.code] ?? []).map((alias) => ({
    source: 'BOOKING_COM' as const,
    alias,
    matchMode: 'SIMILARITY' as const,
  })),
  identities: PLATFORM_IDENTITY_SEED.filter(
    (p) => p.branchCode === b.code && p.platform === 'BOOKING_COM',
  ).map((p) => ({
    platform: 'BOOKING_COM' as const,
    name: p.name,
    normalizedName: p.name.toLowerCase(),
  })),
}));

/**
 * Fixture -> the branch it must resolve to.
 *
 * Recorded from the run BEFORE the hotfix, so every entry here is the answer
 * the system already gave in production.
 */
const EXPECTED_BRANCH: Record<string, string> = {
  '01-vi-one-room-one-night.txt': 'TRUONG_DINH_05',
  '02-vi-one-room-multi-night.txt': 'TRUONG_DINH_05',
  '03-vi-two-rooms-same-type.txt': 'LE_THANH_TON_278',
  '04-vi-two-rooms-diff-type.txt': 'NGUYEN_THAI_BINH_170',
  '05-en-labels.txt': 'BUI_THI_XUAN_13',
  '06-phone-hidden.txt': 'NGUYEN_TRAI_47A',
  '07-pay-before-trigger.txt': 'TRUONG_DINH_05',
  '08-pay-after-no-trigger.txt': 'LE_THANH_TON_191',
  '09-hotel-name-truncated.txt': 'LY_TU_TRONG_260',
  '10-duplicated-nav-policy.txt': 'BUI_THI_XUAN_40',
  '11-missing-one-nightly-price.txt': 'TRUONG_DINH_05',
  '12-nightly-and-total.txt': 'NGUYEN_THAI_BINH_170',
  '13-taxes-and-fees-separate.txt': 'BUI_THI_XUAN_13',
  '14-vietnamese-weekday-dates.txt': 'LE_THANH_TON_191',
  '15-booking-code-among-numbers.txt': 'NGUYEN_TRAI_47A',
  '16-qty-x2-per-room-prices.txt': 'TRUONG_DINH_05',
  '17-qty-2phong-combined-total.txt': 'NGUYEN_THAI_BINH_170',
  '18-qty-guest-count-not-rooms.txt': 'BUI_THI_XUAN_13',
  '19-vi-room-deluxe.txt': 'TRUONG_DINH_05',
  '20-vi-room-twin.txt': 'LE_THANH_TON_278',
  '21-vi-two-room-types.txt': 'NGUYEN_THAI_BINH_170',
  '22-vi-room-wrapped-text.txt': 'LE_THANH_TON_191',
  '23-qty-ambiguous-null-prices.txt': 'NGUYEN_TRAI_47A',
  '24-real-sample-extranet.txt': 'BUI_THI_XUAN_40',
  '25-real-sample-two-room-nightly.txt': 'TRUONG_DINH_05',
  '26-real-sample-three-rooms.txt': 'TRUONG_DINH_05',
  '27-real-sample-month-boundary.txt': 'TRUONG_DINH_05',
};

/**
 * The only fixtures the hotfix was allowed to change, and only by promoting
 * them from "suggested" to "assigned". Their branch is unchanged.
 */
const NEWLY_ASSIGNED = new Set([
  '25-real-sample-two-room-nightly.txt',
  '26-real-sample-three-rooms.txt',
  '27-real-sample-month-boundary.txt',
]);

function parse(file: string) {
  return parseBooking(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'), CONFIGS, 'BOOKING_COM');
}

describe('no Booking.com fixture changed branch', () => {
  it('resolves each recorded fixture to the branch it always resolved to', () => {
    for (const [file, code] of Object.entries(EXPECTED_BRANCH)) {
      expect(parse(file).suggestedBranch?.code, file).toBe(code);
    }
  });

  it('assigns the three extranet samples the hotfix was written for', () => {
    for (const file of NEWLY_ASSIGNED) {
      const r = parse(file);
      expect(r.branchConfident, file).toBe(true);
      expect(r.requiresManualConfirmation, file).toBe(false);
    }
  });

  it('still refuses to assign a truncated name', () => {
    // "09" is truncated mid-word. A fragment that half-spells a property must
    // reach an operator; widening the resolver did not change that.
    const r = parse('09-hotel-name-truncated.txt');
    expect(r.branchConfident).toBe(false);
    expect(r.requiresManualConfirmation).toBe(true);
  });

  it('never leaves a fixture with no branch at all', () => {
    const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt'));
    expect(files.length).toBeGreaterThanOrEqual(23);
    for (const file of files) {
      expect(parse(file).suggestedBranch, file).not.toBeNull();
    }
  });
});
