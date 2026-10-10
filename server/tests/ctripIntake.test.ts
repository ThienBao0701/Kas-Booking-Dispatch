/**
 * CTrip intake.
 *
 * SCOPE NOTE: the fixtures here document an ASSUMED CTrip layout — no real or
 * sanitized CTrip document existed in the repository when this was written (see
 * fixtures/ctrip/README.md). So these tests deliberately assert the properties
 * that do NOT depend on CTrip's exact grammar:
 *
 *   - the source is preserved as CTRIP everywhere downstream;
 *   - the hotel resolves against the branch's CURRENT CTRIP identity;
 *   - an unknown property name blocks automatic assignment;
 *   - missing critical fields are flagged and block dispatch.
 *
 * They do not assert a CTrip-specific field grammar, because none has been
 * written: guessing one from assumptions is how a parser silently mis-reads a
 * price or a date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { seedPlatformIdentities } from '../src/db/platformIdentitySeed';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import { CTRIP_PARSER_VERSION, normalizeCtripText, parseCtripBooking } from '../src/booking/ctrip';
import { resetAll, resetBookingData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, loginAgent } from './helpers/auth';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ctrip');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
const branchIdByCode = new Map<string, number>();

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  for (const b of BRANCHES) {
    const row = await testPrisma.branch.findUniqueOrThrow({ where: { code: b.code } });
    branchIdByCode.set(b.code, row.id);
  }
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetBookingData();
  await testPrisma.branchPlatformIdentity.deleteMany();
  await testPrisma.branchPlatformIdentityEvent.deleteMany();
  await seedPlatformIdentities(testPrisma);
});

afterAll(async () => testPrisma.$disconnect());

const extract = (name: string) =>
  adminAgent.post('/api/bookings/extract').send({ rawText: read(name), source: 'CTRIP' });

/* ================================================================== */
/* Noise removal                                                       */
/* ================================================================== */

describe('CTrip text normalisation', () => {
  it('removes site chrome and loyalty lines that could be read as data', () => {
    const cleaned = normalizeCtripText(read('01-complete-one-room.txt'));
    expect(cleaned).not.toMatch(/Trip Coins/);
    expect(cleaned).not.toMatch(/Terms and Conditions/);
    expect(cleaned).not.toMatch(/^\s*My Bookings\s*$/m);
    // …but never touches the booking data itself.
    expect(cleaned).toContain('KAS Passion Boutique Hotel');
    expect(cleaned).toContain('CT2026070001');
    expect(cleaned).toContain('1.560.000');
  });

  it('strips a struck-through "was" price so it cannot become the total', () => {
    const cleaned = normalizeCtripText('Tổng cộng: 900.000 VND (was VND 1.200.000)');
    expect(cleaned).toContain('900.000');
    expect(cleaned).not.toContain('1.200.000');
  });
});

/* ================================================================== */
/* 11. The source is CTRIP, everywhere                                 */
/* ================================================================== */

describe('CTrip is stored and returned as its own source', () => {
  it('11. extraction persists sourcePlatform=CTRIP and stamps the CTrip parser', async () => {
    const res = await extract('01-complete-one-room.txt');
    expect(res.status).toBe(201);
    expect(res.body.booking.sourcePlatform).toBe('CTRIP');

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id },
    });
    expect(stored.sourcePlatform).toBe('CTRIP');
    expect(stored.sourcePlatform).not.toBe('AGODA');
    expect(stored.parserVersion).toBe(CTRIP_PARSER_VERSION);
  });

  it('11b. the raw CTrip text is preserved verbatim for audit', async () => {
    const res = await extract('01-complete-one-room.txt');
    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id },
    });
    // The ORIGINAL text, not the noise-stripped copy the parser worked on.
    expect(stored.rawText).toBe(read('01-complete-one-room.txt'));
    expect(stored.rawText).toContain('Trip Coins');
  });

  it('11c. CTRIP survives into history and the branch filter', async () => {
    const res = await extract('01-complete-one-room.txt');
    const id = branchIdByCode.get('TRUONG_DINH_05')!;
    await testPrisma.booking.update({
      where: { id: res.body.booking.id },
      data: { status: 'NEW', branchId: id, sentAt: new Date('2026-09-01T02:00:00.000Z') },
    });

    const history = await adminAgent.get('/api/bookings/history').query({ branchId: id });
    expect(history.status).toBe(200);
    const row = history.body.bookings.find((b: { id: string }) => b.id === res.body.booking.id);
    expect(row.sourcePlatform).toBe('CTRIP');
  });

  it('11d. the intake API refuses a platform that has no parser', async () => {
    for (const source of ['TRIPADVISOR', 'TRAVELOKA', 'EXPEDIA']) {
      const res = await adminAgent
        .post('/api/bookings/extract')
        .send({ rawText: read('01-complete-one-room.txt'), source });
      expect(res.status, source).toBe(422);
    }
  });
});

/* ================================================================== */
/* 12. Recognition through OtaPlatform.CTRIP                           */
/* ================================================================== */

describe('CTrip hotel recognition', () => {
  it('resolves an exact current CTrip identity to its branch', async () => {
    const res = await extract('01-complete-one-room.txt');
    expect(res.body.suggestedBranch?.code).toBe('TRUONG_DINH_05');
    expect(res.body.branchConfident).toBe(true);
    expect(res.body.requiresManualConfirmation).toBe(false);

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id },
    });
    expect(stored.branchId).toBe(branchIdByCode.get('TRUONG_DINH_05'));
  });

  it('follows the CTrip identity after an Admin renames it — not Agoda', async () => {
    const id = branchIdByCode.get('TRUONG_DINH_05')!;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'KAS Passion On Ctrip Only' });

    // The old CTrip name no longer assigns…
    const stale = await extract('01-complete-one-room.txt');
    expect(stale.body.branchConfident).toBe(false);

    // …while Agoda, untouched, still recognises the original name.
    const configs = await loadBranchConfigs(testPrisma);
    const parsedAsAgoda = parseCtripBooking(read('01-complete-one-room.txt'), configs);
    expect(parsedAsAgoda.branchConfident).toBe(false);
    const agoda = await testPrisma.branchPlatformIdentity.findUniqueOrThrow({
      where: { branchId_platform: { branchId: id, platform: 'AGODA' } },
    });
    expect(agoda.name).toBe('KAS Passion Boutique Hotel');
  });

  it('12. an unknown property name blocks automatic assignment', async () => {
    const res = await extract('02-unknown-hotel.txt');
    expect(res.status).toBe(201);
    expect(res.body.branchConfident).toBe(false);
    expect(res.body.requiresManualConfirmation).toBe(true);
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('UNKNOWN_HOTEL');

    const stored = await testPrisma.booking.findUniqueOrThrow({
      where: { id: res.body.booking.id },
    });
    expect(stored.branchId).toBeNull();
  });

  it('12b. dispatch is refused until an Admin names the branch', async () => {
    const res = await extract('02-unknown-hotel.txt');
    const blocked = await adminAgent
      .post(`/api/admin/bookings/${res.body.booking.id}/send`)
      .send({});
    expect(blocked.status).toBe(422);
  });
});

/* ================================================================== */
/* 13. Critical validation blocks dispatch                             */
/* ================================================================== */

describe('CTrip validation', () => {
  it('13. missing critical fields are flagged and block dispatch', async () => {
    const res = await extract('03-missing-critical-fields.txt');
    expect(res.status).toBe(201);

    // The hotel IS recognised — it is the other fields that are absent.
    expect(res.body.suggestedBranch?.code).toBe('LE_THANH_TON_278');
    expect(res.body.parserQuality.missingCriticalFields.length).toBeGreaterThan(0);
    expect(res.body.parserQuality.requiresAdminReview).toBe(true);

    const branchId = branchIdByCode.get('LE_THANH_TON_278')!;
    const send = await adminAgent
      .post(`/api/admin/bookings/${res.body.booking.id}/send`)
      .send({ branchId });
    expect(send.status).toBe(422);
    expect(send.body.error.code).toBe('BOOKING_NOT_READY');
    // The operator is told exactly what is missing, not just that it failed.
    const codes = send.body.error.details.errors.map((e: { code: string }) => e.code);
    expect(codes).toContain('MISSING_BOOKING_CODE');
    expect(codes.some((c: string) => c.startsWith('MISSING_CHECK'))).toBe(true);
  });

  it('13b. a complete CTrip booking carries no missing-field errors', async () => {
    const res = await extract('01-complete-one-room.txt');
    expect(res.body.parserQuality.missingCriticalFields).toEqual([]);
  });
});
