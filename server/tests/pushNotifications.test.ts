/**
 * OPERATIONAL PUSH NOTIFICATIONS — and the in-app bell they share a row with.
 *
 *   23  a device subscription always belongs to the signed-in account
 *   24  a worker is told about its OWN assignments, nobody else's
 *   25  no notice crosses a branch the assignment could not cross
 *   26  reads, refreshes and retries never repeat a notice or a push
 *   27  three rooms given at once are ONE notice
 *   28  a device the push service reports gone is revoked; the others still get it
 *   +   the wire format: RFC 8291's own test vector, and a verifiable VAPID token
 */
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetHousekeepingData, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, createAdmin, createUser, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { serveAllBranches } from './helpers/issues';
import { notifyOperational, pushNotification, setPushSender, settlePushes } from '../src/push/pushService';
import { encryptPayload, generateVapidKeys, isPushServiceEndpoint, vapidAuthorization } from '../src/push/webPush';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);
const PASSWORD = 'Matkhau123';
const DAY = '2026-10-07';

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let manager1: Agent;
let lan: Agent;
let hoa: Agent;
let techManager2: Agent;
const ids: Record<string, number> = {};

/** What the fake push service received, and how it answers each endpoint. */
let sent: { endpoint: string; message: { title: string; body: string; url: string } }[] = [];
let answer: (endpoint: string) => number = () => 201;

function device(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

async function person(username: string, fullName: string, role: string, branchId: number | null) {
  ids[username] = (await createUser({ username, password: PASSWORD, fullName, role: role as never, branchId, mustChangePassword: false })).id;
  return (await loginAgent(app, username, PASSWORD)).agent;
}

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  manager1 = await person('qlbp1', 'Quản lý BP1', 'HOUSEKEEPING_MANAGER', cn1);
  lan = await person('lan', 'Chị Lan', 'HOUSEKEEPING', cn1);
  hoa = await person('hoa', 'Chị Hoa', 'HOUSEKEEPING', cn1);
  await person('mai', 'Chị Mai', 'HOUSEKEEPING', cn2);
  await person('kythuat', 'Kỹ thuật', 'TECHNICAL', null);
  await serveAllBranches(ids.kythuat!);
  const tm = await admin.post('/api/admin/users').send({ username: 'qlkt2', fullName: 'QLKT CN2', temporaryPassword: PASSWORD, role: 'TECHNICAL_MANAGER', branchIds: [cn2] });
  expect(tm.status).toBe(201);
  await testPrisma.user.update({ where: { id: tm.body.user.id }, data: { mustChangePassword: false } });
  techManager2 = (await loginAgent(app, 'qlkt2', PASSWORD)).agent;
});

beforeEach(async () => {
  await resetHousekeepingData();
  await resetIssueData();
  await resetShiftData();
  await testPrisma.notification.deleteMany();
  await testPrisma.pushSubscription.deleteMany();
  sent = [];
  answer = () => 201;
  setPushSender(async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, message: JSON.parse(payload.toString('utf8')) });
    return answer(subscription.endpoint);
  });
  setClock({ now: () => hcm(DAY, '08:00') });
});

afterEach(async () => {
  await settlePushes();
  setPushSender(null);
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

const assignRooms = (rooms: string[], assigneeUserId: number, agent: Agent = manager1) =>
  agent.post('/api/housekeeping/manager/tasks').send({ workDate: DAY, roomNumbers: rooms, statusCode: 'OUT', assigneeUserId });

describe('device subscriptions', () => {
  it('23. belong to the signed-in account — never to a user named in the request', async () => {
    const phone = device('lan-phone');
    const res = await lan.post('/api/push/subscriptions').send({ ...phone, userId: ids.hoa });
    expect(res.status).toBe(201);
    expect(await testPrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: phone.endpoint } })).toMatchObject({ userId: ids.lan });
    // Somebody else cannot remove it.
    expect((await hoa.delete('/api/push/subscriptions').send({ endpoint: phone.endpoint })).body.removed).toBe(0);
    // The same phone signed in as Hoa now belongs to Hoa, and only to her.
    expect((await hoa.post('/api/push/subscriptions').send(phone)).status).toBe(201);
    expect(await testPrisma.pushSubscription.findMany({ where: { endpoint: phone.endpoint } })).toEqual([expect.objectContaining({ userId: ids.hoa })]);
    // Not a push service: refused — the server never posts to an arbitrary address.
    for (const endpoint of ['http://127.0.0.1:5432/x', 'https://evil.example.com/push', 'https://fcm.googleapis.com.evil.io/x']) {
      expect((await lan.post('/api/push/subscriptions').send({ ...device('x'), endpoint })).status).toBe(422);
    }
    expect((await lan.post('/api/push/subscriptions').send({ ...phone, keys: { p256dh: 'abc', auth: 'def' } })).status).toBe(422);
    // The browser learns the PUBLIC key only (none configured in tests).
    expect((await lan.get('/api/push/config')).body).toEqual({ publicKey: null });
    expect((await hoa.delete('/api/push/subscriptions').send({ endpoint: phone.endpoint })).body.removed).toBe(1);
  });
});

describe('who is told', () => {
  it('24, 27. the worker given the rooms — once for the batch, with its own devices only', async () => {
    const lanPhone = device('lan-phone');
    const lanTablet = device('lan-tablet');
    const hoaPhone = device('hoa-phone');
    for (const [agent, d] of [[lan, lanPhone], [lan, lanTablet], [hoa, hoaPhone]] as const) {
      expect((await agent.post('/api/push/subscriptions').send(d)).status).toBe(201);
    }
    expect((await assignRooms(['101', '102', '103'], ids.lan!)).status).toBe(201);
    await settlePushes();

    const notices = await testPrisma.notification.findMany();
    expect(notices).toEqual([
      expect.objectContaining({
        userId: ids.lan,
        kind: 'HOUSEKEEPING_ASSIGNED',
        title: 'Công việc buồng phòng mới',
        body: expect.stringMatching(/^CN \d+ · 3 phòng mới được giao$/),
        link: '/app/inspections',
      }),
    ]);
    expect(sent.map((s) => s.endpoint).sort()).toEqual([lanPhone.endpoint, lanTablet.endpoint].sort());
    expect(sent[0]!.message).toMatchObject({ title: 'Công việc buồng phòng mới', url: '/app/inspections' });

    // One room: its own words, and the press opens that room.
    sent = [];
    expect((await assignRooms(['201'], ids.hoa!)).status).toBe(201);
    await settlePushes();
    const one = await testPrisma.notification.findFirstOrThrow({ where: { userId: ids.hoa } });
    expect(one.body).toMatch(/^CN \d+ · Phòng 201 · Dọn phòng$/);
    expect(one.link).toMatch(/^\/app\/inspections\/room\/\w+$/);
    expect(sent.map((s) => s.endpoint)).toEqual([hoaPhone.endpoint]);
    // The manager who assigned it is not told.
    expect(await testPrisma.notification.count({ where: { userId: ids.qlbp1 } })).toBe(0);
  });

  it('24. a reassignment tells the new worker; a technician hears of its own incidents', async () => {
    await assignRooms(['301'], ids.lan!);
    const task = await testPrisma.housekeepingRoomTask.findFirstOrThrow({ where: { roomNumber: '301' } });
    setClock({ now: () => hcm(DAY, '08:10') });
    expect((await manager1.post(`/api/housekeeping/manager/tasks/${task.id}/assign`).send({ assigneeUserId: ids.hoa })).status).toBe(200);
    expect(await testPrisma.notification.count({ where: { userId: ids.hoa, kind: 'HOUSEKEEPING_ASSIGNED' } })).toBe(1);

    const letan = await person('letan24', 'Lễ tân', 'RECEPTIONIST', cn1);
    const issue = await letan.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '202', category: 'TV', description: 'TV hỏng' });
    expect(issue.status).toBe(201);
    expect((await admin.post(`/api/issues/${issue.body.issue.id}/assign`).send({ technicianUserId: ids.kythuat })).status).toBe(200);
    const told = await testPrisma.notification.findMany({ where: { kind: 'TECHNICAL_ASSIGNED' } });
    expect(told).toEqual([
      expect.objectContaining({ userId: ids.kythuat, title: 'Công việc kỹ thuật mới', body: expect.stringMatching(/^CN \d+ · Phòng 202 · /), link: '/app/technical/new' }),
    ]);
  });

  it('24. a re-clean tells the worker it was given to — short, with the reason', async () => {
    await assignRooms(['101'], ids.lan!);
    const task = await testPrisma.housekeepingRoomTask.findFirstOrThrow({ where: { roomNumber: '101' } });
    await testPrisma.housekeepingRoomTask.update({
      where: { id: task.id },
      data: { state: 'COMPLETED', startedAt: hcm(DAY, '08:20'), completedAt: hcm(DAY, '08:40'), cleanedByUserId: ids.lan, cleanedByNameSnapshot: 'Chị Lan' },
    });
    const res = await manager1.post(`/api/housekeeping/manager/tasks/${task.id}/review`).send({ result: 'FAILED', reason: 'Thiếu khăn tắm', reclean: true, assigneeUserId: ids.hoa });
    expect(res.status).toBe(200);
    const notice = await testPrisma.notification.findFirstOrThrow({ where: { kind: 'HOUSEKEEPING_RECLEAN' } });
    expect(notice).toMatchObject({
      userId: ids.hoa,
      title: 'Dọn lại phòng 101',
      link: `/app/inspections/room/${res.body.reclean.id}`,
    });
    expect(notice.body).toMatch(/^CN \d+ · Phòng 101 · Không đạt\nLý do: Thiếu khăn tắm$/);
  });

  it('25. nothing crosses a branch: refused assignments tell nobody', async () => {
    // A branch-1 manager cannot give work to a branch-2 worker…
    expect((await assignRooms(['101'], ids.mai!)).status).toBe(422);
    // …and a branch-2 Quản lý kỹ thuật cannot give a branch-1 incident.
    const letan = await person('letan25', 'Lễ tân', 'RECEPTIONIST', cn1);
    const issue = await letan.post('/api/issues').send({ areaCategory: 'ROOM', roomNumber: '301', category: 'TV', description: 'x' });
    expect((await techManager2.post(`/api/issues/${issue.body.issue.id}/assign`).send({ technicianUserId: ids.kythuat })).status).toBe(403);
    expect(await testPrisma.notification.count({ where: { kind: { not: null } } })).toBe(0);
    await settlePushes();
    expect(sent).toEqual([]);
  });
});

describe('never twice', () => {
  it('26. reading, refreshing and retrying repeat neither the notice nor its push', async () => {
    expect((await lan.post('/api/push/subscriptions').send(device('lan-phone'))).status).toBe(201);
    expect((await assignRooms(['101'], ids.lan!)).status).toBe(201);
    await settlePushes();
    for (let i = 0; i < 3; i += 1) {
      await lan.get('/api/notifications');
      await lan.get('/api/notifications/unread-count');
      await lan.get(`/api/housekeeping/work?date=${DAY}`);
      await manager1.get(`/api/housekeeping/manager/tasks?date=${DAY}`);
    }
    // A retried "add room" finds it already on the board and creates nothing.
    expect((await assignRooms(['101'], ids.lan!)).body).toMatchObject({ created: 0, skipped: ['101'] });
    await settlePushes();
    expect(await testPrisma.notification.count()).toBe(1);
    expect(sent).toHaveLength(1);
    // The push itself is claimed once, whoever asks again.
    const notice = await testPrisma.notification.findFirstOrThrow();
    expect(await pushNotification(notice.id)).toEqual({ sent: 0, revoked: 0 });
    // The same action key twice is the same notice.
    const again = { userId: ids.lan!, kind: 'HOUSEKEEPING_ASSIGNED' as const, title: 't', body: 'b', link: '/app/inspections', dedupeKey: 'same-action' };
    expect(await notifyOperational([again])).toHaveLength(1);
    expect(await notifyOperational([again])).toEqual([]);
    await settlePushes();
    expect(await testPrisma.notification.count()).toBe(2);
    expect(sent).toHaveLength(2);
  });
});

describe('devices that are gone', () => {
  it('28. are revoked when the push service says so — the account’s other devices still get it', async () => {
    const old = device('old-phone');
    const current = device('new-phone');
    for (const d of [old, current]) expect((await lan.post('/api/push/subscriptions').send(d)).status).toBe(201);
    answer = (endpoint) => (endpoint === old.endpoint ? 410 : 201);
    await assignRooms(['101'], ids.lan!);
    await settlePushes();
    expect(await testPrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: old.endpoint } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await testPrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: current.endpoint } })).toMatchObject({
      revokedAt: null,
      lastUsedAt: expect.any(Date),
    });
    // The next assignment is not sent to the revoked device at all.
    sent = [];
    await assignRooms(['102'], ids.lan!);
    await settlePushes();
    expect(sent.map((s) => s.endpoint)).toEqual([current.endpoint]);
    // A network failure on one device is not an error for the assignment.
    answer = () => {
      throw new Error('ECONNRESET');
    };
    expect((await assignRooms(['103'], ids.lan!)).status).toBe(201);
    await settlePushes();
    // Re-subscribing the device brings it back.
    expect((await lan.post('/api/push/subscriptions').send(old)).status).toBe(201);
    expect(await testPrisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: old.endpoint } })).toMatchObject({ revokedAt: null });
  });
});

describe('the wire format', () => {
  it('encrypts exactly as RFC 8291 Appendix A', () => {
    const body = encryptPayload(
      Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      {
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
        serverPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
      },
    );
    // Header: salt || rs = 4096 || idlen = 65 || the server's public key; then the record.
    expect(body.subarray(0, 16).toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlw');
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body.subarray(21, 86).toString('base64url')).toBe(
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
    expect(body.subarray(86).toString('base64url')).toBe('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
  });

  it('signs a VAPID token the public key verifies, for the push service origin only', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'mailto:it@kas.vn' }, Date.UTC(2026, 9, 7));
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = token!.split('.');
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:it@kas.vn' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(isPushServiceEndpoint('https://web.push.apple.com/QGx')).toBe(true);
    expect(isPushServiceEndpoint('https://localhost/x')).toBe(false);
  });
});
