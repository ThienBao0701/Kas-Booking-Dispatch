/**
 * Three-OTA identity completion: Booking.com, Agoda and CTrip for all eight
 * branches — 24 independent current identities.
 *
 * The property this file exists to pin is INDEPENDENCE. CTrip starts out
 * identical to Agoda because the properties are listed under the same names
 * today, which makes it very easy to accidentally implement one as an alias of
 * the other. Editing or deleting either must never touch the other, and a CTrip
 * booking must never be filed as Agoda.
 *
 * Every branch is resolved by STABLE CODE. Nothing assumes ids are 1..8.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import {
  OPERATIONAL_PLATFORMS,
  PLATFORM_IDENTITY_SEED,
  seedPlatformIdentities,
} from '../src/db/platformIdentitySeed';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import { resolveBranchIdentity } from '../src/booking/identityResolver';
import { normalizeText } from '../src/booking/text';
import { resetAll, resetBookingData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { createDraftBooking } from './helpers/bookings';

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

/**
 * The authoritative mapping, restated here INDEPENDENTLY of the seed module.
 * If the seed is edited by mistake, this table is what catches it — a test that
 * imported the same constant it verifies would prove nothing.
 */
const AUTHORITATIVE: ReadonlyArray<{
  branchCode: string;
  bookingCom: string;
  agoda: string;
  ctrip: string;
}> = [
  {
    branchCode: 'TRUONG_DINH_05',
    bookingCom: 'Market Ben Thanh Kas Hotel Passion',
    agoda: 'KAS Passion Boutique Hotel',
    ctrip: 'KAS Passion Boutique Hotel',
  },
  {
    branchCode: 'LY_TU_TRONG_260',
    bookingCom: 'Elegance Hotel - Ben Thanh Market - Central HCMC',
    agoda: 'KAS Elegance Hotel',
    ctrip: 'KAS Elegance Hotel',
  },
  {
    branchCode: 'NGUYEN_TRAI_47A',
    bookingCom: 'Boutique KAS Luxury Hotel',
    agoda: 'KAS Ancient Boutique Hotel',
    ctrip: 'KAS Ancient Boutique Hotel',
  },
  {
    branchCode: 'NGUYEN_THAI_BINH_170',
    bookingCom: 'Grand KAS Premium Hotel & Sky Bar',
    agoda: 'KAS Milestone Premium Hotel',
    ctrip: 'KAS Milestone Premium Hotel',
  },
  {
    branchCode: 'LE_THANH_TON_278',
    bookingCom: 'Zody KAS Hotel - Saigon Center',
    agoda: 'KAS Zody Boutique Hotel',
    ctrip: 'KAS Zody Boutique Hotel',
  },
  {
    branchCode: 'BUI_THI_XUAN_40',
    bookingCom: 'Ben Thanh Market - Luxury Kas Boutique Hotel - Thai Cuisine Restaurant',
    agoda: 'KAS Sonata Luxury Hotel',
    ctrip: 'KAS Sonata Luxury Hotel',
  },
  {
    branchCode: 'BUI_THI_XUAN_13',
    bookingCom: 'My Eliana Luxury Hotel Saigon Saigon & Spa',
    agoda: 'KAS Eliana Luxury Hotel',
    ctrip: 'KAS Eliana Luxury Hotel',
  },
  {
    branchCode: 'LE_THANH_TON_191',
    bookingCom: 'Ben Thanh Luxury Hotel - Premium Kas Dilly & Spa',
    agoda: 'KAS Dilly Hotel',
    ctrip: 'KAS Dilly Hotel',
  },
];

let app: ReturnType<typeof createApp>;
let adminAgent: Agent;
let receptionAgent: Agent;
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
  await createReceptionist(branchIdByCode.get('TRUONG_DINH_05')!, {
    username: 'letan_ota',
    mustChangePassword: false,
  });
  receptionAgent = (await loginAgent(app, 'letan_ota', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetBookingData();
  await testPrisma.branchPlatformIdentity.deleteMany();
  await testPrisma.branchPlatformIdentityEvent.deleteMany();
  await seedPlatformIdentities(testPrisma);
});

afterAll(async () => testPrisma.$disconnect());

/** The current identity of one branch on one platform, or null. */
async function identity(branchCode: string, platform: 'BOOKING_COM' | 'AGODA' | 'CTRIP') {
  return testPrisma.branchPlatformIdentity.findUnique({
    where: { branchId_platform: { branchId: branchIdByCode.get(branchCode)!, platform } },
  });
}

/* ================================================================== */
/* 1–4. The 24 rows                                                    */
/* ================================================================== */

describe('the 24 operational identities', () => {
  it('1. exactly 24 rows exist across the three operational platforms', async () => {
    expect(OPERATIONAL_PLATFORMS).toEqual(['BOOKING_COM', 'AGODA', 'CTRIP']);

    const rows = await testPrisma.branchPlatformIdentity.findMany({
      where: { platform: { in: [...OPERATIONAL_PLATFORMS] } },
    });
    expect(rows).toHaveLength(24);
    expect(BRANCHES).toHaveLength(8);

    // …and none for the platforms that have no intake yet.
    const future = await testPrisma.branchPlatformIdentity.findMany({
      where: { platform: { in: ['TRIPADVISOR', 'TRAVELOKA'] } },
    });
    expect(future).toHaveLength(0);
  });

  it('2. every name matches the authoritative mapping, verbatim', async () => {
    expect(AUTHORITATIVE).toHaveLength(8);
    for (const expected of AUTHORITATIVE) {
      const booking = await identity(expected.branchCode, 'BOOKING_COM');
      const agoda = await identity(expected.branchCode, 'AGODA');
      const ctrip = await identity(expected.branchCode, 'CTRIP');

      expect(booking?.name, expected.branchCode).toBe(expected.bookingCom);
      expect(agoda?.name, expected.branchCode).toBe(expected.agoda);
      expect(ctrip?.name, expected.branchCode).toBe(expected.ctrip);

      // Normalisation is stored alongside, so lookup never recomputes it.
      expect(ctrip?.normalizedName, expected.branchCode).toBe(normalizeText(expected.ctrip));
    }
  });

  it('2b. the seed module agrees with the authoritative mapping', () => {
    // Guards the seed constant itself against an accidental edit.
    expect(PLATFORM_IDENTITY_SEED).toHaveLength(24);
    for (const expected of AUTHORITATIVE) {
      const forBranch = PLATFORM_IDENTITY_SEED.filter((s) => s.branchCode === expected.branchCode);
      expect(forBranch.find((s) => s.platform === 'BOOKING_COM')?.name).toBe(expected.bookingCom);
      expect(forBranch.find((s) => s.platform === 'AGODA')?.name).toBe(expected.agoda);
      expect(forBranch.find((s) => s.platform === 'CTRIP')?.name).toBe(expected.ctrip);
    }
  });

  it('3. resolution is by stable code — ids are incidental and need not be 1..8', async () => {
    for (const expected of AUTHORITATIVE) {
      const branch = await testPrisma.branch.findUniqueOrThrow({
        where: { code: expected.branchCode },
      });
      const row = await identity(expected.branchCode, 'CTRIP');
      expect(row?.branchId).toBe(branch.id);
      expect(Number.isInteger(branch.id) && branch.id > 0).toBe(true);
    }
    // The seed itself never mentions a numeric id.
    expect(JSON.stringify(PLATFORM_IDENTITY_SEED)).not.toMatch(/"branchId"/);
  });

  it('4. re-running the seed creates no duplicates and changes nothing', async () => {
    const before = await testPrisma.branchPlatformIdentity.findMany({ orderBy: { id: 'asc' } });
    const eventsBefore = await testPrisma.branchPlatformIdentityEvent.count();

    const report = await seedPlatformIdentities(testPrisma);
    expect(report.seeded).toBe(0);
    expect(report.migrated).toBe(0);

    const after = await testPrisma.branchPlatformIdentity.findMany({ orderBy: { id: 'asc' } });
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => `${r.branchId}:${r.platform}:${r.name}`)).toEqual(
      before.map((r) => `${r.branchId}:${r.platform}:${r.name}`),
    );
    // Audit history is never rewritten by a re-run.
    expect(await testPrisma.branchPlatformIdentityEvent.count()).toBe(eventsBefore);
  });

  it('4b. an Admin edit survives a re-run of the seed', async () => {
    const code = 'LE_THANH_TON_191';
    const id = branchIdByCode.get(code)!;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'Dilly Renamed On Ctrip' });

    await seedPlatformIdentities(testPrisma);

    expect((await identity(code, 'CTRIP'))?.name).toBe('Dilly Renamed On Ctrip');
  });
});

/* ================================================================== */
/* 5–7. Independence of the three platforms                            */
/* ================================================================== */

describe('the three platforms are independent records', () => {
  const code = 'BUI_THI_XUAN_40';

  it('5. editing/deleting Booking.com leaves Agoda and CTrip untouched', async () => {
    const id = branchIdByCode.get(code)!;
    const agodaBefore = (await identity(code, 'AGODA'))!.name;
    const ctripBefore = (await identity(code, 'CTRIP'))!.name;

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Sonata Renamed On Booking' });
    expect((await identity(code, 'AGODA'))?.name).toBe(agodaBefore);
    expect((await identity(code, 'CTRIP'))?.name).toBe(ctripBefore);

    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`);
    expect(await identity(code, 'BOOKING_COM')).toBeNull();
    expect((await identity(code, 'AGODA'))?.name).toBe(agodaBefore);
    expect((await identity(code, 'CTRIP'))?.name).toBe(ctripBefore);
  });

  it('6. editing/deleting Agoda leaves CTrip untouched, though they start equal', async () => {
    const id = branchIdByCode.get(code)!;
    const ctripBefore = (await identity(code, 'CTRIP'))!.name;
    expect((await identity(code, 'AGODA'))!.name).toBe(ctripBefore); // identical to begin with

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/AGODA`)
      .send({ name: 'Sonata Renamed On Agoda' });
    expect((await identity(code, 'CTRIP'))?.name).toBe(ctripBefore);

    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/AGODA`);
    expect(await identity(code, 'AGODA')).toBeNull();
    expect((await identity(code, 'CTRIP'))?.name).toBe(ctripBefore);

    // CTrip still recognises its own name after Agoda was deleted entirely.
    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity(ctripBefore, 'CTRIP', configs).branchCode).toBe(code);
  });

  it('7. editing/deleting CTrip leaves Agoda untouched', async () => {
    const id = branchIdByCode.get(code)!;
    const agodaBefore = (await identity(code, 'AGODA'))!.name;

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'Sonata Renamed On Ctrip' });
    expect((await identity(code, 'AGODA'))?.name).toBe(agodaBefore);

    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/CTRIP`);
    expect(await identity(code, 'CTRIP')).toBeNull();
    expect((await identity(code, 'AGODA'))?.name).toBe(agodaBefore);

    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity(agodaBefore, 'AGODA', configs).branchCode).toBe(code);
  });

  it('7b. the same name on two platforms is allowed — uniqueness is per platform', async () => {
    // Agoda and CTrip legitimately share a name today. The (platform, name)
    // constraint must not read that as a collision.
    for (const expected of AUTHORITATIVE) {
      expect((await identity(expected.branchCode, 'AGODA'))!.name).toBe(
        (await identity(expected.branchCode, 'CTRIP'))!.name,
      );
    }
  });
});

/* ================================================================== */
/* 8–10. Recognition across all three platforms                        */
/* ================================================================== */

describe('recognition across the three operational platforms', () => {
  it('8. every branch is recognised by its exact current name on each platform', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    for (const expected of AUTHORITATIVE) {
      for (const [platform, name] of [
        ['BOOKING_COM', expected.bookingCom],
        ['AGODA', expected.agoda],
        ['CTRIP', expected.ctrip],
      ] as const) {
        const r = resolveBranchIdentity(name, platform, configs);
        expect(r.branchCode, `${platform} ${name}`).toBe(expected.branchCode);
        expect(r.reason, `${platform} ${name}`).toBe('EXACT_PLATFORM_IDENTITY');
        expect(r.requiresManualBranch, `${platform} ${name}`).toBe(false);
      }
    }
  });

  it('8b. a name is only exact on ITS platform, not on a sibling', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const branch1 = AUTHORITATIVE[0]!;
    // The Booking.com name is not the CTrip identity, so CTrip must not assign.
    const r = resolveBranchIdentity(branch1.bookingCom, 'CTRIP', configs);
    expect(r.reason).not.toBe('EXACT_PLATFORM_IDENTITY');
    expect(r.branchId).toBeNull();
  });

  it('9. a near-miss name never auto-assigns on AGODA or CTRIP', async () => {
    // These two keep exact-only resolution. Every Agoda/CTrip property here
    // shares the tokens "KAS" and "Hotel", so relaxed matching could rate two
    // different properties alike and send a guest to the wrong hotel. The 5.1
    // hotfix deliberately did not touch them.
    const configs = await loadBranchConfigs(testPrisma);
    for (const [platform, name] of [
      ['AGODA', 'KAS Passion Boutique'],
      ['CTRIP', 'KAS Passion Hotel'],
      ['AGODA', 'KAS Passion Boutique Hotel & Spa'],
      ['CTRIP', 'KAS Passion Boutique Hotel Saigon'],
    ] as const) {
      const r = resolveBranchIdentity(name, platform, configs);
      expect(r.branchId, `${platform} ${name}`).toBeNull();
      expect(r.requiresManualBranch, `${platform} ${name}`).toBe(true);
    }
  });

  it('9b. BOOKING_COM resolves a shortened form of its configured name (5.1)', async () => {
    // "Market Ben Thanh Kas Hotel" is the configured name minus "Passion".
    // Before the hotfix this reached an Admin for manual assignment; it now
    // resolves — to the same branch the suggestion always pointed at.
    const configs = await loadBranchConfigs(testPrisma);
    const r = resolveBranchIdentity('Market Ben Thanh Kas Hotel', 'BOOKING_COM', configs);
    expect(r.branchCode).toBe('TRUONG_DINH_05');
    expect(r.requiresManualBranch).toBe(false);
  });

  it('10. a historical booking is unchanged by identity edits and deletes', async () => {
    const code = 'NGUYEN_TRAI_47A';
    const id = branchIdByCode.get(code)!;
    const booking = await createDraftBooking({
      status: 'NEW',
      branchId: id,
      bookingCode: 'OTAHIST001',
      sourcePlatform: 'CTRIP',
    });

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'Something Else Entirely' });
    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/AGODA`);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.branchId).toBe(id);
    expect(after.hotelName).toBe(booking.hotelName);
    expect(after.sourcePlatform).toBe('CTRIP');
  });
});

/* ================================================================== */
/* 14. Authorization                                                   */
/* ================================================================== */

describe('authorization', () => {
  it('14. a receptionist cannot mutate any platform identity', async () => {
    const id = branchIdByCode.get('TRUONG_DINH_05')!;
    for (const platform of OPERATIONAL_PLATFORMS) {
      expect(
        (
          await receptionAgent
            .put(`/api/admin/branches/${id}/platform-identities/${platform}`)
            .send({ name: 'Hacked' })
        ).status,
        platform,
      ).toBe(403);
      expect(
        (await receptionAgent.delete(`/api/admin/branches/${id}/platform-identities/${platform}`))
          .status,
        platform,
      ).toBe(403);
    }

    // Nothing changed.
    for (const expected of AUTHORITATIVE.filter((a) => a.branchCode === 'TRUONG_DINH_05')) {
      expect((await identity(expected.branchCode, 'CTRIP'))?.name).toBe(expected.ctrip);
    }
  });
});
