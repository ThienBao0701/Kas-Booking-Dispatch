/**
 * Reception shift sessions, end to end.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A receptionist checks in ONCE and the server remembers — across requests,
 *      which is what makes a browser refresh harmless.
 *   2. The next prompt is due at the shift's nominal end plus ten minutes, and
 *      the SERVER decides that, so a wrongly-set reception PC cannot nag early.
 *   3. There is never more than one open session for a receptionist, even when
 *      two tabs check in at the same instant.
 *   4. Nobody else has a shift, and nobody can check in to another branch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetShiftData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';

/** 06:00 HCM on the 17th == 23:00 UTC on the 16th. */
const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letanId = 0;
let admin: Agent;

let letan2: Agent;
let tech: Agent;

/**
 * Everything durable is built ONCE.
 *
 * Two reasons, both learned the hard way. `seedBranches` also seeds OTA room
 * mappings, which carry their own unique index, so re-running it per test
 * collides. And the login endpoint is rate limited per app instance, so logging
 * in on every test exhausts the limiter and later tests start receiving 401
 * instead of the status they were asserting.
 */
beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  const user = await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letanId = user.id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

/** The only per-test state is the shifts themselves, and the clock. */
async function setup(now: Date): Promise<void> {
  await resetShiftData();
  setClock({ now: () => now });
}

beforeEach(async () => {
  await setup(hcm('2026-09-17', '06:00'));
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

describe('a receptionist checks in to a shift', () => {
  it('starts with no session, and that is not an error', async () => {
    const res = await letan.get('/api/reception/shifts/current');
    expect(res.status).toBe(200);
    // `null`, not 404: "not checked in yet" is the normal state at 06:00.
    expect(res.body.session).toBeNull();
  });

  it('offers the five shifts with their clock times', async () => {
    const res = await letan.get('/api/reception/shifts/options');
    expect(res.status).toBe(200);
    expect(res.body.shifts.map((s: { code: string }) => s.code)).toEqual(['A', 'B', 'C', 'A4', 'C4']);
    const a4 = res.body.shifts.find((s: { code: string }) => s.code === 'A4');
    expect(a4).toMatchObject({ startLocalTime: '06:00', endLocalTime: '18:00', graceMinutes: 10 });
  });

  it('records the shift, the name and the branch', async () => {
    const res = await letan
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A4', receptionistName: '  Nguyễn Văn A  ' });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      shiftType: 'A4',
      shiftName: 'Ca A4',
      shiftWindow: '06:00 – 18:00',
      // Trimmed, so a stray space never becomes part of somebody's name.
      receptionistName: 'Nguyễn Văn A',
      branchId: cn1,
      promptDue: false,
    });
    expect(res.body.session.nominalEndAt).toBe(hcm('2026-09-17', '18:00').toISOString());
    expect(res.body.session.graceEndAt).toBe(hcm('2026-09-17', '18:10').toISOString());
  });

  /**
   * THE REFRESH CASE. The session is read back from the SERVER on a brand-new
   * request, which is what makes a reload, a second tab and a reopened laptop
   * all agree — none of this lives in React state.
   */
  it('remembers the shift on a later request', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });

    const res = await letan.get('/api/reception/shifts/current');
    expect(res.body.session).toMatchObject({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
  });

  it('refuses a blank name', async () => {
    const res = await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: '' });
    expect(res.status).toBe(422);
  });

  it('refuses a name of only whitespace', async () => {
    const res = await letan
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A', receptionistName: '     ' });
    expect(res.status).toBe(422);
  });

  it('refuses a shift that does not exist', async () => {
    const res = await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'Z9', receptionistName: 'A' });
    expect(res.status).toBe(422);
  });

  /**
   * THE BRANCH IS TAKEN FROM THE ACCOUNT, NEVER FROM THE REQUEST. The body below
   * names another branch; the stored session still belongs to CN1, because the
   * server never asks the client which branch it is.
   */
  it('ignores a branch the client tries to supply', async () => {
    const res = await letan
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A', branchId: cn2 });

    expect(res.status).toBe(201);
    expect(res.body.session.branchId).toBe(cn1);

    const stored = await testPrisma.receptionShiftSession.findFirstOrThrow({ where: { userId: letanId } });
    expect(stored.branchId).toBe(cn1);
  });
});

describe('only a receptionist has a shift', () => {
  it('refuses an Admin check-in', async () => {
    const res = await admin.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'X' });
    expect(res.status).toBe(403);
  });

  it('refuses a technical check-in', async () => {
    const res = await tech.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'X' });
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous check-in', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A', receptionistName: 'X' });
    expect(res.status).toBe(401);
  });
});

describe('one open session per receptionist', () => {
  /**
   * Checking in again CLOSES the previous session and opens a new one, in a
   * single transaction. The old one is kept — it is the audit record of who was
   * on the desk — but it is no longer open.
   */
  it('checking in again closes the previous shift', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });

    setClock({ now: () => hcm('2026-09-17', '14:15') });
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'B', receptionistName: 'Trần Thị B' });

    const all = await testPrisma.receptionShiftSession.findMany({
      where: { userId: letanId },
      orderBy: { startedAt: 'asc' },
    });
    expect(all).toHaveLength(2);
    // The first is closed, and still there.
    expect(all[0]!.shiftType).toBe('A');
    expect(all[0]!.closedAt).not.toBeNull();
    // Exactly one remains open.
    expect(all[1]!.shiftType).toBe('B');
    expect(all[1]!.closedAt).toBeNull();
    expect(all.filter((s) => s.closedAt === null)).toHaveLength(1);
  });

  /**
   * THE TWO-TAB CASE, PROVED AT THE DATABASE.
   *
   * The partial unique index — not the application — is what forbids a second
   * open session. Inserting one directly, bypassing every service check, must
   * still fail: that is what makes the rule hold under a race an application
   * SELECT would lose.
   */
  it('the database physically refuses a second open session', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });

    const insertSecond = testPrisma.receptionShiftSession.create({
      data: {
        branchId: cn1,
        userId: letanId,
        shiftType: 'B',
        receptionistName: 'Kẻ chen ngang',
        startedAt: hcm('2026-09-17', '07:00'),
        nominalEndAt: hcm('2026-09-17', '15:00'),
        graceEndAt: hcm('2026-09-17', '15:10'),
      },
    });

    await expect(insertSecond).rejects.toThrow();

    const open = await testPrisma.receptionShiftSession.findMany({
      where: { userId: letanId, closedAt: null },
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.shiftType).toBe('A');
  });

  it('two receptionists each have their own open shift', async () => {
    const other = letan2;

    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Người CN1' });
    await other.post('/api/reception/shifts/check-in').send({ shiftType: 'C', receptionistName: 'Người CN2' });

    const mine = await letan.get('/api/reception/shifts/current');
    const theirs = await other.get('/api/reception/shifts/current');

    expect(mine.body.session.receptionistName).toBe('Người CN1');
    expect(mine.body.session.branchId).toBe(cn1);
    expect(theirs.body.session.receptionistName).toBe('Người CN2');
    expect(theirs.body.session.branchId).toBe(cn2);
  });

  it('closing ends the shift and asks again', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });

    const closed = await letan.post('/api/reception/shifts/close').send({});
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(1);

    const after = await letan.get('/api/reception/shifts/current');
    expect(after.body.session).toBeNull();

    // Idempotent: closing again is not an error, it just closes nothing.
    const again = await letan.post('/api/reception/shifts/close').send({});
    expect(again.body.closed).toBe(0);
  });
});

/**
 * THE GRACE RULE, OVER HTTP.
 *
 * `promptDue` is computed by the SERVER and simply rendered by the client, so
 * these assertions are the whole rule as the browser will experience it.
 */
describe('the server decides when to ask for the next shift', () => {
  beforeEach(async () => {
    await setup(hcm('2026-09-17', '06:00'));
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
  });

  it('is not due ten minutes after CHECK-IN', async () => {
    setClock({ now: () => hcm('2026-09-17', '06:10') });
    const res = await letan.get('/api/reception/shifts/current');
    expect(res.body.session.promptDue).toBe(false);
  });

  it('is not due at 14:09:59', async () => {
    setClock({ now: () => new Date(Date.parse('2026-09-17T14:09:59.000Z') - 7 * 60 * 60 * 1000) });
    const res = await letan.get('/api/reception/shifts/current');
    expect(res.body.session.promptDue).toBe(false);
  });

  it('is due at 14:10:00', async () => {
    setClock({ now: () => new Date(Date.parse('2026-09-17T14:10:00.000Z') - 7 * 60 * 60 * 1000) });
    const res = await letan.get('/api/reception/shifts/current');
    expect(res.body.session.promptDue).toBe(true);
  });

  /**
   * An expired shift is still OPEN. It has to be: it remains the answer to "who
   * is on the desk?" until somebody checks in again, and dropping it would leave
   * a working receptionist unable to submit an order they had already created.
   */
  it('an expired shift stays open and still names the receptionist', async () => {
    setClock({ now: () => hcm('2026-09-17', '20:00') });
    const res = await letan.get('/api/reception/shifts/current');

    expect(res.body.session).not.toBeNull();
    expect(res.body.session.promptDue).toBe(true);
    expect(res.body.session.receptionistName).toBe('Nguyễn Văn A');
    expect(res.body.session.closedAt).toBeNull();
  });
});

describe('an overnight shift behaves across midnight', () => {
  it('Ca C started at 22:00 is still quiet at 05:59 and due at 06:10 the next day', async () => {
    await setup(hcm('2026-09-17', '22:00'));
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'C', receptionistName: 'Đêm' });

    // Just before midnight — same shift, no prompt.
    setClock({ now: () => hcm('2026-09-17', '23:59') });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(false);

    // Past midnight, on the NEXT calendar day — still the same shift.
    setClock({ now: () => hcm('2026-09-18', '03:00') });
    const overnight = await letan.get('/api/reception/shifts/current');
    expect(overnight.body.session.promptDue).toBe(false);
    expect(overnight.body.session.shiftType).toBe('C');

    setClock({ now: () => new Date(Date.parse('2026-09-18T05:59:59.000Z') - 7 * 60 * 60 * 1000) });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(false);

    setClock({ now: () => new Date(Date.parse('2026-09-18T06:09:59.000Z') - 7 * 60 * 60 * 1000) });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(false);

    setClock({ now: () => new Date(Date.parse('2026-09-18T06:10:00.000Z') - 7 * 60 * 60 * 1000) });
    expect((await letan.get('/api/reception/shifts/current')).body.session.promptDue).toBe(true);
  });
});
