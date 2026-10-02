/**
 * Asking "what would these room names resolve to?" without creating anything.
 *
 * A Booking.com reservation no longer has a draft to hang a room-class snapshot
 * on, and the branch is chosen DURING review — so resolution cannot happen at
 * extraction time any more. The review screen asks this endpoint instead.
 *
 * The property that makes it safe to call from an unsent review is the one every
 * case below re-checks: it WRITES NOTHING. No Booking, no BookingRoom, no
 * snapshot row, not even for a name it resolves perfectly.
 *
 * It is a suggestion, not a decision. `bookingComDispatch.test.ts` covers the
 * authoritative resolution that happens when the order is actually sent.
 */
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
import { loadActiveMapping } from '../src/room/roomClassResolver';

let app: ReturnType<typeof createApp>;
let admin: Awaited<ReturnType<typeof loginAgent>>['agent'];
let branchId: number;
let otherBranchId: number;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  app = createApp();
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  const branches = await testPrisma.branch.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
  branchId = branches[0]!.id;
  otherBranchId = branches[1]!.id;
}, 120_000);

beforeEach(async () => {
  await testPrisma.booking.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

const resolveUrl = (id: number) => `/api/admin/branches/${id}/room-mapping/resolve`;

interface Resolved {
  sourceRoomName: string | null;
  status: string;
  roomClassId: string | null;
  displayName: string | null;
  pmsCode: string | null;
  matchedAlias: string | null;
}

async function resolve(id: number, roomNames: (string | null)[]) {
  const res = await admin.post(resolveUrl(id)).send({ roomNames });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body as { versionId: string | null; rooms: Resolved[] };
}

/** Everything a Booking.com extraction used to write. */
async function writeCounts() {
  const [bookings, rooms, nights] = await Promise.all([
    testPrisma.booking.count(),
    testPrisma.bookingRoom.count(),
    testPrisma.bookingNightPrice.count(),
  ]);
  return { bookings, rooms, nights };
}

/* ================================================================== */
/* Test 4 — the branch's ACTIVE mapping, and no persistence            */
/* ================================================================== */

describe('Test 4 — resolving against the selected branch', () => {
  it('answers from the branch ACTIVE mapping version', async () => {
    const mapping = await loadActiveMapping(branchId, testPrisma);
    expect(mapping).not.toBeNull();
    const known = mapping!.classes.find((c) => c.active)!;

    const body = await resolve(branchId, [known.displayName]);

    expect(body.versionId).toBe(mapping!.versionId);
    expect(body.rooms[0]!.status).toBe('RESOLVED');
    expect(body.rooms[0]!.roomClassId).toBe(known.id);
    expect(body.rooms[0]!.pmsCode).toBe(known.pmsCode);
    expect(body.rooms[0]!.displayName).toBe(known.displayName);
  });

  it('creates no Booking, no room and no night', async () => {
    const before = await writeCounts();
    const mapping = await loadActiveMapping(branchId, testPrisma);
    const names = mapping!.classes.filter((c) => c.active).map((c) => c.displayName);

    await resolve(branchId, names);
    await resolve(branchId, names);

    expect(await writeCounts()).toEqual(before);
    expect(await writeCounts()).toEqual({ bookings: 0, rooms: 0, nights: 0 });
  });

  it('writes no snapshot row either — it only reads', async () => {
    const before = await testPrisma.branchRoomClass.count();
    await resolve(branchId, ['Deluxe', 'Không rõ', null]);
    expect(await testPrisma.branchRoomClass.count()).toBe(before);
  });

  it('never borrows another branch mapping for an unknown name', async () => {
    const other = await loadActiveMapping(otherBranchId, testPrisma);
    const foreignOnly = other!.classes
      .filter((c) => c.active)
      .map((c) => c.displayName)
      .find(async (name) => {
        const mine = await loadActiveMapping(branchId, testPrisma);
        return !mine!.classes.some((c) => c.displayName === name);
      });

    // Whatever the name, the answer must come from THIS branch's version.
    const body = await resolve(branchId, [foreignOnly ?? 'Một hạng phòng lạ']);
    const mine = await loadActiveMapping(branchId, testPrisma);
    expect(body.versionId).toBe(mine!.versionId);
    if (body.rooms[0]!.roomClassId !== null) {
      expect(mine!.classes.map((c) => c.id)).toContain(body.rooms[0]!.roomClassId);
    }
  });

  it('reports UNRESOLVED rather than guessing at a name it cannot read', async () => {
    const body = await resolve(branchId, ['Một hạng phòng hoàn toàn không tồn tại']);
    expect(body.rooms[0]!.status).toBe('UNRESOLVED');
    expect(body.rooms[0]!.roomClassId).toBeNull();
    expect(body.rooms[0]!.pmsCode).toBeNull();
    // The source text survives, so a human can pick the class explicitly.
    expect(body.rooms[0]!.sourceRoomName).toBe('Một hạng phòng hoàn toàn không tồn tại');
  });

  it('handles a room with no name at all', async () => {
    const body = await resolve(branchId, [null]);
    expect(body.rooms[0]!.status).toBe('UNRESOLVED');
    expect(body.rooms[0]!.roomClassId).toBeNull();
  });

  it('answers a whole review in one call, in order', async () => {
    const mapping = await loadActiveMapping(branchId, testPrisma);
    const active = mapping!.classes.filter((c) => c.active);
    const names = [active[0]!.displayName, 'Không rõ', active[active.length - 1]!.displayName];

    const body = await resolve(branchId, names);

    expect(body.rooms.map((r) => r.sourceRoomName)).toEqual(names);
    expect(body.rooms[0]!.roomClassId).toBe(active[0]!.id);
    expect(body.rooms[1]!.roomClassId).toBeNull();
    expect(body.rooms[2]!.roomClassId).toBe(active[active.length - 1]!.id);
  });
});

/* ================================================================== */
/* Who may ask                                                         */
/* ================================================================== */

describe('the mapping is Admin-only configuration', () => {
  it('refuses a receptionist', async () => {
    await createReceptionist(branchId, { username: 'le-tan-resolve' });
    const { agent } = await loginAgent(app, 'le-tan-resolve', RECEPTIONIST_PASSWORD);
    const res = await agent.post(resolveUrl(branchId)).send({ roomNames: ['Deluxe'] });
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).post(resolveUrl(branchId)).send({ roomNames: ['Deluxe'] });
    expect(res.status).toBe(401);
  });
});
