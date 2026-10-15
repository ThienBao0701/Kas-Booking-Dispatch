/**
 * Per-platform OTA room mappings.
 *
 * Two things are being protected here.
 *
 * INDEPENDENCE: Agoda and CTrip room names are identical today, which makes a
 * shared row tempting. Sharing one would mean renaming a room on Agoda silently
 * changed what a CTrip booking resolves to, so the rows must be separate and
 * separately editable.
 *
 * CODE FIDELITY: the PMS code goes verbatim into the note a receptionist pastes
 * into the hotel system. The operator's mapping list used four codes this system
 * does not have (PREMIUM, PRE-DD, TWINT, STUDIO); the authoritative catalogue
 * uses LUXDEL, PRE_DD, TWIN and STU. These tests pin the repository's codes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedBranches } from '../src/db/seed';
import { seedOtaRoomMappings } from '../src/room/otaRoomMappingSeed';
import {
  BRANCH_OTA_ROOM_MAPPING_SEED,
  MAPPED_PLATFORMS,
  OTA_ROOM_MAPPING_COUNT,
} from '../src/room/otaRoomMappingCatalog';
import { CONFIRMED_PMS_CODES } from '../src/room/roomClassCatalog';
import {
  loadOtaRoomMappings,
  resolveOtaRoomCode,
  resolveOtaRoomCodeById,
} from '../src/room/otaRoomMappingResolver';
import { normalizeText } from '../src/booking/text';
import { resetAll, testPrisma } from './helpers/db';

const branchIdByCode = new Map<string, number>();

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  for (const seed of BRANCH_OTA_ROOM_MAPPING_SEED) {
    const row = await testPrisma.branch.findUniqueOrThrow({ where: { code: seed.branchCode } });
    branchIdByCode.set(seed.branchCode, row.id);
  }
});

beforeEach(async () => {
  // Restore the seeded mappings after any test that edited or deleted one.
  await testPrisma.branchOtaRoomMapping.deleteMany();
  await testPrisma.branchOtaRoomMappingEvent.deleteMany();
  await seedOtaRoomMappings(testPrisma);
});

afterAll(async () => testPrisma.$disconnect());

const mappingsFor = (branchCode: string, platform: 'AGODA' | 'CTRIP') =>
  loadOtaRoomMappings(branchIdByCode.get(branchCode)!, platform, testPrisma);

/* ================================================================== */
/* Seeded counts and code fidelity                                     */
/* ================================================================== */

describe('seeded mappings', () => {
  it('seeds every room for BOTH platforms, as independent rows', async () => {
    expect(MAPPED_PLATFORMS).toEqual(['AGODA', 'CTRIP']);

    for (const platform of MAPPED_PLATFORMS) {
      const count = await testPrisma.branchOtaRoomMapping.count({ where: { platform } });
      expect(count, platform).toBe(OTA_ROOM_MAPPING_COUNT);
    }
    // Nothing was seeded for a platform that has no mapping table.
    expect(
      await testPrisma.branchOtaRoomMapping.count({
        where: { platform: { in: ['BOOKING_COM', 'TRIPADVISOR', 'TRAVELOKA'] } },
      }),
    ).toBe(0);
  });

  it.each(BRANCH_OTA_ROOM_MAPPING_SEED.map((s) => [s.branchCode, s.rooms.length] as const))(
    '%s has its exact room count on both platforms',
    async (branchCode, expected) => {
      for (const platform of MAPPED_PLATFORMS) {
        const rows = await mappingsFor(branchCode, platform);
        expect(rows.length, `${branchCode} ${platform}`).toBe(expected);
      }
    },
  );

  it('uses only PMS codes that exist in the authoritative catalogue', async () => {
    const rows = await testPrisma.branchOtaRoomMapping.findMany({ select: { pmsCode: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(CONFIRMED_PMS_CODES as readonly string[]).toContain(row.pmsCode);
    }
  });

  it('resolves the four corrected codes to the repository values, not the draft strings', async () => {
    const cn2 = await mappingsFor('LY_TU_TRONG_260', 'AGODA');
    expect(resolveOtaRoomCode('Phòng Premium Có Giường Cỡ King Nhìn Ra Thành Phố', cn2).pmsCode).toBe('LUXDEL');
    expect(resolveOtaRoomCode('Phòng Premium 2 Giường Đơn Nhìn Ra Thành Phố', cn2).pmsCode).toBe('PRE_DD');

    const cn5 = await mappingsFor('LE_THANH_TON_278', 'AGODA');
    expect(resolveOtaRoomCode('Phòng Twin Superior Có Cửa Sổ', cn5).pmsCode).toBe('TWIN');
    expect(resolveOtaRoomCode('Căn Hộ Studio', cn5).pmsCode).toBe('STU');

    // The draft strings are not codes anywhere in the system.
    const all = await testPrisma.branchOtaRoomMapping.findMany({ select: { pmsCode: true } });
    const codes = new Set(all.map((r) => r.pmsCode));
    for (const draft of ['PREMIUM', 'PRE-DD', 'TWINT', 'STUDIO']) {
      expect(codes.has(draft), draft).toBe(false);
    }
  });

  it('records Agoda room-type ids and leaves CTrip ids null', async () => {
    const agoda = await mappingsFor('TRUONG_DINH_05', 'AGODA');
    expect(agoda.find((m) => m.otaRoomName === 'Phòng Tiêu Chuẩn Không Có Cửa Sổ')?.otaRoomTypeId).toBe(
      '852778539',
    );

    // Each row carries exactly the id the catalogue states, and no other. The
    // official long names have Agoda's real identifiers; the short operator
    // aliases were supplied as text alone, so theirs stay null rather than
    // borrowing the id of a room they merely resemble.
    const seed = BRANCH_OTA_ROOM_MAPPING_SEED.find((s) => s.branchCode === 'TRUONG_DINH_05')!;
    for (const room of seed.rooms) {
      const row = agoda.find((m) => m.otaRoomName === room.otaRoomName);
      expect(row, room.otaRoomName).toBeDefined();
      expect(row!.otaRoomTypeId, room.otaRoomName).toBe(room.agodaRoomTypeId ?? null);
    }

    // No CTrip identifier has been supplied, so none is invented or borrowed.
    const ctrip = await mappingsFor('TRUONG_DINH_05', 'CTRIP');
    expect(ctrip.every((m) => m.otaRoomTypeId === null)).toBe(true);
    const anyCtripId = await testPrisma.branchOtaRoomMapping.count({
      where: { platform: 'CTRIP', otaRoomTypeId: { not: null } },
    });
    expect(anyCtripId).toBe(0);
  });

  it('is idempotent: re-running creates nothing and duplicates no audit event', async () => {
    const before = await testPrisma.branchOtaRoomMapping.count();
    const eventsBefore = await testPrisma.branchOtaRoomMappingEvent.count();

    const report = await seedOtaRoomMappings(testPrisma);
    expect(Object.values(report.created).every((n) => n === 0)).toBe(true);
    expect(report.skipped).toBeGreaterThan(0);
    expect(report.unknownPmsCodes).toEqual([]);
    expect(report.branchesMissing).toEqual([]);

    expect(await testPrisma.branchOtaRoomMapping.count()).toBe(before);
    expect(await testPrisma.branchOtaRoomMappingEvent.count()).toBe(eventsBefore);
  });
});

/* ================================================================== */
/* Independence                                                        */
/* ================================================================== */

describe('Agoda and CTrip mappings are independent', () => {
  const branchCode = 'BUI_THI_XUAN_40';
  const roomName = 'Phòng Deluxe Có Cửa Sổ (Giường Queen)';

  it('start identical but are separate rows', async () => {
    const agoda = await mappingsFor(branchCode, 'AGODA');
    const ctrip = await mappingsFor(branchCode, 'CTRIP');
    expect(resolveOtaRoomCode(roomName, agoda).pmsCode).toBe('DEL');
    expect(resolveOtaRoomCode(roomName, ctrip).pmsCode).toBe('DEL');

    const rows = await testPrisma.branchOtaRoomMapping.findMany({
      where: { branchId: branchIdByCode.get(branchCode)!, normalizedOtaRoomName: { not: '' } },
    });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length); // no shared row
  });

  it('editing the Agoda mapping leaves CTrip untouched', async () => {
    const branchId = branchIdByCode.get(branchCode)!;
    await testPrisma.branchOtaRoomMapping.updateMany({
      where: { branchId, platform: 'AGODA', otaRoomName: roomName },
      data: { pmsCode: 'DELQUEEN' },
    });

    expect(resolveOtaRoomCode(roomName, await mappingsFor(branchCode, 'AGODA')).pmsCode).toBe('DELQUEEN');
    expect(resolveOtaRoomCode(roomName, await mappingsFor(branchCode, 'CTRIP')).pmsCode).toBe('DEL');
  });

  it('deleting the CTrip mapping leaves Agoda untouched', async () => {
    const branchId = branchIdByCode.get(branchCode)!;
    await testPrisma.branchOtaRoomMapping.deleteMany({
      where: { branchId, platform: 'CTRIP', otaRoomName: roomName },
    });

    expect(resolveOtaRoomCode(roomName, await mappingsFor(branchCode, 'CTRIP')).pmsCode).toBeNull();
    expect(resolveOtaRoomCode(roomName, await mappingsFor(branchCode, 'AGODA')).pmsCode).toBe('DEL');
  });
});

/* ================================================================== */
/* Branch specificity and unresolved mappings                          */
/* ================================================================== */

describe('resolution', () => {
  it('is branch-specific: the same OTA name means different codes per branch', async () => {
    const shared = 'Phòng Twin Superior Có Cửa Sổ';
    expect(resolveOtaRoomCode(shared, await mappingsFor('LE_THANH_TON_278', 'AGODA')).pmsCode).toBe('TWIN');
    expect(resolveOtaRoomCode(shared, await mappingsFor('BUI_THI_XUAN_40', 'AGODA')).pmsCode).toBe('DD');
  });

  it('folds case, accents and spacing but never meaning', async () => {
    const cn1 = await mappingsFor('TRUONG_DINH_05', 'AGODA');
    expect(resolveOtaRoomCode('  PHÒNG   TIÊU CHUẨN KHÔNG CÓ CỬA SỔ ', cn1).pmsCode).toBe('STAN');
    // A different room is still a different room.
    expect(resolveOtaRoomCode('Phòng Tiêu Chuẩn Có Cửa Sổ', cn1).pmsCode).toBeNull();
  });

  it('CN4 has no Standard mapping, so a Standard input stays unresolved', async () => {
    const cn4 = await mappingsFor('NGUYEN_THAI_BINH_170', 'AGODA');
    expect(cn4.some((m) => m.pmsCode === 'STAN')).toBe(false);

    for (const name of [
      'Phòng Tiêu Chuẩn Không Có Cửa Sổ',
      'Standard Room',
      'Phòng Tiêu Chuẩn Giường Đôi Không Có Cửa Sổ',
    ]) {
      const resolved = resolveOtaRoomCode(name, cn4);
      expect(resolved.pmsCode, name).toBeNull();
      expect(resolved.requiresManualMapping, name).toBe(true);
    }
  });

  it('an unmapped name is never guessed', async () => {
    const cn1 = await mappingsFor('TRUONG_DINH_05', 'AGODA');
    const resolved = resolveOtaRoomCode('Presidential Ocean Suite', cn1);
    expect(resolved.pmsCode).toBeNull();
    expect(resolved.requiresManualMapping).toBe(true);
  });

  it('resolves by Agoda room-type id, but never for CTrip (no ids supplied)', async () => {
    const agoda = await mappingsFor('TRUONG_DINH_05', 'AGODA');
    expect(resolveOtaRoomCodeById('852779721', agoda).pmsCode).toBe('SUP');
    expect(resolveOtaRoomCodeById('000000000', agoda).pmsCode).toBeNull();

    const ctrip = await mappingsFor('TRUONG_DINH_05', 'CTRIP');
    expect(resolveOtaRoomCodeById('852779721', ctrip).pmsCode).toBeNull();
  });
});

/* ================================================================== */
/* The shared Agoda/CTrip catalogue                                    */
/* ================================================================== */

/**
 * The operator confirmed that the room-name catalogue is IDENTICAL on Agoda and
 * CTrip for all eight branches. That is a statement about the names, not about
 * the storage: the rows stay independent so renaming a room on one platform
 * cannot move the other.
 */
describe('shared catalogue, independent rows', () => {
  it.each(BRANCH_OTA_ROOM_MAPPING_SEED.map((s) => [s.cnLabel, s.branchCode] as const))(
    '%s has a matching, independent CTrip row for every Agoda row',
    async (_label, branchCode) => {
      const agoda = await mappingsFor(branchCode, 'AGODA');
      const ctrip = await mappingsFor(branchCode, 'CTRIP');
      expect(agoda.length).toBeGreaterThan(0);
      expect(ctrip.length).toBe(agoda.length);

      for (const row of agoda) {
        const twin = ctrip.find((c) => c.normalizedOtaRoomName === row.normalizedOtaRoomName);
        expect(twin, `${branchCode} / ${row.otaRoomName}`).toBeDefined();
        // Same destination code…
        expect(twin!.pmsCode, row.otaRoomName).toBe(row.pmsCode);
      }
    },
  );

  it('stores the two platforms as separate rows with different ids', async () => {
    const branchId = branchIdByCode.get('LE_THANH_TON_278')!;
    const rows = await testPrisma.branchOtaRoomMapping.findMany({
      where: { branchId, normalizedOtaRoomName: normalizeText('Standard Double Room No Window') },
      select: { id: true, platform: true, pmsCode: true },
      orderBy: { platform: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform).sort()).toEqual(['AGODA', 'CTRIP']);
    // Same code, but genuinely two records — neither references the other.
    expect(rows[0]!.pmsCode).toBe(rows[1]!.pmsCode);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('editing one platform does not move the other', async () => {
    const branchId = branchIdByCode.get('LE_THANH_TON_278')!;
    const key = normalizeText('Standard Double Room No Window');
    await testPrisma.branchOtaRoomMapping.updateMany({
      where: { branchId, platform: 'AGODA', normalizedOtaRoomName: key },
      data: { pmsCode: 'SUP' },
    });

    const ctrip = await testPrisma.branchOtaRoomMapping.findFirstOrThrow({
      where: { branchId, platform: 'CTRIP', normalizedOtaRoomName: key },
    });
    expect(ctrip.pmsCode).toBe('STAN');
  });

  it('holds no duplicate active rows for a (branch, platform, name)', async () => {
    const rows = await testPrisma.branchOtaRoomMapping.findMany({
      where: { active: true },
      select: { branchId: true, platform: true, normalizedOtaRoomName: true },
    });
    const keys = rows.map((r) => `${r.branchId}:${r.platform}:${r.normalizedOtaRoomName}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves the confirmed operator aliases at their own branch', async () => {
    const cases = [
      ['TRUONG_DINH_05', 'Superior Room', 'SUP'],
      ['LY_TU_TRONG_260', 'Luxury Twin Room - 01', 'PRE_DD'],
      ['LY_TU_TRONG_260', 'Luxury Deluxe Room - 01', 'LUXDEL'],
      ['NGUYEN_THAI_BINH_170', 'Suite Balcony', 'SUITEBAL'],
      ['LE_THANH_TON_278', 'Standard Double Room No Window', 'STAN'],
      ['LE_THANH_TON_278', 'D-D Room', 'TWIN'],
      ['LE_THANH_TON_278', 'Studio Room', 'STU'],
      ['BUI_THI_XUAN_40', 'Deluxe Double Room with Window', 'DEL'],
      ['BUI_THI_XUAN_40', 'D-D Room', 'DD'],
      ['BUI_THI_XUAN_13', 'Superior Queen Room with City View', 'SUP'],
      ['LE_THANH_TON_191', 'Superior giường Queen', 'SUP'],
      ['LE_THANH_TON_191', 'Phòng Loại Sang', 'DEL'],
      ['LE_THANH_TON_191', 'King Balcony', 'KINGBAL'],
    ] as const;

    for (const [branchCode, name, expected] of cases) {
      for (const platform of MAPPED_PLATFORMS) {
        const mappings = await mappingsFor(branchCode, platform);
        expect(resolveOtaRoomCode(name, mappings).pmsCode, `${branchCode}/${platform}/${name}`).toBe(
          expected,
        );
      }
    }
  });

  it('does not leak an alias across branches', async () => {
    // "D-D Room" exists at CN5 and CN6 with DIFFERENT codes, and nowhere else.
    for (const platform of MAPPED_PLATFORMS) {
      expect(resolveOtaRoomCode('D-D Room', await mappingsFor('LE_THANH_TON_278', platform)).pmsCode).toBe('TWIN');
      expect(resolveOtaRoomCode('D-D Room', await mappingsFor('BUI_THI_XUAN_40', platform)).pmsCode).toBe('DD');
      expect(resolveOtaRoomCode('D-D Room', await mappingsFor('TRUONG_DINH_05', platform)).pmsCode).toBeNull();
      // Studio exists only at CN5.
      expect(resolveOtaRoomCode('Studio Room', await mappingsFor('BUI_THI_XUAN_40', platform)).pmsCode).toBeNull();
    }
  });

  it('gives CN4 no Standard alias on either platform', async () => {
    for (const platform of MAPPED_PLATFORMS) {
      const cn4 = await mappingsFor('NGUYEN_THAI_BINH_170', platform);
      expect(cn4.some((m) => m.pmsCode === 'STAN')).toBe(false);
      for (const name of ['Standard', 'Standard Room', 'Standard Double Room']) {
        expect(resolveOtaRoomCode(name, cn4).pmsCode, `${platform}/${name}`).toBeNull();
      }
    }
  });

  it('renames no historical room-class code', async () => {
    // Every code the aliases point at must already exist in the confirmed
    // catalogue — the supplied shorthand never introduces a new one.
    const used = new Set(BRANCH_OTA_ROOM_MAPPING_SEED.flatMap((b) => b.rooms.map((r) => r.pmsCode)));
    for (const code of used) {
      expect(CONFIRMED_PMS_CODES, code).toContain(code);
    }
    // The four codes the operator's list got wrong are still absent.
    for (const wrong of ['PREMIUM', 'PRE-DD', 'TWINT', 'STUDIO', 'DEQUEEN', 'LUX_DD']) {
      expect(used.has(wrong), wrong).toBe(false);
    }
  });

  it('records an audit event for every seeded row', async () => {
    const rows = await testPrisma.branchOtaRoomMapping.count();
    const events = await testPrisma.branchOtaRoomMappingEvent.count({
      where: { action: 'MAPPING_CREATED', reason: 'SEED' },
    });
    expect(events).toBe(rows);
  });
});
