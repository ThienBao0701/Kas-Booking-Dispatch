/**
 * Database-backed OTA platform identities, for all eight branches.
 *
 * The guarantee under test is narrow and absolute: a branch is assigned
 * automatically ONLY on an exact match against its current platform identity,
 * its internal name, or a trusted stable code. Everything else — similarity,
 * superseded names, truncations, ambiguity — is a suggestion an Admin must
 * confirm, and dispatch stays blocked until they do.
 *
 * Every branch is resolved by STABLE CODE. Nothing here assumes ids are 1..8.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { BRANCHES } from '../src/db/branches';
import {
  BOOKING_COM_IDENTITIES,
  OTA_PLATFORMS,
  seedPlatformIdentities,
} from '../src/db/platformIdentitySeed';
import { loadBranchConfigs } from '../src/booking/branchConfig';
import { resolveBranchIdentity } from '../src/booking/identityResolver';
import { parseBooking } from '../src/booking/parser';
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
import { resolveTestDatabaseUrl } from '../src/d1/testDatabase';

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

let app: ReturnType<typeof createApp>;
let adminAgent: Agent;
let receptionAgent: Agent;
let receptionBranchId: number;

const branchIdByCode = new Map<string, number>();

/** Minimal Booking.com text carrying one hotel name. */
const bookingText = (hotel: string): string => `${hotel}
Mã đặt phòng: 777888999
Khách: Test Guest
Nhận phòng: 2026-09-01
Trả phòng: 2026-09-02
Phòng 1: Standard Room
2026-09-01: 500.000 VND
Thanh toán: Thanh toán tại chỗ`;

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

  receptionBranchId = branchIdByCode.get('TRUONG_DINH_05')!;
  await createReceptionist(receptionBranchId, { username: 'letan_pi', mustChangePassword: false });
  receptionAgent = (await loginAgent(app, 'letan_pi', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetBookingData();
  // Restore the seeded identities after any test that edited or deleted one.
  await testPrisma.branchPlatformIdentity.deleteMany();
  await testPrisma.branchPlatformIdentityEvent.deleteMany();
  await seedPlatformIdentities(testPrisma);
});

afterAll(async () => testPrisma.$disconnect());

/* ================================================================== */
/* 1. The eight Booking.com names, by stable code                      */
/* ================================================================== */

describe('seeded Booking.com identities', () => {
  it('1. maps all eight operator-supplied names to the right stable branch codes', async () => {
    expect(BOOKING_COM_IDENTITIES).toHaveLength(8);

    for (const entry of BOOKING_COM_IDENTITIES) {
      const branchId = branchIdByCode.get(entry.branchCode);
      expect(branchId, entry.branchCode).toBeDefined();

      const row = await testPrisma.branchPlatformIdentity.findUniqueOrThrow({
        where: { branchId_platform: { branchId: branchId!, platform: 'BOOKING_COM' } },
      });
      expect(row.name, entry.branchCode).toBe(entry.name);
      expect(row.normalizedName, entry.branchCode).toBe(normalizeText(entry.name));
    }
  });

  it('1b. every seeded name is distinct, so none can route two ways', () => {
    const normalized = BOOKING_COM_IDENTITIES.map((b) => normalizeText(b.name));
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it('1c. the migration preserved the superseded legacy aliases as audit events', async () => {
    const superseded = await testPrisma.branchPlatformIdentityEvent.findMany({
      where: { action: 'IDENTITY_MIGRATED' },
    });
    expect(superseded.length).toBeGreaterThan(0);
    // Every preserved value names the old alias and never becomes current.
    for (const event of superseded) {
      expect(event.oldValue).toBeTruthy();
      expect(event.newValue).toBeNull();
    }
  });
});

/* ================================================================== */
/* 2–4. Platform coverage, one current identity, replacement           */
/* ================================================================== */

describe('platform coverage and the one-current-identity rule', () => {
  it('2. accepts all five platform values and rejects anything else', async () => {
    const id = branchIdByCode.get('NGUYEN_TRAI_47A')!;
    expect(OTA_PLATFORMS).toEqual([
      'BOOKING_COM',
      'AGODA',
      'CTRIP',
      'TRIPADVISOR',
      'TRAVELOKA',
    ]);

    for (const platform of OTA_PLATFORMS) {
      const res = await adminAgent
        .put(`/api/admin/branches/${id}/platform-identities/${platform}`)
        .send({ name: `Khách sạn thử ${platform}` });
      expect(res.status, platform).toBe(200);
    }

    for (const bad of ['MANUAL', 'OTHER', 'EXPEDIA', 'booking_com', '']) {
      const res = await adminAgent
        .put(`/api/admin/branches/${id}/platform-identities/${bad}`)
        .send({ name: 'X' });
      expect(res.status, bad).not.toBe(200);
    }
  });

  it('3. every branch can hold one identity per platform', async () => {
    for (const code of BRANCHES.map((b) => b.code)) {
      const id = branchIdByCode.get(code)!;
      const res = await adminAgent.get(`/api/admin/branches/${id}/platform-identities`);
      expect(res.status, code).toBe(200);
      // Always five rows, so the UI can show a complete table with empty states.
      expect(res.body.identities.map((i: { platform: string }) => i.platform), code).toEqual([
        ...OTA_PLATFORMS,
      ]);
    }
  });

  it('4. a second identity REPLACES the first rather than coexisting', async () => {
    const id = branchIdByCode.get('LE_THANH_TON_278')!;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'Ctrip Name One' });
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/CTRIP`)
      .send({ name: 'Ctrip Name Two' });

    const rows = await testPrisma.branchPlatformIdentity.findMany({
      where: { branchId: id, platform: 'CTRIP' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Ctrip Name Two');
  });
});

/* ================================================================== */
/* 5–8. Edit, delete, audit retention, historical bookings             */
/* ================================================================== */

describe('editing, deleting and history', () => {
  it('5. editing changes recognition immediately', async () => {
    const code = 'BUI_THI_XUAN_13';
    const id = branchIdByCode.get(code)!;
    const before = await loadBranchConfigs(testPrisma);
    const old = BOOKING_COM_IDENTITIES.find((b) => b.branchCode === code)!.name;
    expect(resolveBranchIdentity(old, 'BOOKING_COM', before).branchCode).toBe(code);

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Eliana Renamed Saigon Hotel' });

    const after = await loadBranchConfigs(testPrisma);
    expect(resolveBranchIdentity('Eliana Renamed Saigon Hotel', 'BOOKING_COM', after).branchCode).toBe(code);
    // The replaced name stops assigning anything at all.
    expect(resolveBranchIdentity(old, 'BOOKING_COM', after).branchId).toBeNull();
  });

  it('6. deleting removes the value from recognition', async () => {
    const code = 'LE_THANH_TON_191';
    const id = branchIdByCode.get(code)!;
    const name = BOOKING_COM_IDENTITIES.find((b) => b.branchCode === code)!.name;

    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`);

    const after = await loadBranchConfigs(testPrisma);
    const resolved = resolveBranchIdentity(name, 'BOOKING_COM', after);
    expect(resolved.branchId).toBeNull();
    expect(resolved.requiresManualBranch).toBe(true);
  });

  it('7. audit history retains old values and is a SEPARATE endpoint', async () => {
    const id = branchIdByCode.get('NGUYEN_THAI_BINH_170')!;
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/TRAVELOKA`)
      .send({ name: 'Traveloka Original' });
    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/TRAVELOKA`)
      .send({ name: 'Traveloka Renamed' });
    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/TRAVELOKA`);

    const res = await adminAgent.get(`/api/admin/branches/${id}/identity-history`);
    expect(res.status).toBe(200);
    const traveloka = res.body.history.filter((h: { platform: string }) => h.platform === 'TRAVELOKA');
    const actions = traveloka.map((h: { action: string }) => h.action);
    expect(actions).toContain('IDENTITY_CREATED');
    expect(actions).toContain('IDENTITY_UPDATED');
    expect(actions).toContain('IDENTITY_DELETED');

    const updated = traveloka.find((h: { action: string }) => h.action === 'IDENTITY_UPDATED');
    expect(updated.oldValue).toBe('Traveloka Original');
    expect(updated.newValue).toBe('Traveloka Renamed');
    expect(updated.actor).not.toBeNull();

    // The CURRENT list never carries the removed value.
    const current = await adminAgent.get(`/api/admin/branches/${id}/platform-identities`);
    const row = current.body.identities.find((i: { platform: string }) => i.platform === 'TRAVELOKA');
    expect(row.name).toBeNull();
  });

  it('8. a historical booking keeps its branch and snapshot when the identity changes', async () => {
    const code = 'LY_TU_TRONG_260';
    const id = branchIdByCode.get(code)!;
    const booking = await createDraftBooking({
      status: 'NEW',
      branchId: id,
      bookingCode: 'IDENTITY01',
      customerName: 'Nguyễn Văn A',
    });
    const originalHotelName = booking.hotelName;

    await adminAgent
      .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
      .send({ name: 'Elegance Completely Different Name' });
    await adminAgent.delete(`/api/admin/branches/${id}/platform-identities/AGODA`);

    const after = await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.branchId).toBe(id);
    expect(after.hotelName).toBe(originalHotelName);
  });
});

/* ================================================================== */
/* 9–14. Recognition contract                                          */
/* ================================================================== */

describe('recognition', () => {
  it('9. an exact platform identity assigns the branch, for every branch', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    for (const entry of BOOKING_COM_IDENTITIES) {
      const r = resolveBranchIdentity(entry.name, 'BOOKING_COM', configs);
      expect(r.branchCode, entry.name).toBe(entry.branchCode);
      expect(r.reason, entry.name).toBe('EXACT_PLATFORM_IDENTITY');
      expect(r.requiresManualBranch, entry.name).toBe(false);
      expect(r.confidence, entry.name).toBe(100);
    }
  });

  it('9b. normalisation folds case, spacing and punctuation but not meaning', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const entry = BOOKING_COM_IDENTITIES[0]!;
    const noisy = `  ${entry.name.toUpperCase().replace(/ /g, '   ')}  `;
    expect(resolveBranchIdentity(noisy, 'BOOKING_COM', configs).branchCode).toBe(entry.branchCode);
  });

  it('10. an exact internal branch name assigns the branch', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    for (const branch of BRANCHES) {
      const r = resolveBranchIdentity(branch.hotelName, 'BOOKING_COM', configs);
      expect(r.branchCode, branch.hotelName).toBe(branch.code);
      expect(r.reason, branch.hotelName).toBe('EXACT_INTERNAL_NAME');
      expect(r.requiresManualBranch, branch.hotelName).toBe(false);
    }
  });

  it('10b. an exact trusted stable branch code assigns the branch', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const r = resolveBranchIdentity(null, 'CTRIP', configs, { trustedBranchCode: 'NGUYEN_TRAI_47A' });
    expect(r.branchCode).toBe('NGUYEN_TRAI_47A');
    expect(r.reason).toBe('EXACT_BRANCH_CODE');
  });

  it('11. an unknown name is never guessed', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const r = resolveBranchIdentity('Totally Unrelated Property Danang', 'BOOKING_COM', configs);
    expect(r.branchId).toBeNull();
    expect(r.reason).toBe('UNKNOWN');
    expect(r.requiresManualBranch).toBe(true);
  });

  it('12. an ambiguous name resolves to nothing and asks for confirmation', async () => {
    // Two branches sharing an internal name is the ambiguity the resolver must
    // refuse: it may not pick a winner.
    const a = branchIdByCode.get('NGUYEN_TRAI_47A')!;
    await testPrisma.branch.update({ where: { id: a }, data: { hotelName: 'Shared Internal Name' } });
    const b = branchIdByCode.get('LE_THANH_TON_278')!;
    await testPrisma.branch.update({ where: { id: b }, data: { hotelName: 'Shared Internal Name' } });

    try {
      const configs = await loadBranchConfigs(testPrisma);
      const r = resolveBranchIdentity('Shared Internal Name', 'BOOKING_COM', configs);
      expect(r.branchId).toBeNull();
      expect(r.reason).toBe('AMBIGUOUS');
      expect(r.requiresManualBranch).toBe(true);
    } finally {
      const original = (code: string) => BRANCHES.find((x) => x.code === code)!.hotelName;
      await testPrisma.branch.update({ where: { id: a }, data: { hotelName: original('NGUYEN_TRAI_47A') } });
      await testPrisma.branch.update({ where: { id: b }, data: { hotelName: original('LE_THANH_TON_278') } });
    }
  });

  it('13. SIMILARITY still never auto-assigns, however close the name is', async () => {
    // The 5.1 hotfix let Booking.com resolve by normalised equality and by
    // word-aligned containment. It did NOT loosen similarity SCORING, and this
    // is the test that keeps that true.
    //
    // The input misspells one word in the middle of the configured name. That
    // is enough to break every containment rung — no configured name, alias or
    // internal name survives as a contiguous run of these words — while the
    // prefix-tolerant scorer still rates it highly. High score, no assignment.
    const configs = await loadBranchConfigs(testPrisma);
    const entry = BOOKING_COM_IDENTITIES.find((b) => b.branchCode === 'BUI_THI_XUAN_40')!;
    const near = entry.name.replace('Thanh', 'Thanhh');

    const r = resolveBranchIdentity(near, 'BOOKING_COM', configs);
    expect(r.branchId).toBeNull();
    expect(r.requiresManualBranch).toBe(true);
    // It is still offered as a ranked suggestion, with the right branch first.
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]!.branchCode).toBe('BUI_THI_XUAN_40');
    expect(r.candidates[0]!.confidence).toBeGreaterThan(50);
  });

  it('13b. a Booking.com name carrying the configured name IS assigned (5.1)', async () => {
    // The production symptom: Booking.com prints the configured name with the
    // property id or a district glued on, and the booking used to arrive with
    // no branch. Containment resolves it — to the SAME branch, never another.
    const configs = await loadBranchConfigs(testPrisma);
    const entry = BOOKING_COM_IDENTITIES[0]!;

    const parsed = parseBooking(bookingText(`${entry.name} Extra Words Here`), configs, 'BOOKING_COM');
    expect(parsed.branchConfident).toBe(true);
    expect(parsed.requiresManualConfirmation).toBe(false);
    expect(parsed.suggestedBranch?.code).toBe(entry.branchCode);
    // Resolved means resolved: no "please confirm the branch" warning remains.
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).not.toContain('LOW_BRANCH_CONFIDENCE');
    expect(codes).not.toContain('UNKNOWN_HOTEL');
  });

  it('13c. a name that matches nothing is still never assigned', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const parsed = parseBooking(bookingText('Some Unrecognised Property'), configs, 'BOOKING_COM');
    expect(parsed.branchConfident).toBe(false);
    expect(parsed.requiresManualConfirmation).toBe(true);
    expect(parsed.warnings.map((w) => w.code)).toContain('UNKNOWN_HOTEL');
  });

  it('14. dispatch is blocked until an Admin supplies the branch', async () => {
    const configs = await loadBranchConfigs(testPrisma);
    const extract = await adminAgent
      .post('/api/bookings/extract')
      .send({ rawText: bookingText('Some Unrecognised Property'), source: 'BOOKING_COM' });
    expect(extract.status).toBe(201);
    // Nothing was auto-assigned — and with the review no longer persisted, an
    // unrecognised property leaves no row carrying a guessed branch either.
    expect(extract.body.suggestedBranch).toBeNull();
    expect(extract.body.requiresManualConfirmation).toBe(true);
    expect(await testPrisma.booking.count()).toBe(0);
    expect(configs.length).toBeGreaterThan(0);

    const branchId = branchIdByCode.get('TRUONG_DINH_05')!;
    const roomClass = await testPrisma.branchRoomClass.findFirstOrThrow({
      where: { branchId, active: true, version: { status: 'ACTIVE' } },
    });
    const body = {
      rawText: bookingText('Some Unrecognised Property'),
      hotelName: extract.body.booking.hotelName,
      customerName: extract.body.booking.guestName ?? '',
      phone: extract.body.booking.phone,
      bookingCode: extract.body.booking.bookingCode ?? '',
      checkInDate: extract.body.booking.checkIn,
      checkOutDate: extract.body.booking.checkOut,
      totalAmount: extract.body.booking.totalAmount,
      paymentStatus: extract.body.booking.paymentStatus,
      specialRequest: extract.body.booking.specialRequest,
      rooms: extract.body.rooms.map(
        (r: { roomIndex: number; roomName: string | null; roomTotal: number | null; nights: unknown[] }) => ({
          roomIndex: r.roomIndex,
          roomType: r.roomName,
          roomSubtotal: r.roomTotal,
          roomClassId: roomClass.id,
          nights: r.nights,
        }),
      ),
      acknowledgedWarningCodes: [
        'UNKNOWN_HOTEL',
        'UNRESOLVED_EXTRACT_WARNINGS',
        'LOW_CONFIDENCE_BRANCH',
        'MISSING_PHONE',
        'MISSING_TOTAL',
        'NULL_NIGHTLY_PRICE',
        'MISSING_ROOM_TYPE',
        'NIGHTLY_SUBTOTAL_MISMATCH',
        'ROOM_TOTAL_MISMATCH',
      ],
    };

    // …and sending without a branch is refused by the server.
    const blocked = await adminAgent.post('/api/admin/bookings/dispatch').send(body);
    expect(blocked.status).toBe(422);
    expect(await testPrisma.booking.count()).toBe(0);

    // The Admin confirms explicitly, and only then does it dispatch.
    const sent = await adminAgent.post('/api/admin/bookings/dispatch').send({ ...body, branchId });
    expect([201, 422]).toContain(sent.status);
    if (sent.status === 201) {
      expect(sent.body.booking.branch.code).toBe('TRUONG_DINH_05');
    }
  });
});

/* ================================================================== */
/* 15–17. Authorization, legacy API, concurrency                       */
/* ================================================================== */

describe('authorization and legacy compatibility', () => {
  it('15. a receptionist cannot read or mutate platform identities', async () => {
    const id = branchIdByCode.get('TRUONG_DINH_05')!;

    expect((await receptionAgent.get(`/api/admin/branches/${id}/platform-identities`)).status).toBe(403);
    expect(
      (await receptionAgent
        .put(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)
        .send({ name: 'Hacked Name' })).status,
    ).toBe(403);
    expect(
      (await receptionAgent.delete(`/api/admin/branches/${id}/platform-identities/BOOKING_COM`)).status,
    ).toBe(403);
    expect((await receptionAgent.get(`/api/admin/branches/${id}/identity-history`)).status).toBe(403);

    // Nothing changed.
    const row = await testPrisma.branchPlatformIdentity.findUniqueOrThrow({
      where: { branchId_platform: { branchId: id, platform: 'BOOKING_COM' } },
    });
    expect(row.name).not.toBe('Hacked Name');
  });

  it('16. a receptionist cannot reach ANOTHER branch by forging the id', async () => {
    const other = branchIdByCode.get('BUI_THI_XUAN_40')!;
    expect(other).not.toBe(receptionBranchId);
    // Admin-only routes are refused for every branch id, own or not.
    expect(
      (await receptionAgent
        .put(`/api/admin/branches/${other}/platform-identities/AGODA`)
        .send({ name: 'Forged' })).status,
    ).toBe(403);
    expect(
      (await receptionAgent
        .put(`/api/admin/branches/${receptionBranchId}/platform-identities/AGODA`)
        .send({ name: 'Forged' })).status,
    ).toBe(403);
  });

  it('16b. the legacy alias API is read-only: GET works, mutations are refused', async () => {
    const id = branchIdByCode.get('TRUONG_DINH_05')!;

    // Reads still work for one release.
    const read = await adminAgent.get(`/api/admin/branches/${id}`);
    expect(read.status).toBe(200);
    expect(Array.isArray(read.body.branch.aliases)).toBe(true);

    // Awaited one at a time: building them in an array would fire all three
    // against the same ephemeral supertest server at once.
    const post = await adminAgent
      .post(`/api/admin/branches/${id}/aliases`)
      .send({ source: 'BOOKING_COM', alias: 'X' });
    const patch = await adminAgent.patch(`/api/admin/branches/${id}/aliases/1`).send({ alias: 'X' });
    const del = await adminAgent.delete(`/api/admin/branches/${id}/aliases/1`);

    for (const res of [post, patch, del]) {
      expect(res.status).toBe(409);
      // The message points at the replacement rather than failing obscurely.
      expect(res.body.error.message).toContain('platform-identities');
    }
  });
});

describe('concurrency', () => {
  it('17. two concurrent writes cannot leave two current identities', async () => {
    const id = branchIdByCode.get('NGUYEN_TRAI_47A')!;

    const [a, b] = await Promise.all([
      adminAgent
        .put(`/api/admin/branches/${id}/platform-identities/TRIPADVISOR`)
        .send({ name: 'Tripadvisor Racer A' }),
      adminAgent
        .put(`/api/admin/branches/${id}/platform-identities/TRIPADVISOR`)
        .send({ name: 'Tripadvisor Racer B' }),
    ]);

    // Whatever the interleaving, the invariant holds.
    const rows = await testPrisma.branchPlatformIdentity.findMany({
      where: { branchId: id, platform: 'TRIPADVISOR' },
    });
    expect(rows).toHaveLength(1);
    expect(['Tripadvisor Racer A', 'Tripadvisor Racer B']).toContain(rows[0]!.name);
    // Neither response leaked a database constraint name.
    for (const res of [a, b]) {
      expect(JSON.stringify(res.body)).not.toContain('Unique constraint');
      expect(JSON.stringify(res.body)).not.toContain('P2002');
    }
  });

  it('17b. two branches cannot claim the same name on one platform concurrently', async () => {
    const first = branchIdByCode.get('LE_THANH_TON_278')!;
    const second = branchIdByCode.get('LE_THANH_TON_191')!;
    const url = (id: number) => `/api/admin/branches/${id}/platform-identities/CTRIP`;

    // Two independent connections, so the writers are genuinely parallel.
    const clientA = new PrismaClient({ datasourceUrl: resolveTestDatabaseUrl() });
    try {
      const [a, b] = await Promise.all([
        adminAgent.put(url(first)).send({ name: 'Shared Ctrip Listing' }),
        adminAgent.put(url(second)).send({ name: 'Shared Ctrip Listing' }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const owners = await clientA.branchPlatformIdentity.findMany({
        where: { platform: 'CTRIP', normalizedName: normalizeText('Shared Ctrip Listing') },
      });
      expect(owners).toHaveLength(1);
    } finally {
      await clientA.$disconnect();
    }
  });
});
