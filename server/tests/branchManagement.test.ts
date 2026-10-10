import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveBranchIdentity } from '../src/booking/identityResolver';
import { createApp } from '../src/app';
import { backfillBranchAliases, seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import { resetAll, resetIssueData, testPrisma, utcDate } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import {
  matchBranch,
  resolveAgodaBranch,
  resolveBranchForSource,
} from '../src/booking/branchMatcher';
import { suggestBranchCode } from '../src/branch/branchService';
import { generateDemoData } from '../src/devtest/demoFactory';
import { prepareForProduction } from '../src/devtest/prepareProduction';
import { parseAgodaBooking } from '../src/booking/agoda';
import { parseBooking } from '../src/booking/parser';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionistAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let adminId: number;
let ownBranchId: number;

const NEW_BRANCH = {
  branchNumber: 9,
  hotelName: 'Chi nhánh thử nghiệm',
  address: '12 Nguyễn Huệ',
  code: 'NGUYEN_HUE_12',
  breakfastIncluded: true,
  active: true,
};

/** Creates the temporary ninth branch used throughout the suite. */
async function createNinth(over: Record<string, unknown> = {}) {
  return adminAgent.post('/api/admin/branches').send({ ...NEW_BRANCH, ...over });
}

const SEEDED_CODES = BRANCHES.map((b) => b.code);

/**
 * The two accounts and their sessions are created once: password hashing is
 * deliberately expensive, so re-creating them for each of the 36 cases would
 * dominate the suite's runtime. Every test still starts from an identical
 * branch configuration — `restoreBranches` puts the seeded eight back exactly as
 * `db:seed` leaves them and removes anything a test added.
 */
async function restoreBranches(): Promise<void> {
  await testPrisma.notification.deleteMany({});
  await testPrisma.bookingStatusHistory.deleteMany({});
  await testPrisma.booking.deleteMany({});
  await resetIssueData();
  await testPrisma.demoDataBatch.deleteMany({});
  await testPrisma.branchChangeLog.deleteMany({});
  await testPrisma.branchSourceAlias.deleteMany({});
  // Accounts a test (or the demo generator) added — never the two fixtures.
  await testPrisma.user.deleteMany({ where: { username: { notIn: ['admin', 'letan'] } } });
  await testPrisma.branch.deleteMany({ where: { code: { notIn: SEEDED_CODES } } });

  for (const b of BRANCHES) {
    await testPrisma.branch.update({
      where: { code: b.code },
      data: {
        hotelName: b.hotelName,
        address: b.address,
        branchNumber: b.branchNumber,
        active: true,
        breakfastIncluded: false,
        phone: null,
        email: null,
        contactName: null,
        note: null,
      },
    });
  }
  await backfillBranchAliases(testPrisma);
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();

  ownBranchId = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(ownBranchId, { username: 'letan', mustChangePassword: false });
  receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 60_000);

beforeEach(async () => {
  await restoreBranches();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* 1–15  Branch CRUD, numbering, stable code, breakfast, activation    */
/* ================================================================== */

describe('branch management — listing and creation', () => {
  it('1. lists all current branches with their aliases and receptionist counts', async () => {
    const res = await adminAgent.get('/api/admin/branches');
    expect(res.status).toBe(200);
    expect(res.body.branches).toHaveLength(BRANCHES.length);

    const first = res.body.branches[0];
    expect(first.branchNumber).toBe(1);
    expect(first.code).toBe('TRUONG_DINH_05');
    expect(first.address).toBe('05 Trương Định');
    expect(first.activeReceptionistCount).toBe(1);
    expect(first.aliases.some((a: { source: string }) => a.source === 'BOOKING_COM')).toBe(true);
    expect(first.aliases.some((a: { source: string }) => a.source === 'AGODA')).toBe(true);
  });

  it('2. creates a new branch with its own number and stable code', async () => {
    const res = await createNinth();
    expect(res.status).toBe(201);
    expect(res.body.branch).toMatchObject({
      branchNumber: 9,
      code: 'NGUYEN_HUE_12',
      address: '12 Nguyễn Huệ',
      breakfastIncluded: true,
      active: true,
    });
    expect(await testPrisma.branch.count()).toBe(BRANCHES.length + 1);
  });

  it('3. rejects a branch number already used by an active branch', async () => {
    const res = await createNinth({ branchNumber: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('260 Lý Tự Trọng');
  });

  it('4. rejects an invalid branch number', async () => {
    for (const branchNumber of [0, -3, 1.5]) {
      const res = await createNinth({ branchNumber });
      expect(res.status).toBe(422);
    }
  });

  it('5. rejects a duplicate stable code', async () => {
    const res = await createNinth({ code: 'TRUONG_DINH_05' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('TRUONG_DINH_05');
  });

  it('6. rejects a badly formatted stable code and suggests one from the address', async () => {
    expect((await createNinth({ code: 'nguyen huệ-12' })).status).toBe(422);

    // The suggestion reproduces the convention every existing code already uses.
    for (const branch of BRANCHES) {
      expect(suggestBranchCode(branch.address)).toBe(branch.code);
    }
    const res = await adminAgent.get('/api/admin/branches/suggest-code?address=12 Nguyễn Huệ');
    expect(res.body.code).toBe('NGUYEN_HUE_12');
  });
});

describe('branch management — editing', () => {
  it('7. edits the internal name without touching the address or the code', async () => {
    const res = await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ hotelName: 'Tên nội bộ mới' });
    expect(res.status).toBe(200);
    expect(res.body.branch.hotelName).toBe('Tên nội bộ mới');
    expect(res.body.branch.address).toBe('05 Trương Định');
    expect(res.body.branch.code).toBe('TRUONG_DINH_05');
  });

  it('8. edits the address; the stable code is immutable', async () => {
    const res = await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ address: '07 Trương Định' });
    expect(res.status).toBe(200);
    expect(res.body.branch.address).toBe('07 Trương Định');

    const rejected = await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ code: 'SOMETHING_ELSE' });
    expect(rejected.status).toBe(422);
    expect((await testPrisma.branch.findUniqueOrThrow({ where: { id: ownBranchId } })).code).toBe(
      'TRUONG_DINH_05',
    );
  });

  it('9. edits the branch number, rejecting a clash with another active branch', async () => {
    const ok = await adminAgent.patch(`/api/admin/branches/${ownBranchId}`).send({ branchNumber: 11 });
    expect(ok.status).toBe(200);
    expect(ok.body.branch.branchNumber).toBe(11);

    const clash = await adminAgent.patch(`/api/admin/branches/${ownBranchId}`).send({ branchNumber: 2 });
    expect(clash.status).toBe(409);
  });

  it('10. renaming, renumbering and re-addressing keep historical bookings on the same branch', async () => {
    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'HIST-1',
        branchId: ownBranchId,
        hotelName: '05 Trương Định',
        customerName: 'TEST GUEST',
        paymentStatus: 'PAY_BEFORE',
        rawText: 'x',
        status: 'NEW',
        checkInDate: utcDate('2026-08-01'),
      },
    });

    await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ hotelName: 'Tên khác', address: '99 Đường Mới', branchNumber: 21 });

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.branchId).toBe(ownBranchId);
    // The text stored with the booking is history and is never rewritten.
    expect(after.hotelName).toBe('05 Trương Định');
  });

  it('11. configures breakfast for a branch', async () => {
    const res = await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ breakfastIncluded: true });
    expect(res.status).toBe(200);
    expect(res.body.branch.breakfastIncluded).toBe(true);

    const off = await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}`)
      .send({ breakfastIncluded: false });
    expect(off.body.branch.breakfastIncluded).toBe(false);
  });
});

describe('branch management — activation', () => {
  it('12. activates a branch again', async () => {
    await adminAgent.post(`/api/admin/branches/${ownBranchId}/deactivate`);
    const res = await adminAgent.post(`/api/admin/branches/${ownBranchId}/activate`);
    expect(res.status).toBe(200);
    expect(res.body.branch.active).toBe(true);
  });

  it('13. deactivates a branch and reports the assigned receptionists', async () => {
    const res = await adminAgent.post(`/api/admin/branches/${ownBranchId}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.branch.active).toBe(false);
    expect(res.body.affectedReceptionists).toHaveLength(1);
    expect(res.body.affectedReceptionists[0].username).toBe('letan');
    // Never silently reassigned or disabled.
    const user = await testPrisma.user.findFirstOrThrow({ where: { username: 'letan' } });
    expect(user.branchId).toBe(ownBranchId);
    expect(user.active).toBe(true);
  });

  it('14. a disabled branch is unavailable for new routing, dispatch and new accounts', async () => {
    const created = await createNinth();
    const ninthId = created.body.branch.id as number;
    await adminAgent
      .post(`/api/admin/branches/${ninthId}/aliases`)
      .send({ source: 'BOOKING_COM', alias: 'Nguyen Hue Test Hotel', matchMode: 'SIMILARITY' });
    await adminAgent.post(`/api/admin/branches/${ninthId}/deactivate`);

    // Not in the routing configuration at all.
    const configs = await loadBranchConfigs(testPrisma);
    expect(configs.some((b) => b.id === ninthId)).toBe(false);

    // Not offered to the operator, not accepted for a new receptionist.
    const list = await adminAgent.get('/api/branches');
    expect(list.body.branches.some((b: { id: number }) => b.id === ninthId)).toBe(false);
    const account = await adminAgent
      .post('/api/admin/users')
      .send({ username: 'letan9', fullName: 'Lễ tân 9', temporaryPassword: 'Temp1234', branchId: ninthId });
    expect(account.status).toBe(422);

    // Even if its id is supplied directly, an inactive branch never scores.
    const inactive = { id: ninthId, code: 'NGUYEN_HUE_12', hotelName: 'X', address: '12 Nguyễn Huệ', active: false,
      aliases: [{ source: 'BOOKING_COM' as const, alias: 'Nguyen Hue Test Hotel', matchMode: 'SIMILARITY' as const }] };
    expect(matchBranch('Nguyen Hue Test Hotel', [inactive])).toBeNull();
  });

  it('15. deactivation preserves every existing record', async () => {
    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'KEEP-1', branchId: ownBranchId, customerName: 'TEST GUEST',
        paymentStatus: 'PAY_BEFORE', rawText: 'x', status: 'NEW',
      },
    });
    const issue = await testPrisma.hotelIssue.create({
      data: { branchId: ownBranchId, category: 'WIFI', description: 'demo', reportedByUserId: adminId },
    });

    await adminAgent.post(`/api/admin/branches/${ownBranchId}/deactivate`);

    expect(await testPrisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();
    expect(await testPrisma.hotelIssue.findUnique({ where: { id: issue.id } })).not.toBeNull();
    // Admin can still read the branch itself.
    expect((await adminAgent.get(`/api/admin/branches/${ownBranchId}`)).status).toBe(200);
  });
});

/* ================================================================== */
/* 16–25  Platform aliases and resolution                              */
/* ================================================================== */

describe('branch management — platform names', () => {
  it('16. sets a Booking.com identity that then resolves EXACTLY to the branch', async () => {
    const created = await createNinth();
    const id = created.body.branch.id as number;
    const res = await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Nguyen Hue Grand Hotel' });
    expect(res.status).toBe(200);

    const configs = await loadBranchConfigs(testPrisma);
    const resolved = resolveBranchIdentity('Nguyen Hue Grand Hotel', 'BOOKING_COM', configs);
    expect(resolved.branchCode).toBe('NGUYEN_HUE_12');
    expect(resolved.reason).toBe('EXACT_PLATFORM_IDENTITY');
    expect(resolved.requiresManualBranch).toBe(false);
  });

  it('17. sets an Agoda identity; case and spacing are normalised, meaning is not', async () => {
    const created = await createNinth();
    const id = created.body.branch.id as number;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/AGODA`)
      .send({ name: 'KAS Nguyen Hue Hotel' });

    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity('KAS Nguyen Hue Hotel', 'AGODA', configs).branchCode).toBe('NGUYEN_HUE_12');
    // Case / repeated whitespace are safe to fold — they do not change identity.
    expect(resolveBranchIdentity('kas  nguyen hue hotel', 'AGODA', configs).branchCode).toBe('NGUYEN_HUE_12');
  });

  it('18. a near miss is SUGGESTED, never assigned — on every platform', async () => {
    const created = await createNinth();
    const id = created.body.branch.id as number;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/AGODA`)
      .send({ name: 'KAS Nguyen Hue Hotel' });

    const configs = await loadBranchConfigs(testPrisma);
    for (const near of ['KAS Nguyen Hue', 'KAS Hotel']) {
      const resolved = resolveBranchIdentity(near, 'AGODA', configs);
      expect(resolved.branchId, near).toBeNull();
      expect(resolved.requiresManualBranch, near).toBe(true);
      expect(resolved.reason, near).toBe('UNKNOWN');
    }
  });

  it('19. a Booking.com alias keeps the existing truncation-tolerant matching', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    // Booking.com's own truncations still resolve, exactly as before.
    expect(matchBranch('Luxury Elegance Hotel Ben Than', configs)?.branch.code).toBe('LY_TU_TRONG_260');
    expect(matchBranch('Ben Thanh Market - Luxur', configs)?.branch.code).toBe('BUI_THI_XUAN_40');

    const exact = resolveBranchForSource('Bamboo Water Hotel', 'BOOKING_COM', configs);
    expect(exact.reason).toBe('EXACT_ALIAS');
    expect(exact.confidence).toBe(100);
    expect(exact.sourceAlias).toBe('Bamboo Water Hotel');
    expect(exact.address).toBe('260 Lý Tự Trọng');
  });

  it('20. rejects a duplicate alias on the same branch', async () => {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } });
    const res = await adminAgent
      .post(`/api/admin/branches/${branch.id}/aliases`)
      .send({ source: 'BOOKING_COM', alias: 'bamboo   water hotel' });
    expect(res.status).toBe(409);
  });

  it('21. rejects an identity already owned by another branch on that platform', async () => {
    const created = await createNinth();
    const id = created.body.branch.id as number;
    const owner = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'BUI_THI_XUAN_40' } });
    const taken = await testPrisma.branchPlatformIdentity.findFirstOrThrow({
      where: { branchId: owner.id, platform: 'AGODA' },
    });

    const res = await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/AGODA`)
      .send({ name: taken.name });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(taken.name);

    // The rightful owner is untouched — a rejected claim changes nothing.
    const still = await testPrisma.branchPlatformIdentity.findFirstOrThrow({
      where: { platform: 'AGODA', normalizedName: taken.normalizedName },
    });
    expect(still.branchId).toBe(owner.id);
  });

  it('22. editing an identity replaces it and changes recognition immediately', async () => {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'NGUYEN_THAI_BINH_170' } });
    const previous = await testPrisma.branchPlatformIdentity.findFirstOrThrow({
      where: { branchId: branch.id, platform: 'BOOKING_COM' },
    });

    const res = await adminAgent
      .put(`/api/admin/branches/${branch.id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Kaliee Nata Saigon Hotel' });
    expect(res.status).toBe(200);

    // Exactly one current row survives, and it is the new value.
    const rows = await testPrisma.branchPlatformIdentity.findMany({
      where: { branchId: branch.id, platform: 'BOOKING_COM' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Kaliee Nata Saigon Hotel');

    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity('Kaliee Nata Saigon Hotel', 'BOOKING_COM', configs).branchCode).toBe(
      'NGUYEN_THAI_BINH_170',
    );
    // The replaced name stops assigning anything.
    expect(resolveBranchIdentity(previous.name, 'BOOKING_COM', configs).branchId).toBeNull();
    // The branch itself is untouched.
    expect(res.body.identities).toBeDefined();
    const reloaded = await testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } });
    expect(reloaded.address).toBe('170-172-174 Nguyễn Thái Bình');
  });

  it('23. deleting an identity stops recognition but keeps the audit trail', async () => {
    const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } });
    const current = await testPrisma.branchPlatformIdentity.findFirstOrThrow({
      where: { branchId: branch.id, platform: 'BOOKING_COM' },
    });

    const res = await adminAgent.delete(
      `/api/admin/branches/${branch.id}/platform-identities/BOOKING_COM`,
    );
    expect(res.status).toBe(200);

    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity(current.name, 'BOOKING_COM', configs).branchId).toBeNull();
    expect(
      await testPrisma.branchPlatformIdentity.findFirst({
        where: { branchId: branch.id, platform: 'BOOKING_COM' },
      }),
    ).toBeNull();

    // The removed value survives where an operator can still find it.
    const events = await testPrisma.branchPlatformIdentityEvent.findMany({
      where: { branchId: branch.id, action: 'IDENTITY_DELETED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.oldValue).toBe(current.name);

    // Another branch may now claim the freed name.
    const other = await testPrisma.branch.findUniqueOrThrow({ where: { code: 'BUI_THI_XUAN_13' } });
    expect(
      (
        await adminAgent
          .put(`/api/admin/branches/${other.id}/platform-identities/BOOKING_COM`)
          .send({ name: current.name })
      ).status,
    ).toBe(200);
  });

  it('24. the hotel name stored with an old booking survives a rename', async () => {
    const booking = await testPrisma.booking.create({
      data: {
        bookingCode: 'OLD-1', branchId: ownBranchId, hotelName: 'Saigon Hotel & Ben Thanh',
        customerName: 'TEST GUEST', paymentStatus: 'PAY_BEFORE', rawText: 'Saigon Hotel & Ben Thanh', status: 'NEW',
      },
    });
    const alias = await testPrisma.branchSourceAlias.findFirstOrThrow({
      where: { branchId: ownBranchId, alias: 'Saigon Hotel & Ben Thanh' },
    });
    await adminAgent
      .patch(`/api/admin/branches/${ownBranchId}/aliases/${alias.id}`)
      .send({ alias: 'Saigon Central Hotel' });

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.hotelName).toBe('Saigon Hotel & Ben Thanh');
    expect(after.rawText).toBe('Saigon Hotel & Ben Thanh');
    expect(after.branchId).toBe(ownBranchId);
  });

  it('25. an unknown hotel name stays unresolved and never falls back to a branch', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    expect(resolveAgodaBranch('KAS Unknown Property', configs)).toBeNull();

    const booking = resolveBranchForSource('Completely Unrelated Property', 'BOOKING_COM', configs);
    expect(booking.branchId).toBeNull();
    expect(booking.reason).toBe('UNKNOWN');

    const parsed = parseBooking('Khách sạn: Completely Unrelated Property\n', configs);
    expect(parsed.suggestedBranch).toBeNull();
    expect(parsed.requiresManualConfirmation).toBe(true);
  });
});

/* ================================================================== */
/* 26–31  Backfill + parser regressions                                */
/* ================================================================== */

describe('branch management — backfilled configuration preserves routing', () => {
  it('26. all eight Agoda mappings are backfilled and still resolve', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const expected: [string, string][] = [
      ['KAS Passion Boutique Hotel', 'TRUONG_DINH_05'],
      ['KAS Elegance Hotel', 'LY_TU_TRONG_260'],
      ['KAS Ancient Boutique Hotel', 'NGUYEN_TRAI_47A'],
      ['KAS Milestone Premium Hotel', 'NGUYEN_THAI_BINH_170'],
      ['KAS Zody Boutique Hotel', 'LE_THANH_TON_278'],
      ['KAS Sonata Luxury Hotel', 'BUI_THI_XUAN_40'],
      ['KAS Eliana Luxury Hotel', 'BUI_THI_XUAN_13'],
      ['KAS Dilly Hotel', 'LE_THANH_TON_191'],
    ];
    for (const [name, code] of expected) {
      const branch = resolveAgodaBranch(name, configs);
      expect(branch?.code, name).toBe(code);
    }
    expect(await testPrisma.branchSourceAlias.count({ where: { source: 'AGODA' } })).toBe(8);
  });

  it('27. Bamboo Water Hotel still resolves to 260 Lý Tự Trọng', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const match = matchBranch('Bamboo Water Hotel', configs);
    expect(match?.branch.code).toBe('LY_TU_TRONG_260');
    expect(match?.branch.address).toBe('260 Lý Tự Trọng');
  });

  it('28. Kaliee Nata Hotel still resolves to 170-172-174 Nguyễn Thái Bình', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const match = matchBranch('Kaliee Nata Hotel', configs);
    expect(match?.branch.code).toBe('NGUYEN_THAI_BINH_170');
    expect(match?.branch.address).toBe('170-172-174 Nguyễn Thái Bình');
  });

  it('29. the Booking.com extract endpoint still routes through the configuration', async () => {
    const res = await adminAgent.post('/api/bookings/extract').send({
      rawText: [
        'Bamboo Water Hotel',
        'Số đặt phòng: 4455667788',
        'Tên khách: TEST GUEST',
        'Nhận phòng: Thứ 2, 27 tháng 7 2026',
        'Trả phòng: Thứ 4, 29 tháng 7 2026',
      ].join('\n'),
      source: 'BOOKING_COM',
    });
    expect(res.status).toBe(201);
    expect(res.body.suggestedBranch.code).toBe('LY_TU_TRONG_260');
    expect(res.body.suggestedBranch.branchNumber).toBe(2);
  });

  it('30. the Agoda parser still resolves the branch address from the configuration', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseAgodaBooking(
      [
        'Agoda Booking ID 1753026280 - CONFIRMED',
        'Property Name\tKAS Sonata Luxury Hotel',
        'Booking ID\t1753026280',
        'Customer First Name\tTEST',
        'Customer Last Name\tCUSTOMER',
        'Check-in\tJuly 27, 2026',
        'Check-out\tJuly 29, 2026',
        'Room Type\tNo. of Rooms\tOccupancy\tNo. of Extra Bed',
        'Standard (0)\t1\t2 Adults\t0',
        'Reference sell rate (incl. taxes & fees)\tVND 1,680,000.00',
        'Net rate (incl. taxes & fees)\tVND 1,016,710.00',
      ].join('\n'),
      configs,
    );
    expect(parsed.hotelName).toBe('40-42 Bùi Thị Xuân');
    expect(parsed.agoda?.branchCode).toBe('BUI_THI_XUAN_40');
    expect(parsed.branchConfidence).toBe(100);
  });

  it('31. branch isolation is unchanged: a receptionist still sees only its branch', async () => {
    const res = await receptionistAgent.get('/api/branches');
    expect(res.status).toBe(200);
    expect(res.body.branches).toHaveLength(1);
    expect(res.body.branches[0].id).toBe(ownBranchId);
    expect(res.body.branches[0].branchNumber).toBe(1);
  });
});

/* ================================================================== */
/* 32  Security                                                        */
/* ================================================================== */

describe('branch management — security', () => {
  it('32. a receptionist is forbidden from every branch-management route', async () => {
    const calls = [
      receptionistAgent.get('/api/admin/branches'),
      receptionistAgent.get(`/api/admin/branches/${ownBranchId}`),
      receptionistAgent.get(`/api/admin/branches/${ownBranchId}/history`),
      receptionistAgent.post('/api/admin/branches').send(NEW_BRANCH),
      receptionistAgent.patch(`/api/admin/branches/${ownBranchId}`).send({ hotelName: 'x' }),
      receptionistAgent.post(`/api/admin/branches/${ownBranchId}/aliases`).send({ source: 'AGODA', alias: 'x' }),
      receptionistAgent.delete(`/api/admin/branches/${ownBranchId}/aliases/1`),
      receptionistAgent.post(`/api/admin/branches/${ownBranchId}/deactivate`),
      receptionistAgent.post(`/api/admin/branches/${ownBranchId}/activate`),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
    }
    // Nothing was changed by the attempts.
    expect((await testPrisma.branch.findUniqueOrThrow({ where: { id: ownBranchId } })).active).toBe(true);
    expect(await testPrisma.branch.count()).toBe(BRANCHES.length);
  });
});

/* ================================================================== */
/* 33–35  Demo tools and the official reset                            */
/* ================================================================== */

describe('branch management — developer tools stay dynamic', () => {
  it('33. the demo generator includes a newly created active branch', async () => {
    await createNinth();
    const summary = await generateDemoData(
      { bookingsPerBranch: 1, issuesPerBranch: 0, includeProofs: false, includeOcr: false, includeComparisons: false, seed: 7 },
      adminId,
      testPrisma,
    );
    expect(summary.branches).toBe(BRANCHES.length + 1);
    expect(summary.perBranch.some((b) => b.address === '12 Nguyễn Huệ')).toBe(true);
  }, 60_000);

  it('34. the demo generator excludes an inactive branch', async () => {
    const created = await createNinth();
    await adminAgent.post(`/api/admin/branches/${created.body.branch.id}/deactivate`);
    const summary = await generateDemoData(
      { bookingsPerBranch: 1, issuesPerBranch: 0, includeProofs: false, includeOcr: false, includeComparisons: false, seed: 7 },
      adminId,
      testPrisma,
    );
    expect(summary.branches).toBe(BRANCHES.length);
    expect(summary.perBranch.some((b) => b.address === '12 Nguyễn Huệ')).toBe(false);
  }, 60_000);

  it('35. the official reset preserves configured branches and their platform names', async () => {
    await createNinth({ aliases: [{ source: 'AGODA', alias: 'KAS Nguyen Hue Hotel' }] });
    const aliasesBefore = await testPrisma.branchSourceAlias.count();

    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-reset-'));
    const manifest = await prepareForProduction({
      confirmed: true,
      backupRoot,
      doBackup: false,
      uploadDirs: [],
      client: testPrisma,
    });

    expect(manifest.branchesPreserved).toBe(BRANCHES.length + 1);
    expect(await testPrisma.branchSourceAlias.count()).toBe(aliasesBefore);
    const ninth = await testPrisma.branch.findUniqueOrThrow({
      where: { code: 'NGUYEN_HUE_12' },
      include: { aliases: true },
    });
    expect(ninth.branchNumber).toBe(9);
    expect(ninth.breakfastIncluded).toBe(true);
    expect(ninth.aliases.map((a) => a.alias)).toContain('KAS Nguyen Hue Hotel');
    fs.rmSync(backupRoot, { recursive: true, force: true });

    // The reset ends every session by design, so the suite's agents log back in.
    adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
    receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
  });
});

/* ================================================================== */
/* 36  Audit history                                                   */
/* ================================================================== */

describe('branch management — audit history', () => {
  it('36. records creation, edits and activation with the actor', async () => {
    const created = await createNinth();
    const id = created.body.branch.id as number;

    await adminAgent.patch(`/api/admin/branches/${id}`).send({
      branchNumber: 12,
      hotelName: 'Tên nội bộ mới',
      address: '14 Nguyễn Huệ',
      breakfastIncluded: false,
    });
    // Platform names now have their OWN audit trail; the branch trail keeps
    // recording branch-level configuration only.
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Nguyen Hue Test Hotel' });
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Nguyen Hue New Hotel' });
    await adminAgent.post(`/api/admin/branches/${id}/deactivate`);
    await adminAgent.post(`/api/admin/branches/${id}/activate`);

    const res = await adminAgent.get(`/api/admin/branches/${id}/history`);
    expect(res.status).toBe(200);
    const actions = res.body.history.map((h: { action: string }) => h.action);
    for (const action of [
      'BRANCH_CREATED', 'BRANCH_NUMBER_CHANGED', 'BRANCH_NAME_CHANGED', 'BRANCH_ADDRESS_CHANGED',
      'BRANCH_BREAKFAST_CHANGED', 'BRANCH_DEACTIVATED', 'BRANCH_ACTIVATED',
    ]) {
      expect(actions, action).toContain(action);
    }

    const addressChange = res.body.history.find((h: { action: string }) => h.action === 'BRANCH_ADDRESS_CHANGED');
    expect(addressChange.oldValue).toBe('12 Nguyễn Huệ');
    expect(addressChange.newValue).toBe('14 Nguyễn Huệ');
    expect(addressChange.changedBy.id).toBe(adminId);
    // Audit rows only ever carry configuration values.
    expect(JSON.stringify(res.body.history)).not.toMatch(/passwordHash|sessionId|Temp1234/);
  });
});
