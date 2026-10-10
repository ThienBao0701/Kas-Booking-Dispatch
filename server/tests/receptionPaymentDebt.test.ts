/**
 * "Công nợ" AS A PAYMENT METHOD, the payment note, and the extra sources.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Công nợ is chosen as the METHOD and its amount lives in `amount` — there
 *      is no second, external debt box — and it does NOT move cash on hand.
 *   2. Tiền mặt still does, Chuyển khoản and Cà thẻ still do not, Chi still
 *      subtracts: the accounting behaviour did not change with the form.
 *   3. An older row that carried a debt in the legacy `receivable` column is
 *      still counted, once.
 *   4. "Ghi chú" is stored on create, correctable with an audit row, and served.
 *   5. "Walking" and "Khác" are accepted sources; anything else still is not.
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

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let letan: Agent;
let admin: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-19', '07:00') });
  const res = await letan
    .post('/api/reception/shifts/check-in')
    .send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
  expect(res.status).toBe(201);
  await letan.put('/api/reception/shifts/cash').send({ openingCash: 1_000_000 });
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

// "Nguồn" is required for a new payment; these tests are about method and note,
// so they say "Khác" unless one names its own source.
const pay = (payment: Record<string, unknown>) =>
  letan.post('/api/reception/reports').send({ category: 'PAYMENT', payment: { source: 'Khác', ...payment } });

async function cash() {
  const res = await letan.get('/api/reception/shifts/cash');
  return res.body.cash as {
    cashCollected: number;
    transferCollected: number;
    cardCollected: number;
    receivable: number;
    cashExpense: number;
    endingCash: number;
  };
}

describe('Công nợ is a payment method', () => {
  it('offers Tiền mặt, Chuyển khoản, Cà thẻ and Công nợ, in that order', async () => {
    const res = await letan.get('/api/reception/reports/options');
    expect(res.body.paymentMethods).toEqual([
      { code: 'CASH', label: 'Tiền mặt' },
      { code: 'TRANSFER', label: 'Chuyển khoản' },
      { code: 'CARD', label: 'Cà thẻ' },
      { code: 'DEBT', label: 'Công nợ' },
    ]);
  });

  it('keeps the debt in `amount`, reports it as receivable, and never as cash', async () => {
    const res = await pay({ method: 'DEBT', amount: 700_000, guestName: 'Khách nợ' });
    expect(res.status).toBe(201);
    expect(res.body.report.payment).toMatchObject({
      method: 'DEBT',
      methodLabel: 'Công nợ',
      amount: 700_000,
      receivable: 700_000,
      debt: 700_000,
      cash: 0,
      transfer: 0,
      card: 0,
    });
    const c = await cash();
    expect(c.receivable).toBe(700_000);
    expect(c.cashCollected).toBe(0);
    expect(c.cardCollected).toBe(0);
    expect(c.endingCash).toBe(1_000_000);
  });

  it('leaves the cash rules exactly as they were', async () => {
    await pay({ method: 'CASH', amount: 300_000 });
    await pay({ method: 'TRANSFER', amount: 200_000 });
    await pay({ method: 'CARD', amount: 100_000 });
    await pay({ method: 'DEBT', amount: 500_000 });
    await pay({ method: 'CASH', amount: 50_000, expense: 20_000 });
    const c = await cash();
    expect(c).toMatchObject({
      cashCollected: 350_000,
      transferCollected: 200_000,
      cardCollected: 100_000,
      receivable: 500_000,
      cashExpense: 20_000,
    });
    // 1.000.000 + 350.000 − 20.000: only cash moves the drawer.
    expect(c.endingCash).toBe(1_330_000);
  });

  it('still counts a debt an older row carried in the legacy column — once', async () => {
    await pay({ method: 'CASH', amount: 100_000, receivable: 40_000 });
    await pay({ method: 'DEBT', amount: 60_000 });
    const c = await cash();
    expect(c.receivable).toBe(100_000);
    expect(c.cashCollected).toBe(100_000);
  });

  it('recalculates when a cash row is corrected into a debt', async () => {
    const created = await pay({ method: 'CASH', amount: 250_000 });
    expect((await cash()).endingCash).toBe(1_250_000);
    const edit = await letan
      .patch(`/api/reception/reports/${created.body.report.id}`)
      .send({ payment: { method: 'DEBT' } });
    expect(edit.status).toBe(200);
    const c = await cash();
    expect(c.endingCash).toBe(1_000_000);
    expect(c.receivable).toBe(250_000);
  });

  it('rejects a method that is not one of the four', async () => {
    expect((await pay({ method: 'CHEQUE', amount: 1000 })).status).toBe(422);
  });
});

describe('"Ghi chú" on a payment', () => {
  it('is stored, served to the Admin, and correctable with an audit row', async () => {
    const created = await pay({ method: 'CASH', amount: 100_000, note: 'Khách trả trước một đêm' });
    expect(created.status).toBe(201);
    expect(created.body.report.payment.note).toBe('Khách trả trước một đêm');

    const edit = await letan
      .patch(`/api/reception/reports/${created.body.report.id}`)
      .send({ payment: { note: 'Khách trả trước hai đêm' } });
    expect(edit.status).toBe(200);
    expect(edit.body.report.payment.note).toBe('Khách trả trước hai đêm');
    expect(edit.body.report.audits).toEqual([
      expect.objectContaining({
        field: 'note',
        oldValue: 'Khách trả trước một đêm',
        newValue: 'Khách trả trước hai đêm',
      }),
    ]);

    const adminView = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=PAYMENT`);
    expect(adminView.body.reports[0].payment.note).toBe('Khách trả trước hai đêm');
  });

  it('is optional', async () => {
    const created = await pay({ method: 'CASH', amount: 1000 });
    expect(created.body.report.payment.note).toBeNull();
  });
});

describe('"Nguồn"', () => {
  it.each(['Booking', 'Agoda', 'Ctrip', 'Traveloka', 'Expedia', 'Walking', 'Khác'])(
    'accepts %s',
    async (source) => {
      const res = await pay({ method: 'CASH', amount: 1000, source });
      expect(res.status).toBe(201);
      expect(res.body.report.payment.source).toBe(source);
    },
  );

  it('still refuses a source outside the list', async () => {
    expect((await pay({ method: 'CASH', amount: 1000, source: 'Facebook' })).status).toBe(422);
  });

  it('still refuses a new payment with no source at all', async () => {
    const res = await letan
      .post('/api/reception/reports')
      .send({ category: 'PAYMENT', payment: { method: 'CASH', amount: 1000 } });
    expect(res.status).toBe(422);
  });
});
