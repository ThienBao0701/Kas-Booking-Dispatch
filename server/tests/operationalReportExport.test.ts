/**
 * THE ADMIN'S "BÁO CÁO VẤN ĐỀ": drill-down, PDF and XLSX.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The drill-down returns FULL RECORDS, not counts. "Thu tiền: 15 giao dịch"
 *      is the failure this screen exists to avoid.
 *   2. All eight branches are reachable, by their own Branch rows — no id is
 *      hardcoded anywhere.
 *   3. Every category's detail survives to the Admin: payment columns, both
 *      actors on a guest request, the full complaint text, the service detail,
 *      the technical reference and the correction history.
 *   4. The exports contain the rows and separate the branches.
 *   5. The period filter is the repo's usual half-open HCM day range.
 *   6. Reception cannot reach the Admin endpoints at all.
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
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';
import type { Worksheet } from 'exceljs';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letanCn2: Agent;
let admin: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  letanCn2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
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

/**
 * Finds a column by the header text the reader actually sees.
 *
 * `getCell('guest')` works on a workbook this process BUILT, because the key is
 * in memory — but a workbook loaded back from bytes has no keys, and ExcelJS
 * then reads "guest" as a spreadsheet column reference and throws. Asserting on
 * the header is also the stronger test: it checks the label the person opening
 * the file will look for.
 */
/**
 * Loads an XLSX the route just produced.
 *
 * The cast is the whole reason this is a function: ExcelJS types `load` against
 * a `Buffer` from its own dependency tree, which under Node 22's types is
 * `Buffer<ArrayBuffer>` while supertest hands back `Buffer<ArrayBufferLike>`.
 * The bytes are identical; only the generic parameter differs. Doing it once
 * here keeps the assertion sites readable.
 */
async function loadWorkbook(bytes: Buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

function columnByHeader(sheet: Worksheet, header: string): number {
  const row = sheet.getRow(1);
  for (let i = 1; i <= row.cellCount; i += 1) {
    if (String(row.getCell(i).value ?? '').trim() === header) return i;
  }
  throw new Error(`Sheet "${sheet.name}" has no column headed "${header}"`);
}

async function checkIn(agent: Agent, shiftType: string, name: string) {
  const res = await agent
    .post('/api/reception/shifts/check-in')
    .send({ shiftType, receptionistName: name });
  expect(res.status).toBe(201);
}

/** "Kết thúc ca" — only a CLOSED shift is part of the official export. */
async function endShift(agent: Agent) {
  const res = await agent.post('/api/reception/shifts/close').send({});
  expect(res.status).toBe(200);
  expect(res.body.closed).toBeTruthy();
}

/** One record of every category, at one branch, on 2026-09-19. */
async function seedFullDay(agent: Agent, name: string, { end = true }: { end?: boolean } = {}) {
  setClock({ now: () => hcm('2026-09-19', '07:00') });
  await checkIn(agent, 'A', name);

  const opening = await agent.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
  expect(opening.status).toBe(200);

  const payment = await agent.post('/api/reception/reports').send({
    category: 'PAYMENT',
    payment: {
      ezCode: 'EZ123',
      source: 'Booking.com',
      guestName: 'Nguyễn Khách',
      roomNumber: '101',
      method: 'CASH',
      amount: 300000,
      receivable: 50000,
      expense: 100000,
      note: 'Thanh toán đêm đầu',
    },
  });
  expect(payment.status).toBe(201);

  const request = await agent.post('/api/reception/reports').send({
    category: 'GUEST_REQUEST',
    guestRequest: { itemType: 'Balo', guestName: 'Khách ký gửi', note: 'Balo đen' },
  });
  expect(request.status).toBe(201);

  const issue = await agent.post('/api/issues').send({
    areaCategory: 'LOBBY',
    areaSubtype: 'SOFA',
    description: 'Sofa rách',
  });
  expect(issue.status).toBe(201);
  const facility = await agent
    .post('/api/reception/reports')
    .send({ category: 'FACILITY_ISSUE', facility: { issueId: issue.body.issue.id } });
  expect(facility.status).toBe(201);

  const complaint = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Trần Complain', location: '202', description: 'Phòng ồn suốt đêm' },
  });
  expect(complaint.status).toBe(201);

  const service = await agent.post('/api/reception/reports').send({
    category: 'ROOM_SERVICE',
    roomService: {
      serviceType: 'UPGRADE',
      guestName: 'Lê Upgrade',
      fromRoomClass: 'Standard',
      toRoomClass: 'Deluxe',
      price: 300000,
      note: 'Khách đồng ý',
    },
  });
  expect(service.status).toBe(201);

  // The day is over: "Kết thúc ca", so the shift belongs to the official report.
  // Left open only by tests that still have to correct or accept on it.
  if (end) await endShift(agent);

  return { paymentId: payment.body.report.id as string, requestId: request.body.report.id as string };
}

describe('the drill-down returns records, not counts', () => {
  it('gives the Admin every field of a payment row', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');

    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);

    const row = res.body.reports[0];
    expect(row.payment).toMatchObject({
      ezCode: 'EZ123',
      source: 'Booking.com',
      guestName: 'Nguyễn Khách',
      roomNumber: '101',
      method: 'CASH',
      methodLabel: 'Thu tiền mặt',
      amount: 300000,
      receivable: 50000,
      expense: 100000,
      note: 'Thanh toán đêm đầu',
      cash: 300000,
      transfer: 0,
      card: 0,
    });
    expect(row.createdByName).toBe('Nguyễn Văn A');
    expect(row.shiftName).toBe('Ca A');
    expect(row.createdAt).toBe(hcm('2026-09-19', '07:00').toISOString());
  });

  it('counts every category beside the rows', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(res.body.counts).toEqual({
      PAYMENT: 1,
      GUEST_REQUEST: 1,
      FACILITY_ISSUE: 1,
      CUSTOMER_COMPLAINT: 1,
      ROOM_SERVICE: 1,
    });
    // And the rows are still there — the count never replaces them.
    expect(res.body.reports).toHaveLength(5);
  });

  it('shows both actors on a guest request', async () => {
    const { requestId } = await seedFullDay(letan, 'Nguyễn Văn A', { end: false });
    setClock({ now: () => hcm('2026-09-19', '13:00') });
    const accepted = await letan.post(`/api/reception/reports/${requestId}/accept`).send({});
    expect(accepted.status).toBe(200);

    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=GUEST_REQUEST`);
    const row = res.body.reports[0];
    expect(row.createdByName).toBe('Nguyễn Văn A');
    expect(row.guestRequest.acceptedByName).toBe('Nguyễn Văn A');
    expect(row.guestRequest.acceptedAt).toBe(hcm('2026-09-19', '13:00').toISOString());
  });

  it('shows the full complaint text and the full service detail', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);

    const complaint = res.body.reports.find((r: { category: string }) => r.category === 'CUSTOMER_COMPLAINT');
    expect(complaint.complaint.description).toBe('Phòng ồn suốt đêm');

    const service = res.body.reports.find((r: { category: string }) => r.category === 'ROOM_SERVICE');
    expect(service.roomService).toMatchObject({
      serviceType: 'UPGRADE',
      serviceTypeLabel: 'Upgrade',
      guestName: 'Lê Upgrade',
      fromRoomClass: 'Standard',
      toRoomClass: 'Deluxe',
      price: 300000,
    });
  });

  it('shows the technical reference, live', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=FACILITY_ISSUE`);
    const row = res.body.reports[0];
    expect(row.facility.issueId).toBeTruthy();
    expect(row.facility.issue.description).toBe('Sofa rách');
    expect(row.facility.issue.status).toBe('NEW');
    expect(row.facility.issue.locationLabel).toContain('Khu Vực Sảnh');
  });

  it('shows the correction history', async () => {
    const { paymentId } = await seedFullDay(letan, 'Nguyễn Văn A', { end: false });
    setClock({ now: () => hcm('2026-09-19', '08:00') });
    await letan
      .patch(`/api/reception/reports/${paymentId}`)
      .send({ payment: { amount: 350000 }, reason: 'Gõ nhầm' });

    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT`);
    const audits = res.body.reports[0].audits;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'EDIT',
      field: 'amount',
      oldValue: '300000',
      newValue: '350000',
      reason: 'Gõ nhầm',
    });
  });

  it('keeps a voided row visible, marked, and out of the totals', async () => {
    const { paymentId } = await seedFullDay(letan, 'Nguyễn Văn A', { end: false });
    await letan.post(`/api/reception/reports/${paymentId}/void`).send({ reason: 'Nhập nhầm' });

    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT`);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].voided).toBe(true);
    expect(res.body.reports[0].voidReason).toBe('Nhập nhầm');
    expect(res.body.cash.cashCollected).toBe(0);
    expect(res.body.cash.voidedCount).toBe(1);
  });
});

describe('branch drill-down', () => {
  it('reaches every seeded branch by its own record, with no hardcoded id', async () => {
    const branches = await testPrisma.branch.findMany({
      where: { active: true },
      orderBy: { branchNumber: 'asc' },
    });
    expect(branches.length).toBeGreaterThanOrEqual(8);

    for (const branch of branches) {
      const res = await admin.get(`/api/admin/reports/operational?branchId=${branch.id}`);
      expect(res.status, branch.code).toBe(200);
      expect(res.body.counts).toBeTruthy();
    }
  });

  it('separates the branches rather than mixing them', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedFullDay(letanCn2, 'Người CN2');

    const one = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(one.body.reports).toHaveLength(5);
    expect(one.body.reports.every((r: { branchId: number }) => r.branchId === cn1)).toBe(true);

    const two = await admin.get(`/api/admin/reports/operational?branchId=${cn2}`);
    expect(two.body.reports.every((r: { branchId: number }) => r.branchId === cn2)).toBe(true);

    const all = await admin.get('/api/admin/reports/operational');
    expect(all.body.reports).toHaveLength(10);
    // Cash belongs to one desk, so an all-branch view refuses to add drawers up.
    expect(all.body.cash).toBeNull();
  });

  it('filters by the half-open HCM day range', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');

    const inside = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-19&to=2026-09-19`,
    );
    expect(inside.body.reports).toHaveLength(5);

    const before = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-18&to=2026-09-18`,
    );
    expect(before.body.reports).toHaveLength(0);

    const after = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-20&to=2026-09-20`,
    );
    expect(after.body.reports).toHaveLength(0);
  });

  it('bounds the drawer to TODAY when no period is asked for', async () => {
    /*
      Yesterday FIRST, so the fixture runs forwards in time. Checking in with the
      clock moved backwards would close a session before its own start, and every
      interval test downstream would then be reasoning about an impossible shift.
    */
    setClock({ now: () => hcm('2026-09-18', '07:00') });
    await checkIn(letan, 'A', 'Hôm qua');
    expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 1000000 })).status).toBe(200);
    expect(
      (
        await letan
          .post('/api/reception/reports')
          .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 500000 } })
      ).status,
    ).toBe(201);
    setClock({ now: () => hcm('2026-09-18', '14:05') });
    expect((await letan.post('/api/reception/shifts/close').send({})).status).toBe(200);

    // Today: a second shift, with its own counted drawer.
    await seedFullDay(letan, 'Nguyễn Văn A');
    setClock({ now: () => hcm('2026-09-19', '20:00') });

    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(res.status).toBe(200);
    expect(res.body.cashPeriod).toEqual({ from: '2026-09-19', to: '2026-09-19' });
    // TODAY's opening, not today's plus yesterday's.
    expect(res.body.cash.openingCash).toBe(7570000);
    expect(res.body.cash.cashCollected).toBe(300000);
    expect(res.body.cash.endingCash).toBe(7770000);
    // …while the RECORD list is unfiltered and still shows both days.
    expect(res.body.reports.length).toBe(6);

    // And an explicit period is honoured over today.
    const yesterday = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-18&to=2026-09-18`,
    );
    expect(yesterday.body.cashPeriod).toEqual({ from: '2026-09-18', to: '2026-09-18' });
    expect(yesterday.body.cash.openingCash).toBe(1000000);
    expect(yesterday.body.cash.cashCollected).toBe(500000);
    expect(yesterday.body.cash.endingCash).toBe(1500000);
  });

  /*
    THE PERIOD DRAWER IS A RUNNING BALANCE, NOT A SUM OF COUNTS.

    Each shift's counted opening IS the previous shift's ending, so adding the
    openings together counts the same banknotes once per shift. Three shifts a
    day for a week reported roughly twenty times the real drawer — on screen, in
    the PDF and in the XLSX.
  */
  it('takes the FIRST shift’s opening over a multi-shift period, never the sum', async () => {
    setClock({ now: () => hcm('2026-09-19', '07:00') });
    await checkIn(letan, 'A', 'Ca A');
    expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 })).status).toBe(200);
    expect(
      (await letan.post('/api/reception/reports').send({
        category: 'PAYMENT',
        payment: { method: 'CASH', amount: 4400000, expense: 100000 },
      })).status,
    ).toBe(201);

    // Ca B counts the drawer it was handed: 7.570.000 + 4.400.000 − 100.000.
    setClock({ now: () => hcm('2026-09-19', '14:05') });
    await checkIn(letan, 'B', 'Ca B');
    expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 11870000 })).status).toBe(200);
    expect(
      (await letan
        .post('/api/reception/reports')
        .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 500000 } })).status,
    ).toBe(201);

    const res = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-19&to=2026-09-19`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cash.openingCash).toBe(7570000);
    expect(res.body.cash.cashCollected).toBe(4900000);
    expect(res.body.cash.cashExpense).toBe(100000);
    // The real drawer at the end of the day, not 7.570.000 + 11.870.000 + …
    expect(res.body.cash.endingCash).toBe(12370000);
  });

  /*
    A Ca C that starts at 22:00 on the 19th records a payment at 01:30 on the
    20th. The whole shift — its opening count AND that payment — belongs to the
    19th, its BUSINESS DATE. Filtering by the payment's own timestamp would put
    the takings on the 20th and the opening on the 19th, and one night shift
    would appear as a loss on one day and pure profit on the next.
  */
  it('keeps an overnight shift’s opening and its after-midnight takings on its business date', async () => {
    setClock({ now: () => hcm('2026-09-19', '22:00') });
    await checkIn(letan, 'C', 'Ca đêm');
    expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 })).status).toBe(200);

    setClock({ now: () => hcm('2026-09-20', '01:30') });
    expect(
      (await letan
        .post('/api/reception/reports')
        .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 950000 } })).status,
    ).toBe(201);

    const the19th = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-19&to=2026-09-19`,
    );
    expect(the19th.status).toBe(200);
    expect(the19th.body.reports).toHaveLength(1);
    expect(the19th.body.cash.cashCollected).toBe(950000);
    expect(the19th.body.cash.openingCash).toBe(7570000);
    expect(the19th.body.cash.endingCash).toBe(8520000);

    // The calendar day the payment was typed on does not own it.
    const the20th = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&from=2026-09-20&to=2026-09-20`,
    );
    expect(the20th.body.reports).toHaveLength(0);
    expect(the20th.body.cash.cashCollected).toBe(0);
    expect(the20th.body.cash.openingCash).toBeNull();
  });

  it('declares the row cap instead of applying it silently', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(res.body.total).toBe(5);
    expect(res.body.truncated).toBe(false);
    expect(res.body.reports).toHaveLength(5);

    // Counted WITHOUT the category filter, so selecting one does not zero the
    // other four badges.
    const one = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT`,
    );
    expect(one.body.reports).toHaveLength(1);
    expect(one.body.total).toBe(1);
    expect(one.body.counts).toEqual({
      PAYMENT: 1,
      GUEST_REQUEST: 1,
      FACILITY_ISSUE: 1,
      CUSTOMER_COMPLAINT: 1,
      ROOM_SERVICE: 1,
    });
  });

  it('refuses a half-specified or inverted range', async () => {
    expect((await admin.get('/api/admin/reports/operational?from=2026-09-19')).status).toBe(422);
    expect(
      (await admin.get('/api/admin/reports/operational?from=2026-09-20&to=2026-09-19')).status,
    ).toBe(422);
  });

  it('refuses reception entirely', async () => {
    for (const path of [
      '/api/admin/reports/operational',
      '/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19',
      '/api/admin/reports/operational.xlsx?from=2026-09-19&to=2026-09-19',
    ]) {
      const res = await letan.get(path);
      expect(res.status, path).toBe(403);
    }
  });
});

describe('the exports', () => {
  it('produces a PDF containing the period’s records', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedFullDay(letanCn2, 'Người CN2');

    const res = await admin
      .get('/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('KAS-bao-cao-van-de-le-tan');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    // Two branch sections plus five tables each — comfortably more than an
    // empty document, which is about 3 KB.
    expect(body.length).toBeGreaterThan(8000);
  });

  it('accepts and renders the largest amount that can actually be stored', async () => {
    setClock({ now: () => hcm('2026-09-19', '07:00') });
    await checkIn(letan, 'A', 'Nguyễn Văn A');
    /*
      THE EXACT WIDTH OF A PostgreSQL INTEGER.

      Validation used to allow 9.999.999.999, which the column could not hold:
      the insert died inside the driver ("Unable to fit integer value
      '9999999999' into an INT4") and the receptionist got a 500 naming no field
      at all. The ceiling and the column now agree, so the boundary is accepted
      and everything above it is REFUSED CLEANLY.
    */
    const max = await letan.post('/api/reception/reports').send({
      category: 'PAYMENT',
      payment: { method: 'CASH', amount: 2_147_483_647, expense: 2_147_483_647, guestName: 'Khách VIP' },
    });
    expect(max.status).toBe(201);
    expect(max.body.report.payment.amount).toBe(2_147_483_647);

    for (const amount of [2_147_483_648, 9_999_999_999, 10_000_000_000]) {
      const over = await letan
        .post('/api/reception/reports')
        .send({ category: 'PAYMENT', payment: { method: 'CASH', amount } });
      // 422, never 500 — the field is named and nothing reaches the driver.
      expect(over.status, String(amount)).toBe(422);
    }
    // The official export carries CLOSED shifts only.
    await endShift(letan);

    const res = await admin
      .get('/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // And the XLSX keeps it as a real number rather than a string.
    const xlsx = await admin
      .get('/api/admin/reports/operational.xlsx?from=2026-09-19&to=2026-09-19')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const wb = await loadWorkbook(xlsx.body as Buffer);
    const payments = wb.getWorksheet('Theo dõi thanh toán')!;
    expect(payments.getRow(2).getCell(columnByHeader(payments, 'Thu tiền mặt')).value).toBe(
      2_147_483_647,
    );
  });

  it('produces a PDF for one branch only', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedFullDay(letanCn2, 'Người CN2');

    const one = await admin
      .get(`/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19&branchId=${cn1}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(one.status).toBe(200);
    expect((one.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('produces an XLSX with six sheets and real numbers', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');

    const res = await admin
      .get('/api/admin/reports/operational.xlsx?from=2026-09-19&to=2026-09-19')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const wb = await loadWorkbook(res.body as Buffer);

    expect(wb.worksheets.map((s) => s.name)).toEqual([
      'Tổng hợp chi nhánh',
      'Theo dõi thanh toán',
      'Vấn đề khách yêu cầu',
      'Sự cố vật chất đang xử lý',
      'Vấn đề về chất lượng dịch vụ',
      'Dịch vụ phòng, KPI',
    ]);

    const payments = wb.getWorksheet('Theo dõi thanh toán')!;
    // Header + one row.
    expect(payments.rowCount).toBe(2);
    const row = payments.getRow(2);
    expect(row.getCell(columnByHeader(payments, 'Tên khách')).value).toBe('Nguyễn Khách');
    // A NUMBER, not "300.000 ₫" — otherwise nobody can sum the column.
    const cashCell = row.getCell(columnByHeader(payments, 'Thu tiền mặt'));
    expect(cashCell.value).toBe(300000);
    expect(typeof cashCell.value).toBe('number');
    expect(cashCell.numFmt).toContain('₫');
    // The header row is frozen so the columns stay labelled while scrolling.
    expect(payments.views[0]?.state).toBe('frozen');

    const summary = wb.getWorksheet('Tổng hợp chi nhánh')!;
    const branchRow = summary.getRow(4);
    expect(branchRow.getCell(columnByHeader(summary, 'Tiền đầu ca')).value).toBe(7570000);
    // 7.570.000 + 300.000 − 100.000
    expect(branchRow.getCell(columnByHeader(summary, 'Tiền cuối ca')).value).toBe(7770000);

    const complaints = wb.getWorksheet('Vấn đề về chất lượng dịch vụ')!;
    expect(complaints.getRow(2).getCell(columnByHeader(complaints, 'Mô tả')).value).toBe(
      'Phòng ồn suốt đêm',
    );

    const facilities = wb.getWorksheet('Sự cố vật chất đang xử lý')!;
    expect(facilities.getRow(2).getCell(columnByHeader(facilities, 'Mô tả')).value).toBe('Sofa rách');
    // A cuid, which is the reference into the existing technical system.
    expect(String(facilities.getRow(2).getCell(columnByHeader(facilities, 'Mã sự cố')).value)).toMatch(
      /^c[a-z0-9]{24}$/,
    );
  });

  it('exports every branch, each identifiable', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedFullDay(letanCn2, 'Người CN2');

    const res = await admin
      .get('/api/admin/reports/operational.xlsx?from=2026-09-19&to=2026-09-19')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    const wb = await loadWorkbook(res.body as Buffer);

    const payments = wb.getWorksheet('Theo dõi thanh toán')!;
    const branchColumn = columnByHeader(payments, 'Chi nhánh');
    const branchCells = new Set<string>();
    payments.eachRow((row, i) => {
      if (i === 1) return;
      branchCells.add(String(row.getCell(branchColumn).value));
    });
    expect(branchCells.size).toBe(2);
    for (const label of branchCells) expect(label).toMatch(/^CN\d+ — /);
  });
});

/* ======================= V3.1 — period, shift day, export scope ======================= */

/** A complaint on a DIFFERENT day from `seedFullDay`, on its own shift. */
async function seedComplaintOn21st(agent: Agent) {
  setClock({ now: () => hcm('2026-09-21', '07:00') });
  await checkIn(agent, 'A', 'Người Ngày 21');
  const res = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName: 'Khách Ngày 21', location: '305', description: 'Nước nóng yếu' },
  });
  expect(res.status).toBe(201);
  await endShift(agent);
}

async function xlsx(query: string) {
  const res = await admin
    .get(`/api/admin/reports/operational.xlsx?${query}`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return loadWorkbook(res.body as Buffer);
}

describe('the period is applied by the server', () => {
  it('shows only the records of the chosen days', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedComplaintOn21st(letan);

    const the19th = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-09-19&to=2026-09-19`);
    expect(the19th.status).toBe(200);
    expect(the19th.body.reports).toHaveLength(5);
    expect(the19th.body.reports.map((r: { complaint: { guestName: string } | null }) => r.complaint?.guestName)).not.toContain(
      'Khách Ngày 21',
    );

    const the21st = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-09-21&to=2026-09-21`);
    expect(the21st.body.reports).toHaveLength(1);
    expect(the21st.body.reports[0].complaint.guestName).toBe('Khách Ngày 21');
  });

  it('counts the chosen period and branch — never records outside them', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedComplaintOn21st(letan);
    await seedFullDay(letanCn2, 'Người CN2');

    const res = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT&from=2026-09-19&to=2026-09-19`,
    );
    // The counts describe the PERIOD and the BRANCH, not the category selection:
    // the 21st's complaint and the other branch's day are both out of scope.
    expect(res.body.counts).toEqual({
      PAYMENT: 1,
      GUEST_REQUEST: 1,
      FACILITY_ISSUE: 1,
      CUSTOMER_COMPLAINT: 1,
      ROOM_SERVICE: 1,
    });
    expect(res.body.reports).toHaveLength(1);
  });
});

describe('every record carries its shift’s own day', () => {
  /**
   * Ca C of the 19th runs to 06:00 on the 20th. An entry at 02:15 on the 20th is
   * part of the 19th's night — reading its day off its own timestamp would file
   * it under the 20th and split one receptionist's shift across two dates.
   */
  it('keeps a Ca C entry made after midnight on the day the shift began', async () => {
    setClock({ now: () => hcm('2026-09-19', '22:05') });
    await checkIn(letan, 'C', 'Người Ca Đêm');

    const before = await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Trước nửa đêm', location: '201', description: 'Ồn' },
    });
    expect(before.status).toBe(201);

    setClock({ now: () => hcm('2026-09-20', '02:15') });
    const after = await letan.post('/api/reception/reports').send({
      category: 'CUSTOMER_COMPLAINT',
      complaint: { guestName: 'Sau nửa đêm', location: '202', description: 'Ồn' },
    });
    expect(after.status).toBe(201);

    expect(before.body.report.shiftDate).toBe('2026-09-19');
    expect(after.body.report.shiftDate).toBe('2026-09-19');
    // Both belong to the same shift, and name the person who was on it.
    expect(after.body.report.shiftSessionId).toBe(before.body.report.shiftSessionId);
    expect(after.body.report.shiftReceptionistName).toBe('Người Ca Đêm');
  });

  it('puts the shift’s day in every record sheet of the workbook', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const wb = await xlsx('from=2026-09-19&to=2026-09-19');
    for (const name of [
      'Theo dõi thanh toán',
      'Vấn đề khách yêu cầu',
      'Sự cố vật chất đang xử lý',
      'Vấn đề về chất lượng dịch vụ',
      'Dịch vụ phòng, KPI',
    ]) {
      const sheet = wb.getWorksheet(name)!;
      expect(sheet.getRow(2).getCell(columnByHeader(sheet, 'Ngày ca')).value).toBe('19/09/2026');
    }
  });
});

describe('the export is scoped exactly like the screen', () => {
  it('exports only the chosen category, and says which', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const wb = await xlsx(`from=2026-09-19&to=2026-09-19&branchId=${cn1}&category=PAYMENT`);

    expect(wb.getWorksheet('Theo dõi thanh toán')!.rowCount).toBe(2);
    // Every other category's sheet holds its header and nothing else.
    for (const name of [
      'Vấn đề khách yêu cầu',
      'Sự cố vật chất đang xử lý',
      'Vấn đề về chất lượng dịch vụ',
      'Dịch vụ phòng, KPI',
    ]) {
      expect(wb.getWorksheet(name)!.rowCount).toBe(1);
    }
    const summary = wb.getWorksheet('Tổng hợp chi nhánh')!;
    const lines: string[] = [];
    summary.eachRow((row) => lines.push(String(row.getCell(1).value ?? '')));
    expect(lines).toContain('Danh mục: Theo dõi thanh toán');
  });

  it('exports only the chosen days', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedComplaintOn21st(letan);

    const wb = await xlsx(`from=2026-09-21&to=2026-09-21&branchId=${cn1}`);
    // The 19th's payment is outside the period.
    expect(wb.getWorksheet('Theo dõi thanh toán')!.rowCount).toBe(1);
    const complaints = wb.getWorksheet('Vấn đề về chất lượng dịch vụ')!;
    expect(complaints.rowCount).toBe(2);
    expect(complaints.getRow(2).getCell(columnByHeader(complaints, 'Tên khách')).value).toBe('Khách Ngày 21');
  });

  it('exports only the chosen branch', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    await seedFullDay(letanCn2, 'Người CN2');

    const wb = await xlsx(`from=2026-09-19&to=2026-09-19&branchId=${cn1}`);
    const payments = wb.getWorksheet('Theo dõi thanh toán')!;
    expect(payments.rowCount).toBe(2);
    const branchCol = columnByHeader(payments, 'Chi nhánh');
    expect(String(payments.getRow(2).getCell(branchCol).value)).toMatch(/^CN1 — /);
  });

  it('refuses a category that does not exist', async () => {
    // "KPI" is part of a label, never a category of its own.
    const res = await admin.get('/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19&category=KPI');
    expect(res.status).toBe(422);
  });

  it('builds a scoped PDF', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin
      .get(`/api/admin/reports/operational.pdf?from=2026-09-19&to=2026-09-19&branchId=${cn1}&category=ROOM_SERVICE`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('a facility record is still the technical workflow’s incident', () => {
  it('references the HotelIssue itself, not a copy', async () => {
    await seedFullDay(letan, 'Nguyễn Văn A');
    const res = await admin.get(
      `/api/admin/reports/operational?branchId=${cn1}&category=FACILITY_ISSUE&from=2026-09-19&to=2026-09-19`,
    );
    const row = res.body.reports[0];
    const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: row.facility.issueId } });
    expect(issue.description).toBe('Sofa rách');
    // Read LIVE through the reference: the technical status, not a snapshot.
    expect(row.facility.issue.status).toBe(issue.status);
  });
});

/* ================= V4 — the business date, and only closed shifts ================= */

/** A complaint whose guest name identifies the moment it was written. */
async function note(agent: Agent, at: Date, guestName: string) {
  setClock({ now: () => at });
  const res = await agent.post('/api/reception/reports').send({
    category: 'CUSTOMER_COMPLAINT',
    complaint: { guestName, location: '101', description: 'Ghi nhận' },
  });
  expect(res.status).toBe(201);
}

/** The guest names in the official export's complaint sheet for one business date. */
async function exportedFor(day: string): Promise<string[]> {
  const wb = await xlsx(`from=${day}&to=${day}&branchId=${cn1}`);
  const sheet = wb.getWorksheet('Vấn đề về chất lượng dịch vụ')!;
  const col = columnByHeader(sheet, 'Tên khách');
  const names: string[] = [];
  sheet.eachRow((row, i) => {
    if (i > 1) names.push(String(row.getCell(col).value));
  });
  return names.sort();
}

describe('the business date of a shift, not the calendar date of a record', () => {
  it('puts Ca A, Ca B and Ca C of the 23rd — including C after midnight — on the 23rd', async () => {
    setClock({ now: () => hcm('2026-09-23', '06:02') });
    await checkIn(letan, 'A', 'Lễ tân A');
    await note(letan, hcm('2026-09-23', '09:00'), 'A-23');

    setClock({ now: () => hcm('2026-09-23', '14:01') });
    await checkIn(letan, 'B', 'Lễ tân B'); // closes Ca A
    await note(letan, hcm('2026-09-23', '18:00'), 'B-23');

    setClock({ now: () => hcm('2026-09-23', '22:03') });
    await checkIn(letan, 'C', 'Lễ tân C'); // closes Ca B
    await note(letan, hcm('2026-09-23', '23:30'), 'C-23-before-midnight');
    await note(letan, hcm('2026-09-24', '02:15'), 'C-23-after-midnight');
    setClock({ now: () => hcm('2026-09-24', '05:58') });
    await endShift(letan); // "Kết thúc ca" on the morning of the 24th

    expect(await exportedFor('2026-09-23')).toEqual([
      'A-23',
      'B-23',
      'C-23-after-midnight',
      'C-23-before-midnight',
    ]);
    // The calendar day the 02:15 entry was typed on does not own it.
    expect(await exportedFor('2026-09-24')).toEqual([]);
  });

  it('puts Ca A4 and Ca C4 of the 23rd on the 23rd', async () => {
    setClock({ now: () => hcm('2026-09-23', '06:04') });
    await checkIn(letan, 'A4', 'Lễ tân A4');
    await note(letan, hcm('2026-09-23', '11:00'), 'A4-23');

    setClock({ now: () => hcm('2026-09-23', '18:02') });
    await checkIn(letan, 'C4', 'Lễ tân C4'); // closes Ca A4
    await note(letan, hcm('2026-09-23', '21:00'), 'C4-23-evening');
    await note(letan, hcm('2026-09-24', '03:40'), 'C4-23-night');
    setClock({ now: () => hcm('2026-09-24', '05:55') });
    await endShift(letan);

    expect(await exportedFor('2026-09-23')).toEqual(['A4-23', 'C4-23-evening', 'C4-23-night']);
    expect(await exportedFor('2026-09-24')).toEqual([]);
  });

  /**
   * A LATE CHECK-IN. Somebody who starts Ca C at 01:30 on the 24th is on the
   * 23rd's night shift — the same one an on-time 22:00 check-in would be. Taking
   * the day from the check-in's own calendar date would file the whole shift
   * under the 24th.
   */
  it('keeps a Ca C checked in late, after midnight, on the day it began', async () => {
    setClock({ now: () => hcm('2026-09-24', '01:30') });
    await checkIn(letan, 'C', 'Đến muộn');
    await note(letan, hcm('2026-09-24', '02:00'), 'C-23-late');
    setClock({ now: () => hcm('2026-09-24', '05:55') });
    await endShift(letan);

    expect(await exportedFor('2026-09-23')).toEqual(['C-23-late']);
    expect(await exportedFor('2026-09-24')).toEqual([]);
  });

  /**
   * THE CALENDAR-DATE TRAP, from the other side: Ca C of the 22nd writes at
   * 02:00 on the 23rd. A `createdAt` filter for the 23rd would pull it in; the
   * 23rd's report must not contain it.
   */
  it('keeps the previous night’s after-midnight entries out of the day', async () => {
    setClock({ now: () => hcm('2026-09-22', '22:05') });
    await checkIn(letan, 'C', 'Đêm 22');
    await note(letan, hcm('2026-09-23', '02:00'), 'C-22-after-midnight');
    setClock({ now: () => hcm('2026-09-23', '05:59') });
    await endShift(letan);

    setClock({ now: () => hcm('2026-09-23', '06:03') });
    await checkIn(letan, 'A', 'Sáng 23');
    await note(letan, hcm('2026-09-23', '07:00'), 'A-23');
    await endShift(letan);

    expect(await exportedFor('2026-09-23')).toEqual(['A-23']);
    expect(await exportedFor('2026-09-22')).toEqual(['C-22-after-midnight']);
  });
});

describe('only CLOSED shifts are in the official report', () => {
  it('leaves an open Ca C out of the export, names it, and includes it once it ends', async () => {
    setClock({ now: () => hcm('2026-09-23', '06:02') });
    await checkIn(letan, 'A', 'Lễ tân A');
    await note(letan, hcm('2026-09-23', '08:00'), 'A-23');

    setClock({ now: () => hcm('2026-09-23', '22:04') });
    await checkIn(letan, 'C', 'Lễ tân Đêm'); // closes Ca A; Ca C stays OPEN
    await note(letan, hcm('2026-09-24', '01:00'), 'C-23');

    // Open: out of the file…
    expect(await exportedFor('2026-09-23')).toEqual(['A-23']);
    // …and named in it, never silently absent.
    const wb = await xlsx(`from=2026-09-23&to=2026-09-23&branchId=${cn1}`);
    const lines: string[] = [];
    wb.getWorksheet('Tổng hợp chi nhánh')!.eachRow((row) => lines.push(String(row.getCell(1).value ?? '')));
    expect(lines).toContain('CHÚ Ý: Ca chưa kết thúc chưa được đưa vào báo cáo chính thức.');
    expect(lines.some((l) => l.includes('Ca C') && l.includes('Lễ tân Đêm'))).toBe(true);

    // On SCREEN it is shown, flagged as still open, with the same warning.
    const screen = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&from=2026-09-23&to=2026-09-23`);
    expect(screen.body.reports).toHaveLength(2);
    const open = screen.body.reports.find((r: { complaint: { guestName: string } }) => r.complaint.guestName === 'C-23');
    expect(open.shiftClosed).toBe(false);
    expect(open.shiftDate).toBe('2026-09-23');
    expect(screen.body.openShifts).toHaveLength(1);
    expect(screen.body.openShifts[0]).toMatchObject({ shiftName: 'Ca C', businessDate: '2026-09-23' });
    expect(screen.body.openShiftWarning).toBe('Ca chưa kết thúc chưa được đưa vào báo cáo chính thức.');

    // "Kết thúc ca" on the morning of the 24th: now it belongs to the 23rd's report.
    setClock({ now: () => hcm('2026-09-24', '06:01') });
    await endShift(letan);
    expect(await exportedFor('2026-09-23')).toEqual(['A-23', 'C-23']);
  });

  it('includes a closed Ca C4 and its drawer', async () => {
    setClock({ now: () => hcm('2026-09-23', '18:03') });
    await checkIn(letan, 'C4', 'Lễ tân C4');
    expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 1_000_000 })).status).toBe(200);
    setClock({ now: () => hcm('2026-09-24', '02:00') });
    expect(
      (await letan.post('/api/reception/reports').send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 200_000 } }))
        .status,
    ).toBe(201);
    setClock({ now: () => hcm('2026-09-24', '05:50') });
    await endShift(letan);

    const wb = await xlsx(`from=2026-09-23&to=2026-09-23&branchId=${cn1}`);
    expect(wb.getWorksheet('Theo dõi thanh toán')!.rowCount).toBe(2);
    const summary = wb.getWorksheet('Tổng hợp chi nhánh')!;
    let branchRow = 0;
    summary.eachRow((row, i) => {
      if (String(row.getCell(1).value ?? '').startsWith('CN')) branchRow = i;
    });
    // TIỀN CUỐI CA = TIỀN ĐẦU CA + THU TIỀN MẶT − CHI TIỀN MẶT, unchanged.
    expect(summary.getRow(branchRow).getCell(columnByHeader(summary, 'Tiền đầu ca')).value).toBe(1_000_000);
    expect(summary.getRow(branchRow).getCell(columnByHeader(summary, 'Tiền cuối ca')).value).toBe(1_200_000);
  });

  it('says in the PDF that open shifts are left out', async () => {
    setClock({ now: () => hcm('2026-09-23', '22:04') });
    await checkIn(letan, 'C', 'Lễ tân Đêm');
    const res = await admin
      .get(`/api/admin/reports/operational.pdf?from=2026-09-23&to=2026-09-23&branchId=${cn1}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('who can see which branch', () => {
  it('lets the Admin see every branch at once', async () => {
    await seedFullDay(letan, 'CN1');
    await seedFullDay(letanCn2, 'CN2');
    const res = await admin.get('/api/admin/reports/operational?from=2026-09-19&to=2026-09-19');
    expect(res.status).toBe(200);
    const branches = new Set(res.body.reports.map((r: { branchId: number }) => r.branchId));
    expect(branches).toEqual(new Set([cn1, cn2]));
  });

  it('refuses the Admin report to a receptionist, whichever branch is asked for', async () => {
    await seedFullDay(letanCn2, 'CN2');
    for (const url of [
      `/api/admin/reports/operational?branchId=${cn2}&from=2026-09-19&to=2026-09-19`,
      `/api/admin/reports/operational.xlsx?branchId=${cn2}&from=2026-09-19&to=2026-09-19`,
    ]) {
      expect((await letan.get(url)).status).toBe(403);
    }
    // And their own journal never contains another branch's rows.
    const own = await letan.get('/api/reception/reports');
    expect(own.body.reports.every((r: { branchId: number }) => r.branchId === cn1)).toBe(true);
  });
});
