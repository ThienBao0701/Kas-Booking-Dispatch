/**
 * THE DEVELOPMENT TOOLS, AGAINST THE RECEPTION JOURNAL.
 *
 * WHY THIS FILE EXISTS
 *
 * "Sự cố cơ sở vật chất" holds a RESTRICT reference from `FacilityIssueReport`
 * to `HotelIssue`, on purpose: an incident disappearing must not silently take
 * the journal entry that reported it. The cost of that decision is that every
 * `hotelIssue.deleteMany()` in the codebase becomes a P2003 the moment one such
 * entry exists — and two of them live in tools that are run by hand, rarely, and
 * at exactly the wrong moment to discover a new foreign key:
 *
 *   clearDemoData()        wipes generated demo data in development
 *   prepareForProduction() wipes ALL operational data before an official launch
 *
 * A failure in either is silent until somebody runs it. So both are exercised
 * here WITH a journal entry present, which is the case that breaks them.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  loginAgent,
} from './helpers/auth';
import { clearDemoData } from '../src/devtest/demoFactory';
import { prepareForProduction } from '../src/devtest/prepareProduction';
import { ensureTestReceptionist } from '../src/devtest/testAccount';
import { env, ISSUE_UPLOAD_DIR, PROOF_UPLOAD_DIR } from '../src/config/env';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

const scratch = path.join(__dirname, '..', '.tmp', 'operational-devtool-tests');

let cn1 = 0;
let adminId = 0;
let letan: Agent;

beforeEach(async () => {
  await resetAll();
  await testPrisma.demoDataBatch.deleteMany({});
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  setClock({ now: () => hcm('2026-09-19', '08:00') });
  const checkIn = await letan
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
  expect(checkIn.status).toBe(201);
});

afterAll(async () => {
  resetClock();
  await resetAll();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A real incident, reported through the real form, and a journal entry on it. */
async function journalEntryOnIncident(isDemo = false) {
  const issue = await letan.post('/api/issues').send({
    areaCategory: 'ROOM',
    roomNumber: '101',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không mát',
  });
  expect(issue.status).toBe(201);
  const issueId = issue.body.issue.id as string;

  if (isDemo) {
    // The demo factory's own marker, set here so the fixture is one incident
    // rather than a whole generated batch.
    await testPrisma.hotelIssue.update({ where: { id: issueId }, data: { isDemo: true } });
  }

  const report = await letan
    .post('/api/reception/reports')
    .send({ category: 'FACILITY_ISSUE', facility: { issueId } });
  expect(report.status).toBe(201);
  return { issueId, reportId: report.body.report.id as string };
}

describe('clearDemoData', () => {
  it('removes a journal entry that referenced a demo incident, and the incident with it', async () => {
    const { issueId, reportId } = await journalEntryOnIncident(true);

    const summary = await clearDemoData(testPrisma);
    expect(summary.issuesDeleted).toBe(1);
    expect(summary.operationalReportsDeleted).toBe(1);

    expect(await testPrisma.hotelIssue.count({ where: { id: issueId } })).toBe(0);
    expect(await testPrisma.receptionOperationalReport.count({ where: { id: reportId } })).toBe(0);
    // The detail row went with its parent, by cascade.
    expect(await testPrisma.facilityIssueReport.count()).toBe(0);
  });

  it('leaves a REAL journal entry, and the real incident, completely alone', async () => {
    const real = await journalEntryOnIncident(false);
    const demo = await journalEntryOnIncident(true);

    const summary = await clearDemoData(testPrisma);
    expect(summary.operationalReportsDeleted).toBe(1);

    expect(await testPrisma.hotelIssue.count({ where: { id: real.issueId } })).toBe(1);
    expect(await testPrisma.receptionOperationalReport.count({ where: { id: real.reportId } })).toBe(1);
    expect(await testPrisma.hotelIssue.count({ where: { id: demo.issueId } })).toBe(0);
  });

  it('leaves a payment untouched — it references no incident', async () => {
    await journalEntryOnIncident(true);
    const payment = await letan
      .post('/api/reception/reports')
      .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 300000 } });
    expect(payment.status).toBe(201);

    await clearDemoData(testPrisma);
    expect(await testPrisma.receptionPayment.count()).toBe(1);
  });
});

describe('prepareForProduction', () => {
  it('clears the journal instead of throwing on the incident it references', async () => {
    await journalEntryOnIncident(false);
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    const payment = await letan
      .post('/api/reception/reports')
      .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 300000 } });
    expect(payment.status).toBe(201);
    await ensureTestReceptionist(testPrisma);

    expect(await testPrisma.receptionOperationalReport.count()).toBe(2);
    // The "Tiền đầu ca" audit row belongs to the SHIFT, so it cascades from
    // nothing — the case that would leave development cash counts behind.
    expect(await testPrisma.receptionReportAudit.count({ where: { reportId: null } })).toBe(1);

    const manifest = await prepareForProduction({
      confirmed: true,
      databaseUrl: env.DATABASE_URL,
      uploadDirs: [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR],
      backupRoot: path.join(scratch, 'bk'),
      client: testPrisma,
    });

    expect(manifest.before.operationalReports).toBe(2);
    // Every counted table is empty afterwards, this one included.
    for (const count of Object.values(manifest.after)) expect(count).toBe(0);

    expect(await testPrisma.hotelIssue.count()).toBe(0);
    expect(await testPrisma.receptionOperationalReport.count()).toBe(0);
    expect(await testPrisma.receptionPayment.count()).toBe(0);
    expect(await testPrisma.facilityIssueReport.count()).toBe(0);
    expect(await testPrisma.receptionReportAudit.count()).toBe(0);

    // And the things it must preserve are still there.
    expect(await testPrisma.branch.count()).toBeGreaterThan(0);
    expect(await testPrisma.user.count({ where: { id: adminId } })).toBe(1);
  });
});
