import { describe, expect, it } from 'vitest';
import { fixtureBranches } from './helpers/branchFixtures';
import { parseBooking } from '../src/booking/parser';
import { BRANCHES } from '../src/db/branches';

// Seeded branches WITH their current platform identities (see helper).
const branches = fixtureBranches;

interface MiniOpts {
  hotel?: string;
  phoneLine?: string | null;
  bookingCode?: string | null;
  nightAmount?: string; // the value after "2026-07-23:", "" for a missing price
}

/** A minimal but otherwise-complete single-room booking for scoring tests. */
function mini(opts: MiniOpts = {}): string {
  const lines = [opts.hotel ?? 'Saigon Hotel & Ben Thanh', 'Tên khách:', 'Nguyễn Văn A'];
  if (opts.phoneLine !== null) lines.push(opts.phoneLine ?? '+84 964 934 713');
  if (opts.bookingCode !== null) lines.push('Mã số đặt phòng:', opts.bookingCode ?? '1234567890');
  lines.push(
    'Nhận phòng',
    'Thứ Năm, 23 Tháng 7 2026',
    'Trả phòng',
    'Thứ Sáu, 24 Tháng 7 2026',
    'Phòng 1: Deluxe Double Room',
    `2026-07-23: ${opts.nightAmount ?? '850.000 VND'}`,
    'Tổng cộng: 850.000 VND',
  );
  return lines.join('\n');
}

describe('branch confidence (0–100 scale)', () => {
  it('is 100 for an exact hotel-name match', () => {
    const r = parseBooking(mini({ hotel: 'Saigon Hotel & Ben Thanh' }), branches);
    expect(r.branchConfidence).toBe(100);
    expect(r.branchConfident).toBe(true);
    expect(r.suggestedBranch?.address).toBe('05 Trương Định');
  });

  it('assigns a property-ID-suffixed hotel name to its branch (5.1)', () => {
    // The extranet glues the property id onto the name. This is THE production
    // symptom the 5.1 hotfix addresses: the name carries the configured
    // internal name as a whole word sequence, so containment resolves it — to
    // the branch the suggestion always pointed at, never a different one.
    const r = parseBooking(mini({ hotel: 'Saigon Hotel & Ben Thanh Market16806954' }), branches);
    expect(r.suggestedBranch?.code).toBe('TRUONG_DINH_05');
    expect(r.branchConfident).toBe(true);
    expect(r.requiresManualConfirmation).toBe(false);
    expect(r.branchConfidence).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.code)).not.toContain('LOW_BRANCH_CONFIDENCE');
    expect(r.hotelName).toBe('Saigon Hotel & Ben Thanh Market');
    expect(r.bookingCode).toBe('1234567890'); // property ID never used as booking code
  });

  it('is a partial score for a truncated hotel name (suggested, may need confirmation)', () => {
    const r = parseBooking(mini({ hotel: 'Boutique Hotel Ben Than' }), branches);
    expect(r.suggestedBranch).not.toBeNull();
    expect(r.branchConfidence).toBeGreaterThan(0);
    expect(r.branchConfidence).toBeLessThan(85);
    expect(r.branchConfident).toBe(false);
  });

  it('is 0 for an unknown hotel', () => {
    const r = parseBooking(mini({ hotel: 'Completely Unrelated Business XYZ' }), branches);
    expect(r.suggestedBranch).toBeNull();
    expect(r.branchConfidence).toBe(0);
  });
});

describe('eight-branch regression coverage', () => {
  for (const branch of BRANCHES) {
    it(`resolves "${branch.hotelName}" -> ${branch.address} confidently`, () => {
      const r = parseBooking(mini({ hotel: branch.hotelName }), branches);
      expect(r.suggestedBranch?.code).toBe(branch.code);
      expect(r.suggestedBranch?.address).toBe(branch.address);
      expect(r.branchConfidence).toBeGreaterThanOrEqual(85);
      expect(r.hotelName).toBe(branch.hotelName); // clean, no property ID
      expect(r.bookingCode).toBe('1234567890');
    });
  }
});

describe('phone extraction safety', () => {
  it('reads a Vietnamese +84 phone from the guest block', () => {
    expect(parseBooking(mini({ phoneLine: '+84 964 934 713' }), branches).phone).toBe('+84 964 934 713');
  });

  it('reads a 0-prefixed Vietnamese phone', () => {
    expect(parseBooking(mini({ phoneLine: '0905 112 233' }), branches).phone).toBe('0905 112 233');
  });

  it('reads a foreign international phone', () => {
    expect(parseBooking(mini({ phoneLine: '+64 210 812 1300' }), branches).phone).toBe('+64 210 812 1300');
  });

  it('is null for a hidden phone and raises no missing-phone warning', () => {
    const r = parseBooking(mini({ phoneLine: 'Không hiển thị' }), branches);
    expect(r.phone).toBeNull();
    expect(r.warnings.map((w) => w.code)).not.toContain('MISSING_PHONE');
  });

  it('never captures a hotel hotline as the guest phone', () => {
    const text = [
      'Saigon Hotel & Ben Thanh',
      'Tên khách:',
      'Nguyễn Văn A',
      'Mã số đặt phòng:',
      '1234567890',
      'Nhận phòng',
      'Thứ Năm, 23 Tháng 7 2026',
      'Trả phòng',
      'Thứ Sáu, 24 Tháng 7 2026',
      'Phòng 1: Deluxe Double Room',
      '2026-07-23: 850.000 VND',
      'Tổng cộng: 850.000 VND',
      'Hotline khách sạn',
      '+84 28 3822 9999',
    ].join('\n');
    const r = parseBooking(text, branches);
    expect(r.phone).toBeNull(); // no phone in the guest block; the hotline is ignored
    expect(r.phone ?? '').not.toContain('3822');
  });
});

describe('parser quality score', () => {
  it('is HIGH (>=90), no review, for a complete booking', () => {
    const q = parseBooking(mini(), branches).parserQuality;
    expect(q.level).toBe('HIGH');
    expect(q.score).toBeGreaterThanOrEqual(90);
    expect(q.requiresAdminReview).toBe(false);
    expect(q.missingCriticalFields).toEqual([]);
  });

  it('stays HIGH when only the optional phone is missing', () => {
    const q = parseBooking(mini({ phoneLine: null }), branches).parserQuality;
    expect(q.level).toBe('HIGH');
    expect(q.requiresAdminReview).toBe(false);
  });

  it('forces review and lists the missing critical field when the booking code is absent', () => {
    const q = parseBooking(mini({ bookingCode: null }), branches).parserQuality;
    expect(q.missingCriticalFields).toContain('bookingCode');
    expect(q.requiresAdminReview).toBe(true);
    expect(q.score).toBeLessThan(90);
  });

  it('lowers the score and forces review when a nightly price is missing', () => {
    const r = parseBooking(mini({ nightAmount: '' }), branches);
    expect(r.warnings.map((w) => w.code)).toContain('MISSING_NIGHTLY_PRICE');
    expect(r.parserQuality.score).toBeLessThan(90);
    expect(r.parserQuality.requiresAdminReview).toBe(true);
  });

  it('forces review when the branch needs manual confirmation', () => {
    const r = parseBooking(mini({ hotel: 'Boutique Hotel Ben Than' }), branches);
    expect(r.branchConfident).toBe(false);
    expect(r.requiresManualConfirmation).toBe(true);
    expect(r.parserQuality.requiresAdminReview).toBe(true);
  });
});
