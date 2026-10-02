/**
 * "KHÔNG SỬA ĐƯỢC" — a technician goes, cannot fix it, and hands it back.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The incident returns to the queue — it is still broken, so it goes back
 *      in front of somebody rather than into a dead state.
 *   2. The attempt SURVIVES. Who went, their phone, when they took it, when they
 *      gave up and why are all permanent, and a later attempt cannot overwrite
 *      any of it. This is the whole reason attempts are rows and not columns.
 *   3. An incident can be worked any number of times, and every attempt remains
 *      readable afterwards — including on an incident that was eventually fixed.
 *   4. The duration is computed by the SERVER from two stored instants, and a
 *      client cannot name its own.
 *   5. Only Bộ phận kỹ thuật can do any of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import { assignTo } from './helpers/issues';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';
const TECHNICAL2_PASSWORD = 'Technical2';

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let letan: Agent;
let admin: Agent;
let tech: Agent;
let tech2: Agent;
let techId = 0;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;

  techId = (
    await createUser({
      username: 'kythuat',
      password: TECHNICAL_PASSWORD,
      fullName: 'Kỹ thuật viên A',
      role: 'TECHNICAL',
      branchId: null,
      mustChangePassword: false,
    })
  ).id;
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createUser({
    username: 'kythuat2',
    password: TECHNICAL2_PASSWORD,
    fullName: 'Kỹ thuật viên B',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech2 = (await loginAgent(app, 'kythuat2', TECHNICAL2_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-17', '15:54') });
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

/** A reported incident, ready to be accepted. */
async function reportIssue(description = 'Hello'): Promise<string> {
  const res = await letan
    .post('/api/issues')
    .field('areaCategory', 'ROOM')
    .field('roomNumber', '101')
    .field('category', 'TOILET')
    .field('description', description);
  expect(res.status).toBe(201);
  return res.body.issue.id as string;
}

/** The Admin gives the job to `agent`, who then takes it — the only way a job is taken. */
async function accept(agent: Agent, id: string, name: string, phone: string): Promise<void> {
  await assignTo(admin, id, agent);
  const res = await agent.post(`/api/issues/${id}/accept`).send({
    technicianName: name,
    technicianPhone: phone,
  });
  expect(res.status).toBe(200);
}

/* ================================================================== */
/* The transition                                                      */
/* ================================================================== */

describe('IN_PROGRESS → NEW via "Không sửa được"', () => {
  it('puts the incident back in the queue', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');

    setClock({ now: () => hcm('2026-09-17', '15:58') });
    const res = await tech
      .post(`/api/issues/${id}/cannot-repair`)
      .send({ reason: 'Không có linh kiện' });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('NEW');
    // NOT merely NEW: it carries the fact that somebody already tried, which is
    // what distinguishes it from a report nobody has opened.
    expect(res.body.issue.needsRework).toBe(true);
    expect(res.body.issue.cannotRepairCount).toBe(1);
  });

  it('requires a reason', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');

    expect((await tech.post(`/api/issues/${id}/cannot-repair`).send({})).status).toBe(422);
    expect(
      (await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: '   ' })).status,
    ).toBe(422);

    // Still IN_PROGRESS — a refused transition changes nothing.
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(issue.status).toBe('IN_PROGRESS');
    expect(await testPrisma.technicalRepairAttempt.count({ where: { outcomeAt: { not: null } } })).toBe(0);
  });

  it('refuses an incident nobody has accepted', async () => {
    const id = await reportIssue();
    // Assigned to this technician but not yet taken: there is no repair to give up.
    await assignTo(admin, id, tech);
    const res = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
    expect(res.status).toBe(409);
    // And a technician it was never given to is refused outright.
    expect((await tech2.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' })).status).toBe(403);
  });

  it('refuses an incident that is already COMPLETED', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    expect((await tech.post(`/api/issues/${id}/complete`)).status).toBe(200);

    const res = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
    expect(res.status).toBe(409);
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(issue.status).toBe('COMPLETED');
  });
});

/* ================================================================== */
/* The attempt survives                                                */
/* ================================================================== */

describe('the failed attempt is kept, permanently', () => {
  it('records the technician, the phone, both instants and the reason', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    setClock({ now: () => hcm('2026-09-17', '15:58') });
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      technicianNameSnapshot: 'Bao',
      technicianPhone: '0369852177',
      // The ACCEPTING account's own name, kept separately: the person who takes
      // the job and the person who does the work are not always the same.
      acceptedByNameSnapshot: 'Kỹ thuật viên A',
      technicianUserId: techId,
      outcome: 'CANNOT_REPAIR',
      reason: 'Không có linh kiện',
    });
    expect(attempt.acceptedAt.toISOString()).toBe(hcm('2026-09-17', '15:54').toISOString());
    expect(attempt.outcomeAt!.toISOString()).toBe(hcm('2026-09-17', '15:58').toISOString());
  });

  /**
   * FOUR MINUTES, COMPUTED FROM THE TWO INSTANTS.
   *
   * Never stored as a number of its own, and never sent by a client. A stored
   * duration is a second source of truth that can disagree with the timestamps
   * it came from; a client-supplied one lets a browser name a four-minute job as
   * forty seconds.
   */
  it('computes the duration server-side, in Vietnamese', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    setClock({ now: () => hcm('2026-09-17', '15:58') });
    const res = await tech
      .post(`/api/issues/${id}/cannot-repair`)
      .send({ reason: 'Không có linh kiện', durationSeconds: 3, durationLabel: '3 giây' });

    const attempt = res.body.issue.attempts[0];
    expect(attempt.durationSeconds).toBe(4 * 60);
    expect(attempt.durationLabel).toBe('4 phút');
  });

  it('formats seconds, minutes and hours the way the specification says', async () => {
    const cases: [string, number, string][] = [
      ['15:54:45', 45, '45 giây'],
      ['15:58:00', 4 * 60, '4 phút'],
      ['17:24:00', 90 * 60, '1 giờ 30 phút'],
      ['17:54:00', 120 * 60, '2 giờ'],
    ];
    for (const [end, seconds, label] of cases) {
      await resetIssueData();
      setClock({ now: () => hcm('2026-09-17', '15:54') });
      const id = await reportIssue();
      await accept(tech, id, 'Bao', '0369852177');
      setClock({ now: () => new Date(hcm('2026-09-17', '15:54').getTime() + seconds * 1000) });
      const res = await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
      expect(res.body.issue.attempts[0].durationLabel, `${end} → ${label}`).toBe(label);
    }
  });

  /**
   * THE CASE THE WHOLE TABLE EXISTS FOR.
   *
   * Accepting OVERWRITES the incident's technician columns. If the first
   * attempt were not already a row of its own, Minh taking the job at 16:20
   * would erase the fact that Bảo spent four minutes on it and why he stopped —
   * and the report could only ever show the last person to touch it.
   */
  it('is not overwritten when somebody else accepts the incident again', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    setClock({ now: () => hcm('2026-09-17', '15:58') });
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    setClock({ now: () => hcm('2026-09-17', '16:20') });
    await accept(tech2, id, 'Minh', '0911222333');

    const attempts = await testPrisma.technicalRepairAttempt.findMany({
      where: { issueId: id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attemptNumber: 1,
      technicianNameSnapshot: 'Bao',
      technicianPhone: '0369852177',
      outcome: 'CANNOT_REPAIR',
      reason: 'Không có linh kiện',
    });
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      technicianNameSnapshot: 'Minh',
      technicianPhone: '0911222333',
      outcome: null,
    });
  });

  it('keeps every attempt on an incident that was eventually fixed', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    setClock({ now: () => hcm('2026-09-17', '15:58') });
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    setClock({ now: () => hcm('2026-09-17', '16:20') });
    await accept(tech2, id, 'Minh', '0911222333');
    setClock({ now: () => hcm('2026-09-17', '16:35') });
    const res = await tech2.post(`/api/issues/${id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('COMPLETED');
    // COMPLETED, yet the failed attempt is still right there.
    expect(res.body.issue.needsRework).toBe(false);
    expect(res.body.issue.cannotRepairCount).toBe(1);
    expect(res.body.issue.attempts).toHaveLength(2);
    expect(res.body.issue.attempts[0]).toMatchObject({
      attemptNumber: 1,
      technicianName: 'Bao',
      outcome: 'CANNOT_REPAIR',
      reason: 'Không có linh kiện',
      durationLabel: '4 phút',
    });
    expect(res.body.issue.attempts[1]).toMatchObject({
      attemptNumber: 2,
      technicianName: 'Minh',
      outcome: 'COMPLETED',
      durationLabel: '15 phút',
    });
  });

  /**
   * THE LIVE ATTEMPT COUNTS UP.
   *
   * "Đang sửa — 5 phút đã xử lý" has to be a real elapsed time, not the value it
   * had when the technician pressed accept.
   */
  it('measures an open attempt against now', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');

    setClock({ now: () => hcm('2026-09-17', '15:59') });
    const res = await tech.get(`/api/issues/${id}`);
    expect(res.body.issue.attempts[0].outcomeAt).toBeNull();
    expect(res.body.issue.attempts[0].durationLabel).toBe('5 phút');
    expect(res.body.issue.durationLabel).toBe('5 phút');
  });
});

/* ================================================================== */
/* What the incident itself carries afterwards                         */
/* ================================================================== */

describe('the incident row after a failed attempt', () => {
  it('has no live assignment — the history lives on the attempt', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    setClock({ now: () => hcm('2026-09-17', '15:58') });
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    /*
      Cleared DELIBERATELY. These columns are the CURRENT assignment: leaving
      them set would put a named technician and an acceptance time on an incident
      whose status says nobody has picked it up — "Bảo is working on this" when
      Bảo has gone. The attempt row holds all of it permanently instead.
    */
    expect(issue.status).toBe('NEW');
    expect(issue.technicianName).toBeNull();
    expect(issue.technicianPhone).toBeNull();
    expect(issue.acceptedAt).toBeNull();
    expect(issue.acceptedByUserId).toBeNull();

    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt.technicianNameSnapshot).toBe('Bao');
    expect(attempt.technicianPhone).toBe('0369852177');
  });

  /**
   * THE INCIDENT THAT WAS ALREADY IN_PROGRESS WHEN THIS TABLE ARRIVED.
   *
   * The migration deliberately backfills no attempts, so such an incident keeps
   * its technician, phone and acceptance time ONLY on its own columns — exactly
   * the columns "Không sửa được" clears. For a few hours this code closed
   * "nothing", then wiped them, and who went to the room and how long they had
   * been on it became unrecoverable.
   *
   * Simulated the only honest way: create the IN_PROGRESS state through the API,
   * then delete the attempt row to reproduce a pre-migration incident exactly.
   */
  it('keeps the technician of an incident that has no attempt row', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    // Now it looks like an incident accepted before the attempt table existed.
    await testPrisma.technicalRepairAttempt.deleteMany({ where: { issueId: id } });
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(0);

    setClock({ now: () => hcm('2026-09-17', '15:58') });
    const res = await tech
      .post(`/api/issues/${id}/cannot-repair`)
      .send({ reason: 'Không có linh kiện' });
    expect(res.status).toBe(200);

    // The facts were MOVED, not lost: every value below was already recorded by
    // the acceptance that set the columns.
    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      technicianNameSnapshot: 'Bao',
      technicianPhone: '0369852177',
      outcome: 'CANNOT_REPAIR',
      reason: 'Không có linh kiện',
    });
    expect(attempt.acceptedAt.toISOString()).toBe(hcm('2026-09-17', '15:54').toISOString());
    expect(attempt.outcomeAt!.toISOString()).toBe(hcm('2026-09-17', '15:58').toISOString());

    // And the queue therefore still says it needs somebody again.
    expect(res.body.issue.needsRework).toBe(true);
    expect(res.body.issue.cannotRepairCount).toBe(1);
    expect(res.body.issue.attempts).toHaveLength(1);
  });

  it('keeps the technician of a legacy incident that is COMPLETED instead', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    await testPrisma.technicalRepairAttempt.deleteMany({ where: { issueId: id } });

    setClock({ now: () => hcm('2026-09-17', '15:59') });
    expect((await tech.post(`/api/issues/${id}/complete`)).status).toBe(200);

    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({ where: { issueId: id } });
    expect(attempt).toMatchObject({
      technicianNameSnapshot: 'Bao',
      outcome: 'COMPLETED',
      reason: null,
    });
  });

  /**
   * Nothing is invented for an incident nobody worked.
   *
   * The fallback above exists to preserve facts the acceptance recorded. Where
   * there was no acceptance there are no facts, and manufacturing an attempt
   * would be exactly the invented history the migration refuses to create.
   */
  it('creates no attempt when the incident names nobody', async () => {
    const id = await reportIssue();
    // Straight to IN_PROGRESS with no technician — a shape the API cannot
    // produce, forced here to prove the fallback is guarded.
    // (Assigned to the technician, so the job is theirs to close.)
    await testPrisma.hotelIssue.update({ where: { id }, data: { status: 'IN_PROGRESS', assignedTechnicianUserId: techId } });

    expect((await tech.post(`/api/issues/${id}/complete`)).status).toBe(200);
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(0);
    // And it is CLOSED — never parked in a queue it could not leave.
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(issue.status).toBe('COMPLETED');
  });

  /**
   * A REPORT THAT HAS BEEN WORKED CAN STILL BE CORRECTED — BUT NOT SILENTLY.
   *
   * "Không sửa được" returns the incident to NEW. The desk may correct what the
   * report says ("Sửa vấn đề"), and the repair history, the attempt and the
   * original wording all survive: the words that were replaced are kept in
   * HotelIssueEdit, so a technician who went against the old description can
   * always be shown it.
   */
  it('can still be corrected by the reporter, keeping the attempt and the old words', async () => {
    const id = await reportIssue('Nhà vệ sinh tắc');
    await accept(tech, id, 'Bao', '0369852177');
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    const res = await letan.put(`/api/issues/${id}`).send({ description: 'Đổi mô tả' });
    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('NEW');
    expect(res.body.issue.attempts).toHaveLength(1);
    expect(res.body.issue.edits).toEqual([
      expect.objectContaining({ field: 'description', oldValue: 'Nhà vệ sinh tắc', newValue: 'Đổi mô tả' }),
    ]);
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } });
    expect(issue.description).toBe('Đổi mô tả');
    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(1);
  });

  it('notifies the reporter that it came back, and why', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
    await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'Không có linh kiện' });

    // Newest first: earlier tests in this file leave the same-titled row behind.
    const notification = await testPrisma.notification.findFirstOrThrow({
      where: { title: 'Sự cố chưa sửa được, đang chờ xử lý lại' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notification.body).toContain('Không có linh kiện');
  });
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('only Bộ phận kỹ thuật may report "Không sửa được"', () => {
  let id = '';
  beforeEach(async () => {
    id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');
  });

  it('refuses an Admin — monitoring is not doing the work', async () => {
    const res = await admin.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect((await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');
  });

  it('refuses the receptionist who reported it', async () => {
    const res = await letan.post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).post(`/api/issues/${id}/cannot-repair`).send({ reason: 'x' });
    expect(res.status).toBe(401);
  });

  /**
   * A CLIENT CANNOT NAME THE TECHNICIAN IT IS NOT.
   *
   * The accepting account is taken from the session; the technician name and
   * phone are what the form asked for and are stored as typed. Nothing in the
   * request can claim a different ACCOUNT did the accepting.
   */
  it('ignores a client-supplied acting account', async () => {
    await resetIssueData();
    const fresh = await reportIssue();
    await assignTo(admin, fresh, tech2);
    await tech2.post(`/api/issues/${fresh}/accept`).send({
      technicianName: 'Minh',
      technicianPhone: '0911222333',
      technicianUserId: techId,
      acceptedByNameSnapshot: 'Kỹ thuật viên A',
    });

    const attempt = await testPrisma.technicalRepairAttempt.findFirstOrThrow({
      where: { issueId: fresh },
    });
    expect(attempt.technicianUserId).not.toBe(techId);
    expect(attempt.acceptedByNameSnapshot).toBe('Kỹ thuật viên B');
  });
});

/* ================================================================== */
/* Concurrency                                                         */
/* ================================================================== */

describe('the database refuses two live attempts on one incident', () => {
  it('has a partial unique index over open attempts', async () => {
    const id = await reportIssue();
    await accept(tech, id, 'Bao', '0369852177');

    await expect(
      testPrisma.technicalRepairAttempt.create({
        data: {
          issueId: id,
          attemptNumber: 99,
          technicianNameSnapshot: 'Kẻ chen ngang',
          technicianPhone: '0000000000',
          acceptedAt: hcm('2026-09-17', '15:55'),
        },
      }),
    ).rejects.toThrow();

    expect(await testPrisma.technicalRepairAttempt.count({ where: { issueId: id } })).toBe(1);
  });

  it('allows any number of CLOSED attempts', async () => {
    const id = await reportIssue();
    for (let i = 0; i < 3; i += 1) {
      setClock({ now: () => hcm('2026-09-17', `16:0${i}`) });
      await accept(tech, id, `Thợ ${i}`, '0900000000');
      setClock({ now: () => hcm('2026-09-17', `16:1${i}`) });
      await tech.post(`/api/issues/${id}/cannot-repair`).send({ reason: `lần ${i}` });
    }
    const attempts = await testPrisma.technicalRepairAttempt.findMany({ where: { issueId: id } });
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attemptNumber).sort()).toEqual([1, 2, 3]);
  });
});
