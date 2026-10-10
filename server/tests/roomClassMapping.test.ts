import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import {
  BRANCH_ROOM_CLASS_SEED,
  CONFIRMED_PMS_CODES,
  CONFIRMED_ROOM_CLASS_COUNT,
} from '../src/room/roomClassCatalog';
import { seedBranchRoomClasses, findSeedAliasConflicts } from '../src/room/roomClassSeed';
import {
  loadActiveMapping,
  normalizePmsCode,
  normalizeRoomClassName,
  resolveRoomClass,
} from '../src/room/roomClassResolver';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionistAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];

/** CN label → stable branch code. The CN number is never the technical key. */
const CN: Record<string, string> = {
  CN1: 'TRUONG_DINH_05',
  CN2: 'LY_TU_TRONG_260',
  CN3: 'NGUYEN_TRAI_47A',
  CN4: 'NGUYEN_THAI_BINH_170',
  CN5: 'LE_THANH_TON_278',
  CN6: 'BUI_THI_XUAN_40',
  CN7: 'BUI_THI_XUAN_13',
  CN8: 'LE_THANH_TON_191',
};

async function branchIdOf(cn: string): Promise<number> {
  return (await testPrisma.branch.findUniqueOrThrow({ where: { code: CN[cn]! } })).id;
}

/** Resolves a room name against one branch's ACTIVE mapping. */
async function resolveIn(cn: string, roomName: string) {
  const branchId = await branchIdOf(cn);
  const mapping = await loadActiveMapping(branchId, testPrisma);
  return resolveRoomClass({ branchId, sourceRoomName: roomName }, mapping);
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  const branch1 = await branchIdOf('CN1');
  await createReceptionist(branch1, { username: 'letan', mustChangePassword: false });
  receptionistAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* A. Exact seed / mapping                                             */
/* ================================================================== */

describe('A. confirmed CN1–CN8 room-class mappings', () => {
  it('A1. seeds exactly 48 ACTIVE room classes, in the confirmed per-branch counts', async () => {
    const expectedCounts: Record<string, number> = {
      CN1: 3, CN2: 8, CN3: 4, CN4: 6, CN5: 6, CN6: 9, CN7: 6, CN8: 6,
    };

    let total = 0;
    for (const [cn, expected] of Object.entries(expectedCounts)) {
      const branchId = await branchIdOf(cn);
      const mapping = await loadActiveMapping(branchId, testPrisma);
      expect(mapping, cn).not.toBeNull();
      const active = mapping!.classes.filter((c) => c.active);
      expect(active.length, cn).toBe(expected);
      total += active.length;
    }

    expect(total).toBe(48);
    expect(CONFIRMED_ROOM_CLASS_COUNT).toBe(48);
    // Exactly one ACTIVE version per branch — never zero, never two.
    expect(await testPrisma.branchRoomMappingVersion.count({ where: { status: 'ACTIVE' } })).toBe(8);
  });

  it('A2. every confirmed display name and PMS code is exactly as specified', async () => {
    for (const seed of BRANCH_ROOM_CLASS_SEED) {
      const branch = await testPrisma.branch.findUniqueOrThrow({ where: { code: seed.branchCode } });
      const mapping = await loadActiveMapping(branch.id, testPrisma);
      for (const cls of seed.classes) {
        const found = mapping!.classes.find((c) => c.stableKey === cls.stableKey);
        expect(found, `${seed.cnLabel}/${cls.stableKey}`).toBeDefined();
        expect(found!.displayName, `${seed.cnLabel}/${cls.stableKey}`).toBe(cls.displayName);
        expect(found!.pmsCode, `${seed.cnLabel}/${cls.stableKey}`).toBe(cls.pmsCode);
      }
    }
  });

  it('A3. the catalogue contains no ambiguous alias within a branch', () => {
    expect(findSeedAliasConflicts()).toEqual([]);
  });

  it('A4. PMS codes are preserved verbatim by normalisation', () => {
    for (const code of CONFIRMED_PMS_CODES) {
      expect(normalizePmsCode(code), code).toBe(code);
    }
    // …and typed variants fold onto the canonical form.
    expect(normalizePmsCode('pre dd')).toBe('PRE_DD');
    expect(normalizePmsCode('pre-dd')).toBe('PRE_DD');
  });

  it('A5. the seed is idempotent and never disturbs an edited configuration', async () => {
    const before = await testPrisma.branchRoomClass.count();
    const versionsBefore = await testPrisma.branchRoomMappingVersion.count();

    const again = await seedBranchRoomClasses(testPrisma);

    expect(again.branchesSeeded).toEqual([]);
    expect(again.branchesSkipped).toHaveLength(8);
    expect(again.roomClassesCreated).toBe(0);
    expect(await testPrisma.branchRoomClass.count()).toBe(before);
    expect(await testPrisma.branchRoomMappingVersion.count()).toBe(versionsBefore);
  });
});

/* ================================================================== */
/* B. Branch isolation                                                 */
/* ================================================================== */

describe('B. branch isolation', () => {
  it('B1. the same name resolves to each branch\'s own class', async () => {
    const cn1 = await resolveIn('CN1', 'Standard');
    const cn2 = await resolveIn('CN2', 'Standard');
    expect(cn1.pmsCode).toBe('STAN');
    expect(cn2.pmsCode).toBe('STAN');
    // Same code, but genuinely different rows in different branches.
    expect(cn1.roomClassId).not.toBe(cn2.roomClassId);
    expect(cn1.branchId).not.toBe(cn2.branchId);
  });

  it('B2. a class that does not exist in a branch never resolves there', async () => {
    // CN1 has only Standard / Superior / FamilyTwin.
    for (const missing of ['Deluxe', 'Premium', 'King', 'Suite', 'D-D Room', 'Studio']) {
      const result = await resolveIn('CN1', missing);
      expect(result.status, missing).toBe('UNRESOLVED');
      expect(result.pmsCode, missing).toBeNull();
      // The source text is always preserved for manual review.
      expect(result.sourceText, missing).toBe(missing);
    }
  });

  it('B3. every confirmed branch-specific code resolves in its own branch only', async () => {
    const cases: [string, string, string][] = [
      ['CN8', 'King Bal', 'KINGBAL'],
      ['CN4', 'Deluxe1&2', 'DEL12'],
      ['CN4', 'Deluxe3&4', 'DEL34'],
      ['CN2', 'Pre-DD', 'PRE_DD'],
      ['CN2', 'Premium', 'LUXDEL'],
      ['CN6', 'DeluxeQueen', 'DELQUEEN'],
      ['CN5', 'Studio', 'STU'],
      ['CN1', 'FamilyTwin', 'DEFAM'],
    ];

    for (const [cn, name, code] of cases) {
      expect((await resolveIn(cn, name)).pmsCode, `${cn} ${name}`).toBe(code);
    }

    // …and the same names are unresolved in a branch that lacks them.
    expect((await resolveIn('CN7', 'King Bal')).status).toBe('UNRESOLVED');
    expect((await resolveIn('CN2', 'Deluxe1&2')).status).toBe('UNRESOLVED');
    expect((await resolveIn('CN6', 'Pre-DD')).status).toBe('UNRESOLVED');
    expect((await resolveIn('CN1', 'DeluxeQueen')).status).toBe('UNRESOLVED');
  });

  it('B4. a room-class id from another branch is refused, not honoured', async () => {
    const cn2Id = await branchIdOf('CN2');
    const cn1Id = await branchIdOf('CN1');
    const cn2Mapping = await loadActiveMapping(cn2Id, testPrisma);
    const premium = cn2Mapping!.classes.find((c) => c.stableKey === 'premium')!;

    // Ask CN1 to use CN2's Premium class explicitly.
    const cn1Mapping = await loadActiveMapping(cn1Id, testPrisma);
    const result = resolveRoomClass(
      { branchId: cn1Id, sourceRoomName: 'Premium', explicitRoomClassId: premium.id },
      cn1Mapping,
    );
    expect(result.status).toBe('UNRESOLVED');
    expect(result.pmsCode).toBeNull();
  });

  it('B5. an unknown name never falls back to Standard or to the first class', async () => {
    for (const cn of Object.keys(CN)) {
      const result = await resolveIn(cn, 'Phòng Tổng Thống Siêu VIP');
      expect(result.status, cn).toBe('UNRESOLVED');
      expect(result.pmsCode, cn).toBeNull();
      expect(result.roomClassId, cn).toBeNull();
    }
  });

  it('B6. a branch with no mapping resolves nothing rather than borrowing one', async () => {
    const created = await testPrisma.branch.create({
      data: { code: 'NO_MAPPING_1', hotelName: 'Chưa cấu hình', address: '1 Chưa Có', branchNumber: 91 },
    });
    const mapping = await loadActiveMapping(created.id, testPrisma);
    expect(mapping).toBeNull();
    expect(resolveRoomClass({ branchId: created.id, sourceRoomName: 'Standard' }, mapping).status)
      .toBe('UNRESOLVED');
    await testPrisma.branch.delete({ where: { id: created.id } });
  });
});

/* ================================================================== */
/* C. Aliases and normalisation                                        */
/* ================================================================== */

describe('C. aliases and normalisation', () => {
  it('C1. punctuation, spacing and case variants all resolve', async () => {
    const cases: [string, string[], string][] = [
      ['CN1', ['FamilyTwin', 'Family Twin', 'family-twin', 'FAMILYTWIN'], 'DEFAM'],
      ['CN2', ['D-D Room', 'D D Room', 'DD Room', 'D-D', 'dd'], 'DD'],
      ['CN2', ['Pre-DD', 'Pre DD', 'PRE_DD', 'predd'], 'PRE_DD'],
      ['CN2', ['De-Family', 'De Family', 'DEFAMILY'], 'DEFAM'],
      ['CN4', ['Deluxe1&2', 'Deluxe 1&2', 'Deluxe 1 & 2'], 'DEL12'],
      ['CN4', ['Deluxe3&4', 'Deluxe 3&4', 'Deluxe 3 & 4'], 'DEL34'],
      ['CN4', ['Deluxe D-D', 'Deluxe DD', 'Deluxe D D'], 'DD'],
      ['CN4', ['Deluxe-Bal', 'Deluxe Bal', 'Deluxe Balcony'], 'DEBAL'],
      ['CN4', ['Suite-Bal', 'Suite Bal', 'Suite Balcony'], 'SUITEBAL'],
      ['CN6', ['DeluxeQueen', 'Deluxe Queen'], 'DELQUEEN'],
      ['CN8', ['King Bal', 'King-Bal', 'King Balcony'], 'KINGBAL'],
    ];

    for (const [cn, variants, code] of cases) {
      for (const variant of variants) {
        expect((await resolveIn(cn, variant)).pmsCode, `${cn} "${variant}"`).toBe(code);
      }
    }
  });

  it('C2. "Superrior" and every case variant resolve to SUP', async () => {
    for (const cn of ['CN1', 'CN2', 'CN3', 'CN4', 'CN5', 'CN6', 'CN7', 'CN8']) {
      for (const spelling of ['Superior', 'Superrior', 'SUPERIOR', 'superior', 'superrior']) {
        expect((await resolveIn(cn, spelling)).pmsCode, `${cn} "${spelling}"`).toBe('SUP');
      }
    }
    // One canonical class per branch, not a duplicate for the misspelling.
    const cn1 = await loadActiveMapping(await branchIdOf('CN1'), testPrisma);
    expect(cn1!.classes.filter((c) => c.pmsCode === 'SUP')).toHaveLength(1);
    expect(cn1!.classes.find((c) => c.pmsCode === 'SUP')!.displayName).toBe('Superior');
  });

  it('C3. similar-but-different classes are NEVER folded together', async () => {
    // The whole reason matching is exact rather than fuzzy.
    expect((await resolveIn('CN6', 'Deluxe')).pmsCode).toBe('DEL');
    expect((await resolveIn('CN6', 'Deluxe-Bal')).pmsCode).toBe('DEBAL');
    expect((await resolveIn('CN8', 'King')).pmsCode).toBe('KING');
    expect((await resolveIn('CN8', 'King Bal')).pmsCode).toBe('KINGBAL');
    expect((await resolveIn('CN6', 'Family')).pmsCode).toBe('FAM');
    expect((await resolveIn('CN6', 'De-Family')).pmsCode).toBe('DEFAM');
    expect((await resolveIn('CN2', 'D-D Room')).pmsCode).toBe('DD');
    expect((await resolveIn('CN2', 'Pre-DD')).pmsCode).toBe('PRE_DD');
    expect((await resolveIn('CN4', 'Deluxe1&2')).pmsCode).toBe('DEL12');
    expect((await resolveIn('CN4', 'Deluxe3&4')).pmsCode).toBe('DEL34');
  });

  it('C4. the normaliser folds punctuation without merging distinct names', () => {
    expect(normalizeRoomClassName('Deluxe 1 & 2')).toBe(normalizeRoomClassName('Deluxe1&2'));
    expect(normalizeRoomClassName('De-Family')).toBe(normalizeRoomClassName('DE FAMILY'));
    // Distinct classes keep distinct keys.
    expect(normalizeRoomClassName('Deluxe')).not.toBe(normalizeRoomClassName('Deluxe-Bal'));
    expect(normalizeRoomClassName('King')).not.toBe(normalizeRoomClassName('King Bal'));
    expect(normalizeRoomClassName('Family')).not.toBe(normalizeRoomClassName('De-Family'));
    expect(normalizeRoomClassName('DD')).not.toBe(normalizeRoomClassName('Pre-DD'));
    expect(normalizeRoomClassName('Deluxe1&2')).not.toBe(normalizeRoomClassName('Deluxe3&4'));
  });

  it('C5. an empty or whitespace-only name is unresolved, never a default', async () => {
    for (const blank of ['', '   ', '\t']) {
      expect((await resolveIn('CN2', blank)).status).toBe('UNRESOLVED');
    }
  });
});

/* ================================================================== */
/* E. Draft workflow                                                   */
/* ================================================================== */

describe('E. draft and activation workflow', () => {
  let branchId: number;
  const base = () => `/api/admin/branches/${branchId}/room-mapping`;

  beforeEach(async () => {
    branchId = await branchIdOf('CN3');
    // Remove any leftover draft so each case starts from a clean CN3.
    await testPrisma.branchRoomMappingVersion.deleteMany({ where: { branchId, status: 'DRAFT' } });
  });

  it('E1. creating a draft copies the active mapping and leaves it untouched', async () => {
    const activeBefore = await loadActiveMapping(branchId, testPrisma);

    const res = await adminAgent.post(`${base()}/drafts`).send({ changeReason: 'Thêm hạng phòng mới' });
    expect(res.status).toBe(201);
    expect(res.body.draft.status).toBe('DRAFT');
    expect(res.body.draft.roomClasses).toHaveLength(4);

    // The live mapping is byte-for-byte the same, and still the only ACTIVE one.
    const activeAfter = await loadActiveMapping(branchId, testPrisma);
    expect(activeAfter!.versionId).toBe(activeBefore!.versionId);
    expect(activeAfter!.classes.map((c) => c.pmsCode)).toEqual(activeBefore!.classes.map((c) => c.pmsCode));
    expect(await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } })).toBe(1);
  });

  it('E2. editing a draft does not affect live resolution', async () => {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;
    const deluxe = draft.roomClasses.find((c: { pmsCode: string }) => c.pmsCode === 'DEL');

    await adminAgent
      .patch(`${base()}/drafts/${draft.id}/room-classes/${deluxe.id}`)
      .send({ pmsCode: 'DELUXE_NEW' });

    // Live resolution still returns the OLD code.
    expect((await resolveIn('CN3', 'Deluxe')).pmsCode).toBe('DEL');
  });

  it('E3. activation is atomic: old version archived, draft active, exactly one active', async () => {
    const activeBefore = await loadActiveMapping(branchId, testPrisma);
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;

    const added = await adminAgent
      .post(`${base()}/drafts/${draft.id}/room-classes`)
      .send({ displayName: 'Penthouse', pmsCode: 'PENT', aliases: ['Pent House'] });
    expect(added.status).toBe(201);

    const validation = await adminAgent.post(`${base()}/drafts/${draft.id}/validate`);
    expect(validation.body.ok).toBe(true);

    const activated = await adminAgent
      .post(`${base()}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: activeBefore!.versionId, changeReason: 'Thêm Penthouse' });
    expect(activated.status).toBe(200);
    expect(activated.body.added).toContain('Penthouse → PENT');

    expect(await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } })).toBe(1);
    const archived = await testPrisma.branchRoomMappingVersion.findUniqueOrThrow({
      where: { id: activeBefore!.versionId },
    });
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.archivedAt).not.toBeNull();

    // The new class resolves; the old ones still do too.
    expect((await resolveIn('CN3', 'Penthouse')).pmsCode).toBe('PENT');
    expect((await resolveIn('CN3', 'Pent House')).pmsCode).toBe('PENT');
    expect((await resolveIn('CN3', 'Standard')).pmsCode).toBe('STAN');
  });

  /*
    E3a-d. RENAMING A ROOM CLASS.

    `updateRoomClass` has always accepted `displayName`; what was missing was an
    input in the Admin modal, so a typo in a name could only be fixed by deleting
    the class and recreating it — which threw away its aliases. These pin the
    server half end to end: the rename persists, keeps the normalised form in
    step so lookups still match, and reaches live resolution once activated.
  */
  /** The draft's classes, picked by position so no case depends on another. */
  async function freshDraft(): Promise<{ id: string; classes: { id: string; displayName: string; pmsCode: string }[] }> {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;
    return { id: draft.id, classes: draft.roomClasses };
  }

  it('E3a. renaming a class in a draft persists the new name', async () => {
    const draft = await freshDraft();
    const target = draft.classes[0]!;

    const res = await adminAgent
      .patch(`${base()}/drafts/${draft.id}/room-classes/${target.id}`)
      .send({ displayName: 'Deluxe Đôi' });
    expect(res.status).toBe(200);

    const row = await testPrisma.branchRoomClass.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.displayName).toBe('Deluxe Đôi');
    // The normalised form follows, or the new name would not resolve.
    expect(row.normalizedName).toBe(normalizeRoomClassName('Deluxe Đôi'));
    // The code is untouched by a rename.
    expect(row.pmsCode).toBe(target.pmsCode);
  });

  it('E3b. the name and the PMS code can be changed together and both survive a reload', async () => {
    const draft = await freshDraft();
    const target = draft.classes[0]!;

    await adminAgent
      .patch(`${base()}/drafts/${draft.id}/room-classes/${target.id}`)
      .send({ displayName: 'Deluxe Plus', pmsCode: 'DLXP' });

    // Re-read through the API, as the modal does after saving.
    const reloaded = (await adminAgent.get(`${base()}/draft`)).body.draft;
    const updated = reloaded.roomClasses.find((c: { id: string }) => c.id === target.id);
    expect(updated.displayName).toBe('Deluxe Plus');
    expect(updated.pmsCode).toBe('DLXP');
  });

  it('E3c. a rename cannot collide with another class in the same draft', async () => {
    const draft = await freshDraft();
    const [first, second] = [draft.classes[0]!, draft.classes[1]!];

    const res = await adminAgent
      .patch(`${base()}/drafts/${draft.id}/room-classes/${first.id}`)
      .send({ displayName: second.displayName });
    expect(res.status).toBe(409);

    // Unchanged after the refusal.
    const row = await testPrisma.branchRoomClass.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.displayName).toBe(first.displayName);
  });

  it('E3d. a renamed class resolves under its new name once activated', async () => {
    /*
      CN4, not CN3. Activating permanently replaces a branch's live mapping, and
      the cases above (and E4 below) read CN3's seeded classes — a test that
      rewrites shared state is a test that breaks whichever case happens to run
      after it.
    */
    const cn4 = await branchIdOf('CN4');
    const cn4Base = `/api/admin/branches/${cn4}/room-mapping`;
    await testPrisma.branchRoomMappingVersion.deleteMany({ where: { branchId: cn4, status: 'DRAFT' } });

    const activeBefore = await loadActiveMapping(cn4, testPrisma);
    const draft = (await adminAgent.post(`${cn4Base}/drafts`).send({})).body.draft;
    const target = draft.roomClasses[0]!;

    await adminAgent
      .patch(`${cn4Base}/drafts/${draft.id}/room-classes/${target.id}`)
      .send({ displayName: 'Deluxe Premium', pmsCode: 'DLXPR' });
    const activated = await adminAgent
      .post(`${cn4Base}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: activeBefore!.versionId });
    expect(activated.status).toBe(200);

    // This is the link the booking/send flow reads: the ACTIVE version.
    expect((await resolveIn('CN4', 'Deluxe Premium')).pmsCode).toBe('DLXPR');
  });

  /*
    E3e-g. ALTERNATE NAMES SURVIVE THE WHOLE ROUND TRIP.

    The reported bug ("tên gọi khác" vanished after activating) was in the UI:
    the alias box committed only on Enter while the fields beside it committed on
    blur, so clicking activate discarded the text before it was ever sent. The
    server path was always correct — these pin that, so a future change to the
    persistence chain cannot quietly reintroduce the same symptom from the other
    end.
  */
  it('E3e. an alias added to a draft survives activation and is resolvable', async () => {
    const cn5 = await branchIdOf('CN5');
    const cn5Base = `/api/admin/branches/${cn5}/room-mapping`;
    await testPrisma.branchRoomMappingVersion.deleteMany({ where: { branchId: cn5, status: 'DRAFT' } });

    const activeBefore = await loadActiveMapping(cn5, testPrisma);
    const draft = (await adminAgent.post(`${cn5Base}/drafts`).send({})).body.draft;
    const target = draft.roomClasses[0]!;
    const codeBefore = target.pmsCode;

    const added = await adminAgent
      .post(`${cn5Base}/drafts/${draft.id}/room-classes/${target.id}/aliases`)
      .send({ alias: 'Phòng Đặc Biệt A' });
    expect(added.status).toBe(201);

    await adminAgent
      .post(`${cn5Base}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: activeBefore!.versionId });

    // Present on the live mapping after activation…
    const live = await loadActiveMapping(cn5, testPrisma);
    const cls = live!.classes.find((c) => c.pmsCode === codeBefore)!;
    expect(cls.aliases.map((a) => a.alias)).toContain('Phòng Đặc Biệt A');
    // …and it actually resolves, which is what the alias is for.
    expect((await resolveIn('CN5', 'Phòng Đặc Biệt A')).pmsCode).toBe(codeBefore);
    // The PMS code was not disturbed by adding an alias.
    expect(cls.pmsCode).toBe(codeBefore);
  });

  it('E3f. a second alias does not remove the first', async () => {
    const draft = await freshDraft();
    const target = draft.classes[0]!;
    const url = `${base()}/drafts/${draft.id}/room-classes/${target.id}/aliases`;

    await adminAgent.post(url).send({ alias: 'Tên Gọi Một' });
    const second = await adminAgent.post(url).send({ alias: 'Tên Gọi Hai' });
    expect(second.status).toBe(201);

    const reloaded = (await adminAgent.get(`${base()}/draft`)).body.draft;
    const cls = reloaded.roomClasses.find((c: { id: string }) => c.id === target.id);
    const names = cls.aliases.map((a: { alias: string }) => a.alias);
    expect(names).toContain('Tên Gọi Một');
    expect(names).toContain('Tên Gọi Hai');
    expect(cls.pmsCode).toBe(target.pmsCode);
  });

  it('E3g. a duplicate alias is still refused', async () => {
    // The fix was in the UI; the server's protections are unchanged.
    const draft = await freshDraft();
    const target = draft.classes[0]!;
    const url = `${base()}/drafts/${draft.id}/room-classes/${target.id}/aliases`;

    await adminAgent.post(url).send({ alias: 'Trùng Tên' });
    const again = await adminAgent.post(url).send({ alias: 'trùng tên' });
    expect(again.status).toBeGreaterThanOrEqual(400);

    const reloaded = (await adminAgent.get(`${base()}/draft`)).body.draft;
    const cls = reloaded.roomClasses.find((c: { id: string }) => c.id === target.id);
    expect(cls.aliases.filter((a: { alias: string }) => a.alias.toLowerCase() === 'trùng tên')).toHaveLength(1);
  });

  it('E4. an invalid draft cannot be activated', async () => {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;
    // Deactivate every class → an empty mapping.
    for (const cls of draft.roomClasses) {
      await adminAgent.patch(`${base()}/drafts/${draft.id}/room-classes/${cls.id}`).send({ active: false });
    }

    const validation = await adminAgent.post(`${base()}/drafts/${draft.id}/validate`);
    expect(validation.body.ok).toBe(false);
    expect(validation.body.problems.map((p: { code: string }) => p.code)).toContain('EMPTY_MAPPING');

    const activate = await adminAgent.post(`${base()}/drafts/${draft.id}/activate`).send({});
    expect(activate.status).toBe(422);
    // The previous version is still active and untouched.
    expect(await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } })).toBe(1);
    expect((await resolveIn('CN3', 'Standard')).pmsCode).toBe('STAN');
  });

  it('E5. a stale activation is rejected instead of overwriting another Admin', async () => {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;

    const stale = await adminAgent
      .post(`${base()}/drafts/${draft.id}/activate`)
      .send({ expectedActiveVersionId: 'some-other-version-id' });

    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/người khác cập nhật/);
    // Nothing changed.
    expect(await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } })).toBe(1);
    const draftRow = await testPrisma.branchRoomMappingVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(draftRow.status).toBe('DRAFT');
  });

  it('E6. duplicate names, codes and ambiguous aliases are rejected', async () => {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;

    const dupName = await adminAgent
      .post(`${base()}/drafts/${draft.id}/room-classes`)
      .send({ displayName: 'Standard', pmsCode: 'OTHER' });
    expect(dupName.status).toBe(409);

    const dupCode = await adminAgent
      .post(`${base()}/drafts/${draft.id}/room-classes`)
      .send({ displayName: 'Another Room', pmsCode: 'STAN' });
    expect(dupCode.status).toBe(409);

    // An alias that already belongs to a different class in this branch.
    const superior = draft.roomClasses.find((c: { pmsCode: string }) => c.pmsCode === 'SUP');
    const ambiguous = await adminAgent
      .post(`${base()}/drafts/${draft.id}/room-classes/${superior.id}/aliases`)
      .send({ alias: 'Standard' });
    expect(ambiguous.status).toBe(409);
  });

  it('E7. an archived or active version cannot be edited', async () => {
    const active = await loadActiveMapping(branchId, testPrisma);
    const cls = active!.classes[0]!;
    const res = await adminAgent
      .patch(`${base()}/drafts/${active!.versionId}/room-classes/${cls.id}`)
      .send({ pmsCode: 'HACK' });
    expect(res.status).toBe(409);
    expect((await resolveIn('CN3', cls.displayName)).pmsCode).toBe(cls.pmsCode);
  });

  it('E8. cancelling a draft leaves the active mapping intact', async () => {
    const before = await loadActiveMapping(branchId, testPrisma);
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;

    expect((await adminAgent.delete(`${base()}/drafts/${draft.id}`)).status).toBe(200);

    expect(await testPrisma.branchRoomMappingVersion.findUnique({ where: { id: draft.id } })).toBeNull();
    const after = await loadActiveMapping(branchId, testPrisma);
    expect(after!.versionId).toBe(before!.versionId);
  });

  it('E9. a draft for the wrong branch is refused', async () => {
    const otherBranchId = await branchIdOf('CN5');
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;

    const res = await adminAgent
      .post(`/api/admin/branches/${otherBranchId}/room-mapping/drafts/${draft.id}/activate`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('E10. every configuration change is audited', async () => {
    const draft = (await adminAgent.post(`${base()}/drafts`).send({})).body.draft;
    const cls = draft.roomClasses[0];
    await adminAgent.patch(`${base()}/drafts/${draft.id}/room-classes/${cls.id}`).send({ pmsCode: 'AUDIT_ME' });
    await adminAgent.post(`${base()}/drafts/${draft.id}/room-classes/${cls.id}/aliases`).send({ alias: 'Audit Alias' });
    await adminAgent.post(`${base()}/drafts/${draft.id}/validate`);

    const events = await testPrisma.branchChangeLog.findMany({
      where: { branchId },
      orderBy: { changedAt: 'desc' },
      take: 20,
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain('ROOM_MAPPING_DRAFT_CREATED');
    expect(actions).toContain('ROOM_CLASS_UPDATED');
    expect(actions).toContain('ROOM_CLASS_ALIAS_ADDED');
    expect(actions).toContain('ROOM_MAPPING_VALIDATED');
    // The actor is recorded.
    expect(events[0]!.changedByUserId).not.toBeNull();
  });
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('room-mapping authorization', () => {
  it('a receptionist is refused on every room-mapping route', async () => {
    const branchId = await branchIdOf('CN1');
    const base = `/api/admin/branches/${branchId}/room-mapping`;

    for (const res of await Promise.all([
      receptionistAgent.get(base),
      receptionistAgent.get(`${base}/versions`),
      receptionistAgent.get(`${base}/draft`),
      receptionistAgent.post(`${base}/drafts`).send({}),
      receptionistAgent.post(`${base}/drafts/x/activate`).send({}),
      receptionistAgent.delete(`${base}/drafts/x`),
    ])) {
      expect(res.status).toBe(403);
    }

    // …and the configuration is unchanged.
    expect((await resolveIn('CN1', 'Standard')).pmsCode).toBe('STAN');
  });
});
