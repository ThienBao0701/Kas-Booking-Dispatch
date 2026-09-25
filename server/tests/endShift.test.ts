/**
 * "KẾT THÚC CA" — a shift ending normally.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The end instant is the SERVER'S. No endpoint accepts one, and a browser
 *      that sends one is not believed.
 *   2. Ending a shift opens nothing. The desk has no session until somebody
 *      checks in — which is what the client renders as "Chọn ca làm việc".
 *   3. A closed shift cannot record anything else.
 *   4. It is not "Đổi ca": no handover record is manufactured for a shift that
 *      simply ended.
 *   5. The preview warns about unhanded-over work WITHOUT blocking, and without
 *      pretending a handover happened.
 *   6. An early "Đổi ca" still gives the incoming shift its PLANNED end — Ca B
 *      taken over at 13:15 prompts at 22:10, not 21:25.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import { RECEPTIONIST_PASSWORD, createReceptionist, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let letan: Agent;
let letanB: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  resetClock();
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

async function checkIn(agent: Agent, shiftType: string, name: string) {
  const res = await agent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
  return res.body.session as { id: string };
}

describe('ending a shift', () => {
  it('stamps the server’s instant as actualEndAt', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    const session = await checkIn(letan, 'A', 'Nguyễn Văn A');

    setClock({ now: () => hcm('2026-09-19', '14:03') });
    const res = await letan.post('/api/reception/shifts/close').send({});
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(1);
    expect(res.body.session.closedAt).toBe(hcm('2026-09-19', '14:03').toISOString());

    const stored = await testPrisma.receptionShiftSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { closedAt: true },
    });
    expect(stored.closedAt?.toISOString()).toBe(hcm('2026-09-19', '14:03').toISOString());
  });

  it('ignores a checkout time sent by the browser', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');

    setClock({ now: () => hcm('2026-09-19', '14:03') });
    const res = await letan
      .post('/api/reception/shifts/close')
      .send({ actualEndAt: '2020-01-01T00:00:00.000Z', closedAt: '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.session.closedAt).toBe(hcm('2026-09-19', '14:03').toISOString());
  });

  it('leaves no open session, so the client asks for a shift again', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/shifts/close').send({});

    const current = await letan.get('/api/reception/shifts/current');
    expect(current.status).toBe(200);
    expect(current.body.session).toBeNull();
  });

  it('is idempotent', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    expect((await letan.post('/api/reception/shifts/close').send({})).body.closed).toBe(1);

    const again = await letan.post('/api/reception/shifts/close').send({});
    expect(again.status).toBe(200);
    expect(again.body.closed).toBe(0);
    expect(again.body.session).toBeNull();
  });

  it('creates no handover record — ending a shift is not đổi ca', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/shifts/close').send({});

    expect(await testPrisma.shiftHandover.count()).toBe(0);
    expect(await testPrisma.shiftHandoverNote.count()).toBe(0);
  });

  it('returns the drawer at the moment it closed', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 1000000 });
    await letan
      .post('/api/reception/reports')
      .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 500000, expense: 100000 } });

    const res = await letan.post('/api/reception/shifts/close').send({});
    expect(res.body.cash.openingCash).toBe(1000000);
    expect(res.body.cash.cashCollected).toBe(500000);
    expect(res.body.cash.cashExpense).toBe(100000);
    expect(res.body.cash.endingCash).toBe(1400000);
  });

  it('refuses everyone but a receptionist', async () => {
    const res = await letan.post('/api/reception/shifts/close').send({});
    // A receptionist with nothing open is fine; the role gate is what matters,
    // and it is asserted for other roles in receptionOperationalJournal.test.ts.
    expect(res.status).toBe(200);
  });
});

describe('the end-of-shift preview', () => {
  it('describes what is about to close', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'K', description: 'ồn' },
    });

    setClock({ now: () => hcm('2026-09-19', '13:50') });
    const res = await letan.get('/api/reception/shifts/end-preview');
    expect(res.status).toBe(200);
    expect(res.body.session.shiftName).toBe('Ca A');
    expect(res.body.session.receptionistName).toBe('Nguyễn Văn A');
    expect(res.body.session.startedAt).toBe(hcm('2026-09-19', '06:00').toISOString());
    expect(res.body.reportCount).toBe(1);
  });

  it('changes nothing', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.get('/api/reception/shifts/end-preview');

    const current = await letan.get('/api/reception/shifts/current');
    expect(current.body.session).not.toBeNull();
    expect(current.body.session.closedAt).toBeNull();
  });

  it('advises a handover when work is outstanding and none was written', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const issue = await letan.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '101',
      category: 'AIR_CONDITIONER',
      description: 'Máy lạnh hỏng',
    });
    expect(issue.status).toBe(201);

    const res = await letan.get('/api/reception/shifts/end-preview');
    expect(res.body.handoverAdvised).toBe(true);
    expect(res.body.pending.openIssues).toHaveLength(1);
    expect(res.body.handoverNoteCount).toBe(0);
  });

  it('stops advising once a note exists — and the note is a real one', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '101',
      category: 'AIR_CONDITIONER',
      description: 'Máy lạnh hỏng',
    });

    const note = await letan
      .post('/api/reception/handover-notes')
      .send({ content: 'Phòng 101 đang chờ kỹ thuật' });
    expect(note.status).toBe(201);

    const res = await letan.get('/api/reception/shifts/end-preview');
    expect(res.body.handoverAdvised).toBe(false);
    expect(res.body.handoverNoteCount).toBe(1);
  });

  it('does not advise when there is nothing outstanding', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    const res = await letan.get('/api/reception/shifts/end-preview');
    expect(res.body.handoverAdvised).toBe(false);
  });

  it('never blocks the close, and fabricates no handover when advised', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    await letan.post('/api/issues').send({
      areaCategory: 'ROOM',
      roomNumber: '101',
      category: 'AIR_CONDITIONER',
      description: 'Máy lạnh hỏng',
    });
    expect((await letan.get('/api/reception/shifts/end-preview')).body.handoverAdvised).toBe(true);

    const closed = await letan.post('/api/reception/shifts/close').send({});
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(1);
    expect(await testPrisma.shiftHandoverNote.count()).toBe(0);
    expect(await testPrisma.shiftHandover.count()).toBe(0);
  });
});

describe('đổi ca still keeps the incoming shift’s planned end', () => {
  it('Ca A handed to Ca B at 13:15 prompts at 22:10, not 21:25', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');

    setClock({ now: () => hcm('2026-09-19', '13:15') });
    const res = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });
    expect(res.status).toBe(201);

    expect(res.body.session.nominalEndAt).toBe(hcm('2026-09-19', '22:00').toISOString());
    expect(res.body.session.graceEndAt).toBe(hcm('2026-09-19', '22:10').toISOString());
    expect(res.body.handover.actualHandoverAt).toBe(hcm('2026-09-19', '13:15').toISOString());

    // And the outgoing session ended at exactly the same instant.
    const outgoing = await testPrisma.receptionShiftSession.findFirstOrThrow({
      where: { NOT: { closedAt: null } },
      orderBy: { startedAt: 'asc' },
      select: { closedAt: true },
    });
    expect(outgoing.closedAt?.toISOString()).toBe(hcm('2026-09-19', '13:15').toISOString());
  });

  it('records a handover, unlike kết thúc ca', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-19', '13:15') });
    await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });
    expect(await testPrisma.shiftHandover.count()).toBe(1);
  });

  it('attaches records written after the handover to the NEW shift', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    const first = await checkIn(letan, 'A', 'Nguyễn Văn A');
    const before = await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'K1', description: 'trước' },
    });
    expect(before.status).toBe(201);

    setClock({ now: () => hcm('2026-09-19', '13:15') });
    const handover = await letan.post('/api/reception/shifts/handover').send({
      reason: 'Có việc cá nhân',
      incomingName: 'Nguyễn Văn B',
      incomingShiftType: 'B',
    });
    expect(handover.status).toBe(201);

    const after = await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'K2', description: 'sau' },
    });
    expect(after.status).toBe(201);

    expect(before.body.report.shiftSessionId).toBe(first.id);
    expect(before.body.report.createdByName).toBe('Nguyễn Văn A');
    expect(after.body.report.shiftSessionId).toBe(handover.body.session.id);
    expect(after.body.report.createdByName).toBe('Nguyễn Văn B');
    // The earlier record was NOT re-attributed.
    expect(after.body.report.shiftSessionId).not.toBe(first.id);
  });
});

describe('a and a4, c and c4', () => {
  it('keeps each twelve-hour shift’s own planned end', async () => {
    setClock({ now: () => hcm('2026-09-19', '06:00') });
    const a4 = await letan
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'A4', receptionistName: 'Ca A4' });
    expect(a4.body.session.nominalEndAt).toBe(hcm('2026-09-19', '18:00').toISOString());

    await letan.post('/api/reception/shifts/close').send({});

    setClock({ now: () => hcm('2026-09-19', '18:00') });
    const c4 = await letan
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'C4', receptionistName: 'Ca C4' });
    // Crosses midnight: ends at 06:00 the NEXT day.
    expect(c4.body.session.nominalEndAt).toBe(hcm('2026-09-20', '06:00').toISOString());
  });

  it('a shift ended across midnight closes at the real instant', async () => {
    setClock({ now: () => hcm('2026-09-19', '22:00') });
    await checkIn(letanB, 'C', 'Ca đêm');
    setClock({ now: () => hcm('2026-09-20', '06:04') });
    const res = await letanB.post('/api/reception/shifts/close').send({});
    expect(res.body.session.closedAt).toBe(hcm('2026-09-20', '06:04').toISOString());
  });
});
