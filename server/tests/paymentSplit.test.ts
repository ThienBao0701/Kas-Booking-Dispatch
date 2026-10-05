/**
 * ONE TRANSACTION, SEVERAL METHODS — "500.000 tiền mặt + 500.000 chuyển khoản".
 *
 *   1  one transaction carries several payment methods
 *   2  the allocations must add up to "Tổng tiền thu"
 *   3  it stays ONE ledger row (one record, one line in every list)
 *   4  the drawer moves by the cash part only; transfer, card and debt never
 *   5  a correction can add, change or remove a method — and stays balanced,
 *      one row, audited
 *   6  anything unbalanced is refused by the server (and by the database)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetShiftData, testPrisma } from './helpers/db';
import { ADMIN_PASSWORD, RECEPTIONIST_PASSWORD, createAdmin, createReceptionist, loginAgent } from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const hcm = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let letan: Agent;
let admin: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân CN1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetShiftData();
  setClock({ now: () => hcm('2026-10-07', '08:00') });
  expect((await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn A' })).status).toBe(201);
  expect((await letan.put('/api/reception/shifts/cash').send({ openingCash: 2_000_000 })).status).toBe(200);
});

afterAll(async () => {
  resetClock();
  await testPrisma.$disconnect();
});

const SPLIT = {
  category: 'PAYMENT',
  payment: {
    guestName: 'CHEN XIJUN',
    ezCode: '40263',
    source: 'Ctrip',
    amount: 1_000_000,
    allocations: [
      { method: 'CASH', amount: 500_000 },
      { method: 'TRANSFER', amount: 500_000 },
    ],
  },
};

const create = (body: object) => letan.post('/api/reception/reports').send(body);
const cash = async () => (await letan.get('/api/reception/shifts/cash')).body.cash;

describe('one transaction, several methods', () => {
  it('1, 3. is ONE ledger row carrying each method under its own column', async () => {
    const res = await create(SPLIT);
    expect(res.status).toBe(201);
    expect(res.body.report.payment).toMatchObject({
      guestName: 'CHEN XIJUN',
      amount: 1_000_000,
      cash: 500_000,
      transfer: 500_000,
      card: 0,
      debt: 0,
      receivable: 0,
      expense: 0,
      allocations: [
        { method: 'CASH', label: 'Tiền mặt', amount: 500_000 },
        { method: 'TRANSFER', label: 'Chuyển khoản', amount: 500_000 },
      ],
    });
    expect(res.body.report.summary).toBe('CHEN XIJUN · Tiền mặt 500.000 ₫ + Chuyển khoản 500.000 ₫');
    // One record in the database, one row on the desk's list.
    expect(await testPrisma.receptionOperationalReport.count()).toBe(1);
    expect(await testPrisma.receptionPayment.count()).toBe(1);
    const list = await letan.get('/api/reception/reports').query({ category: 'PAYMENT' });
    expect(list.body.reports).toHaveLength(1);
    // The Admin reads the same single row.
    const report = await admin.get('/api/admin/reports/operational').query({ branchId: cn1, category: 'PAYMENT' });
    expect(report.body.reports).toHaveLength(1);
    expect(report.body.reports[0].payment).toMatchObject({ cash: 500_000, transfer: 500_000 });
  });

  it('4. the drawer moves by the cash part only — transfer, card and debt never reach it', async () => {
    expect((await create(SPLIT)).status).toBe(201);
    expect(
      (
        await create({
          category: 'PAYMENT',
          payment: {
            source: 'Booking',
            amount: 900_000,
            allocations: [
              { method: 'CARD', amount: 300_000 },
              { method: 'DEBT', amount: 400_000 },
              { method: 'CASH', amount: 200_000 },
            ],
            expense: 50_000,
          },
        })
      ).status,
    ).toBe(201);
    // A payout: cash leaving the drawer, collecting nothing.
    expect((await create({ category: 'PAYMENT', payment: { source: 'Chi tiền', amount: 0, expense: 100_000 } })).status).toBe(201);
    expect(await cash()).toMatchObject({
      openingCash: 2_000_000,
      cashCollected: 700_000,
      transferCollected: 500_000,
      cardCollected: 300_000,
      receivable: 400_000,
      cashExpense: 150_000,
      // 2.000.000 + 700.000 − 150.000
      endingCash: 2_550_000,
      paymentCount: 3,
    });
  });

  it('4. a row recorded before split payments is read as its one method, unchanged', async () => {
    const res = await create({ category: 'PAYMENT', payment: { source: 'Agoda', method: 'CARD', amount: 300_000 } });
    // The older body still works — and is stored as a balanced one-method split.
    expect(res.body.report.payment).toMatchObject({ method: 'CARD', amount: 300_000, card: 300_000, allocations: [{ method: 'CARD', amount: 300_000 }] });
    const legacy = await create({ category: 'PAYMENT', payment: { source: 'Walking', method: 'CASH', amount: 1 } });
    // A row exactly as the old code wrote it: no allocation columns at all.
    await testPrisma.receptionPayment.update({
      where: { reportId: legacy.body.report.id },
      data: { method: 'TRANSFER', amount: 250_000, cashAmount: null, transferAmount: null, cardAmount: null, debtAmount: null },
    });
    expect(await cash()).toMatchObject({ cashCollected: 0, transferCollected: 250_000, cardCollected: 300_000 });
    const row = (await letan.get('/api/reception/reports').query({ category: 'PAYMENT' })).body.reports.find(
      (r: { id: string }) => r.id === legacy.body.report.id,
    );
    expect(row.payment).toMatchObject({ transfer: 250_000, allocations: [{ method: 'TRANSFER', amount: 250_000 }] });
  });
});

describe('the allocations must balance — on the server', () => {
  it('2, 6. refuses a sum that is not the total, a negative amount, a repeated method and an empty split', async () => {
    const bad = async (payment: Record<string, unknown>) => (await create({ category: 'PAYMENT', payment: { source: 'Ctrip', ...payment } })).status;
    expect(await bad({ amount: 1_000_000, allocations: [{ method: 'CASH', amount: 500_000 }, { method: 'TRANSFER', amount: 400_000 }] })).toBe(422);
    expect(await bad({ amount: 1_000_000, allocations: [{ method: 'CASH', amount: 1_500_000 }, { method: 'TRANSFER', amount: -500_000 }] })).toBe(422);
    expect(await bad({ amount: 1_000_000, allocations: [{ method: 'CASH', amount: 500_000 }, { method: 'CASH', amount: 500_000 }] })).toBe(422);
    expect(await bad({ amount: 1_000_000, allocations: [] })).toBe(422);
    expect(await bad({ amount: 1_000_000, allocations: [{ method: 'CHEQUE', amount: 1_000_000 }] })).toBe(422);
    const message = (await create({ category: 'PAYMENT', payment: { source: 'Ctrip', amount: 1_000_000, allocations: [{ method: 'CASH', amount: 600_000 }] } })).body;
    expect(JSON.stringify(message)).toContain('phải bằng tổng tiền thu');
    expect(await testPrisma.receptionPayment.count()).toBe(0);
  });

  it('6. the database itself refuses an unbalanced row', async () => {
    const res = await create(SPLIT);
    await expect(
      testPrisma.receptionPayment.update({ where: { reportId: res.body.report.id }, data: { transferAmount: 400_000 } }),
    ).rejects.toThrow();
    await expect(
      testPrisma.receptionPayment.update({ where: { reportId: res.body.report.id }, data: { cardAmount: null } }),
    ).rejects.toThrow();
  });
});

describe('correcting the methods of a transaction', () => {
  it('5. adds, changes and removes methods — one row, balanced, every change audited', async () => {
    const id = (await create(SPLIT)).body.report.id as string;
    const patch = (payment: Record<string, unknown>) => letan.patch(`/api/reception/reports/${id}`).send({ payment });

    // Add Cà thẻ, move money from cash: the total is unchanged.
    const added = await patch({
      amount: 1_000_000,
      allocations: [
        { method: 'CASH', amount: 300_000 },
        { method: 'TRANSFER', amount: 500_000 },
        { method: 'CARD', amount: 200_000 },
      ],
    });
    expect(added.status).toBe(200);
    expect(added.body.report.payment).toMatchObject({ cash: 300_000, transfer: 500_000, card: 200_000, amount: 1_000_000 });

    // Remove Chuyển khoản and raise the total.
    const removed = await patch({ amount: 1_200_000, allocations: [{ method: 'CASH', amount: 1_000_000 }, { method: 'CARD', amount: 200_000 }] });
    expect(removed.status).toBe(200);
    expect(removed.body.report.payment).toMatchObject({ cash: 1_000_000, transfer: 0, card: 200_000, amount: 1_200_000, method: 'CASH' });

    // Unbalanced: refused, nothing changes.
    expect((await patch({ amount: 1_200_000, allocations: [{ method: 'CASH', amount: 1_000_000 }] })).status).toBe(422);
    // A bare total on a split row cannot say which method it belongs to.
    expect((await patch({ amount: 900_000 })).status).toBe(422);

    expect(await testPrisma.receptionOperationalReport.count()).toBe(1);
    expect(await cash()).toMatchObject({ cashCollected: 1_000_000, transferCollected: 0, cardCollected: 200_000 });

    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.field, a.oldValue, a.newValue])).toEqual([
      ['allocations', 'Tiền mặt 500.000 ₫ + Chuyển khoản 500.000 ₫', 'Tiền mặt 300.000 ₫ + Chuyển khoản 500.000 ₫ + Cà thẻ 200.000 ₫'],
      ['amount', '1000000', '1200000'],
      ['allocations', 'Tiền mặt 300.000 ₫ + Chuyển khoản 500.000 ₫ + Cà thẻ 200.000 ₫', 'Tiền mặt 1.000.000 ₫ + Cà thẻ 200.000 ₫'],
    ]);
  });

  it('5. a one-method row is still corrected by the older body — and re-saving changes nothing', async () => {
    const id = (await create({ category: 'PAYMENT', payment: { source: 'Agoda', method: 'CASH', amount: 400_000 } })).body.report.id;
    const same = await letan.patch(`/api/reception/reports/${id}`).send({ payment: { method: 'CASH', amount: 400_000 } });
    expect(same.status).toBe(200);
    const moved = await letan.patch(`/api/reception/reports/${id}`).send({ payment: { method: 'TRANSFER', amount: 400_000 } });
    expect(moved.body.report.payment).toMatchObject({ method: 'TRANSFER', cash: 0, transfer: 400_000 });
    const audits = await testPrisma.receptionReportAudit.findMany({ where: { reportId: id } });
    expect(audits.map((a) => [a.field, a.oldValue, a.newValue])).toEqual([['allocations', 'Tiền mặt 400.000 ₫', 'Chuyển khoản 400.000 ₫']]);
  });
});

describe('a split payment that was really a payout', () => {
  it('5. becomes "Chi tiền": no total, every method zero, still one row', async () => {
    const id = (await create(SPLIT)).body.report.id as string;
    const res = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ payment: { source: 'Chi tiền', method: 'CASH', amount: 0, expense: 200_000 } });
    expect(res.status).toBe(200);
    expect(res.body.report.payment).toMatchObject({ amount: 0, cash: 0, transfer: 0, expense: 200_000, allocations: [] });
    expect(await testPrisma.receptionPayment.count()).toBe(1);
    expect(await cash()).toMatchObject({ cashCollected: 0, transferCollected: 0, cashExpense: 200_000 });
  });
});
