/**
 * PostgreSQL concurrency suite (Phase D.1 §11, §19E).
 *
 * WHY THIS SUITE EXISTS AT ALL: under the SQLite pilot these races were
 * unobservable. SQLite serialises every writer, so a read-then-write sequence
 * in one request could not interleave with another's — which meant "enforced
 * by the service" was, in practice, true. PostgreSQL runs eight branches'
 * writers genuinely in parallel, so each of these invariants now has to be
 * proven against real simultaneous connections.
 *
 * Every test here therefore opens its OWN PrismaClient(s). Sharing the suite's
 * single client would serialise the operations through one connection and
 * prove nothing at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seedBranches } from '../src/db/seed';
import { seedBranchRoomClasses } from '../src/room/roomClassSeed';
import { activateDraft, createDraft, getActiveVersion } from '../src/room/roomMappingService';
import { addGuest, setPrimaryGuest, updateGuest } from '../src/booking/guestService';
import { resetAll, testPrisma, utcDate } from './helpers/db';
import { createAdmin } from './helpers/auth';
import { resolveTestDatabaseUrl } from '../src/d1/testDatabase';

const TEST_URL = resolveTestDatabaseUrl();

/** Opens N independent connections, so the writers below are genuinely parallel. */
function openClients(n: number): PrismaClient[] {
  return Array.from({ length: n }, () => new PrismaClient({ datasourceUrl: TEST_URL }));
}

let extraClients: PrismaClient[] = [];
let adminId: number;
let branchId: number;

/** Settles a set of promises into winners/losers without throwing. */
async function settle<T>(promises: Promise<T>[]): Promise<{ ok: T[]; failed: Error[] }> {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    failed: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as Error),
  };
}

beforeEach(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  await seedBranchRoomClasses(testPrisma);
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  branchId = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
  extraClients = [];
}, 60_000);

afterEach(async () => {
  await Promise.all(extraClients.map((c) => c.$disconnect()));
  extraClients = [];
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function makeBooking(id: string, code: string, overrides: Record<string, unknown> = {}) {
  return testPrisma.booking.create({
    data: {
      id,
      bookingCode: code,
      customerName: 'Khách Kiểm Thử',
      phone: '0900000001',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER',
      branchId,
      checkInDate: utcDate('2026-08-01'),
      checkOutDate: utcDate('2026-08-03'),
      status: 'DRAFT',
      ...overrides,
    },
  });
}

describe('concurrent room-mapping activation', () => {
  it('E1. two Admins activating two drafts at once — exactly one wins', async () => {
    const before = await getActiveVersion(branchId, testPrisma);
    expect(before).not.toBeNull();

    // Two independent drafts of the same branch, each a copy of the live one.
    const draftA = await createDraft(branchId, undefined, adminId, testPrisma);
    const active = await getActiveVersion(branchId, testPrisma);

    const [clientA, clientB] = openClients(2);
    extraClients.push(clientA!, clientB!);

    // Both callers believe the SAME version is currently active — the classic
    // "we both loaded the page, then both pressed Activate" situation.
    const { ok, failed } = await settle([
      activateDraft(branchId, draftA.id, active!.id, 'A', adminId, clientA!),
      activateDraft(branchId, draftA.id, active!.id, 'B', adminId, clientB!),
    ]);

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // The database itself must still hold exactly one ACTIVE version.
    const activeCount = await testPrisma.branchRoomMappingVersion.count({
      where: { branchId, status: 'ACTIVE' },
    });
    expect(activeCount).toBe(1);
  });

  it('E2. the partial unique index rejects a second ACTIVE version at the database level', async () => {
    // Belt-and-braces: even if every line of service code were bypassed, the
    // database must refuse. This is the C.3.8 invariant expressed in SQL.
    const active = await getActiveVersion(branchId, testPrisma);
    await expect(
      testPrisma.branchRoomMappingVersion.create({
        data: { branchId, versionNumber: 9999, status: 'ACTIVE' },
      }),
    ).rejects.toThrow();

    expect(
      await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } }),
    ).toBe(1);
    expect((await getActiveVersion(branchId, testPrisma))!.id).toBe(active!.id);
  });

  it('E3. a stale expectedActiveVersionId is rejected as a conflict', async () => {
    const draft = await createDraft(branchId, undefined, adminId, testPrisma);
    await expect(
      activateDraft(branchId, draft.id, 'a-version-id-that-never-existed', undefined, adminId, testPrisma),
    ).rejects.toMatchObject({ status: 409 });

    // ...and the activation that was refused changed nothing.
    expect(
      await testPrisma.branchRoomMappingVersion.count({ where: { branchId, status: 'ACTIVE' } }),
    ).toBe(1);
  });
});

describe('concurrent guest updates', () => {
  it('E4. two Admins promoting different guests — exactly one primary survives', async () => {
    await makeBooking('bk-primary', 'CONC001');
    const actor = { id: adminId, role: 'ADMIN' as const, branchId: null };

    // The FIRST guest on a booking is necessarily the primary one, so three are
    // needed to end up with two non-primary candidates to race between.
    await addGuest('bk-primary', { fullName: 'Khách Gốc' }, actor, testPrisma);
    await addGuest('bk-primary', { fullName: 'Khách A' }, actor, testPrisma);
    await addGuest('bk-primary', { fullName: 'Khách B' }, actor, testPrisma);
    const guests = await testPrisma.bookingGuest.findMany({
      where: { bookingId: 'bk-primary', isPrimary: false },
      orderBy: { sortOrder: 'asc' },
    });
    expect(guests).toHaveLength(2);

    const [clientA, clientB] = openClients(2);
    extraClients.push(clientA!, clientB!);

    await settle([
      setPrimaryGuest('bk-primary', guests[0]!.id, actor, clientA!),
      setPrimaryGuest('bk-primary', guests[1]!.id, actor, clientB!),
    ]);

    // Whatever the interleaving, the booking must end with exactly ONE primary
    // guest — this is what BookingGuest_one_primary_per_booking guarantees.
    const primaries = await testPrisma.bookingGuest.findMany({
      where: { bookingId: 'bk-primary', isPrimary: true },
    });
    expect(primaries).toHaveLength(1);

    // ...and the denormalised mirror on Booking must agree with it.
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: 'bk-primary' } });
    expect(booking.customerName).toBe(primaries[0]!.fullName);
  });

  it('E5. a stale guest PATCH loses, and the winner\'s value is the one kept', async () => {
    await makeBooking('bk-stale', 'CONC002');
    const actor = { id: adminId, role: 'ADMIN' as const, branchId: null };
    await addGuest('bk-stale', { fullName: 'Ban Đầu' }, actor, testPrisma);
    const guest = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId: 'bk-stale' } });

    const staleToken = guest.updatedAt.toISOString();

    // First write succeeds and moves updatedAt on.
    await updateGuest('bk-stale', guest.id, { fullName: 'Người Thắng', expectedUpdatedAt: staleToken }, actor, testPrisma);

    // Second write presents the SAME (now stale) token and must be refused.
    await expect(
      updateGuest('bk-stale', guest.id, { fullName: 'Người Thua', expectedUpdatedAt: staleToken }, actor, testPrisma),
    ).rejects.toMatchObject({ status: 409 });

    const after = await testPrisma.bookingGuest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(after.fullName).toBe('Người Thắng');
  });

  it('E6. two simultaneous PATCHes with the same token — one wins, one conflicts', async () => {
    await makeBooking('bk-race', 'CONC003');
    const actor = { id: adminId, role: 'ADMIN' as const, branchId: null };
    await addGuest('bk-race', { fullName: 'Ban Đầu' }, actor, testPrisma);
    const guest = await testPrisma.bookingGuest.findFirstOrThrow({ where: { bookingId: 'bk-race' } });
    const token = guest.updatedAt.toISOString();

    const [clientA, clientB] = openClients(2);
    extraClients.push(clientA!, clientB!);

    const { ok, failed } = await settle([
      updateGuest('bk-race', guest.id, { fullName: 'Tên A', expectedUpdatedAt: token }, actor, clientA!),
      updateGuest('bk-race', guest.id, { fullName: 'Tên B', expectedUpdatedAt: token }, actor, clientB!),
    ]);

    // Exactly one write is applied. Without the in-transaction conditional
    // update both would "succeed" and one change would vanish silently.
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const after = await testPrisma.bookingGuest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(['Tên A', 'Tên B']).toContain(after.fullName);

    // The audit trail must record exactly one update, not two.
    const events = await testPrisma.bookingAuditEvent.count({
      where: { bookingId: 'bk-race', action: 'BOOKING_GUEST_UPDATED' },
    });
    expect(events).toBe(1);
  });
});

describe('concurrent operational bookings', () => {
  it('E7. the same reservation cannot be dispatched twice concurrently', async () => {
    const [clientA, clientB] = openClients(2);
    extraClients.push(clientA!, clientB!);

    const row = (id: string) => ({
      id,
      bookingCode: 'DUP-9001',
      customerName: 'Khách Trùng',
      rawText: 'raw',
      paymentStatus: 'PAY_AFTER' as const,
      branchId,
      checkInDate: utcDate('2026-09-10'),
      status: 'NEW' as const,
    });

    const { ok, failed } = await settle([
      clientA!.booking.create({ data: row('dup-a') }),
      clientB!.booking.create({ data: row('dup-b') }),
    ]);

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const operational = await testPrisma.booking.count({
      where: { bookingCode: 'DUP-9001', status: { in: ['NEW', 'COMPLETED', 'ARCHIVED'] } },
    });
    expect(operational).toBe(1);
  });

  it('E8. DRAFT duplicates are still allowed — the extraction flow warns, it does not block', async () => {
    // The index deliberately covers operational statuses only. Regressing this
    // into a global unique constraint would break admin extraction.
    await makeBooking('draft-a', 'DUP-9002', { status: 'DRAFT' });
    await expect(makeBooking('draft-b', 'DUP-9002', { status: 'DRAFT' })).resolves.toBeTruthy();

    expect(await testPrisma.booking.count({ where: { bookingCode: 'DUP-9002' } })).toBe(2);
  });
});

describe('transaction atomicity', () => {
  it('E9. a failed transaction leaves no partial write behind', async () => {
    await makeBooking('bk-atomic', 'CONC004');
    const before = await testPrisma.bookingAuditEvent.count({ where: { bookingId: 'bk-atomic' } });

    await expect(
      testPrisma.$transaction(async (tx) => {
        await tx.bookingAuditEvent.create({
          data: { bookingId: 'bk-atomic', action: 'BOOKING_GUEST_ADDED', newValue: 'partial' },
        });
        await tx.bookingGuest.create({
          data: { id: 'g-atomic', bookingId: 'bk-atomic', fullName: 'X', isPrimary: true },
        });
        // Violates the one-primary-per-booking index → the whole unit rolls back.
        await tx.bookingGuest.create({
          data: { id: 'g-atomic-2', bookingId: 'bk-atomic', fullName: 'Y', isPrimary: true },
        });
      }),
    ).rejects.toThrow();

    expect(await testPrisma.bookingAuditEvent.count({ where: { bookingId: 'bk-atomic' } })).toBe(before);
    expect(await testPrisma.bookingGuest.count({ where: { bookingId: 'bk-atomic' } })).toBe(0);
  });
});
