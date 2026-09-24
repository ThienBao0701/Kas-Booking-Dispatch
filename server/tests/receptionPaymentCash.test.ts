/**
 * "THU TIỀN THANH TOÁN" — the cash drawer, and the one formula.
 *
 *   TIỀN CUỐI CA = TIỀN ĐẦU CA + TỔNG THU TIỀN MẶT − TỔNG CHI TIỀN MẶT
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The formula, on the specification's own worked example, to the đồng.
 *   2. Transfer, card and công nợ are recorded and do NOT move cash on hand.
 *      Getting this wrong shows a desk holding money that is in a bank.
 *   3. "Chi tiền" is always cash, whatever the row's own payment method was.
 *   4. Every recalculation trigger: add, edit amount, edit method, edit expense,
 *      void.
 *   5. Money is stored as a number. A formatted "3.150.000 ₫" is refused, and an
 *      empty amount does not quietly become zero.
 *   6. A correction keeps the old value, the new value, who and when — and a
 *      financial row is NEVER hard-deleted.
 *   7. "Tiền cuối ca" cannot be entered by hand: no endpoint accepts one.
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
let letanB: Agent;
let admin: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;
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
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

async function pay(payment: Record<string, unknown>, agent: Agent = letan) {
  return agent.post('/api/reception/reports').send({ category: 'PAYMENT', payment });
}

async function cash(agent: Agent = letan) {
  const res = await agent.get('/api/reception/shifts/cash');
  expect(res.status).toBe(200);
  return res.body.cash as {
    openingCash: number | null;
    cashCollected: number;
    transferCollected: number;
    cardCollected: number;
    receivable: number;
    cashExpense: number;
    endingCash: number | null;
    paymentCount: number;
    voidedCount: number;
  };
}

describe('tiền đầu ca', () => {
  it('accepts a numeric amount and stores it as a number', async () => {
    const res = await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    expect(res.status).toBe(200);
    expect(res.body.cash.openingCash).toBe(7570000);

    const stored = await testPrisma.receptionShiftSession.findFirstOrThrow({
      where: { closedAt: null },
      select: { openingCash: true, openingCashSetAt: true },
    });
    expect(stored.openingCash).toBe(7570000);
    expect(stored.openingCashSetAt?.toISOString()).toBe(hcm('2026-09-19', '07:00').toISOString());
  });

  it('refuses alphabetic, formatted, fractional and negative input', async () => {
    for (const openingCash of ['7570000', '7.570.000 ₫', 'bảy triệu', -1, 1.5, null]) {
      const res = await letan.put('/api/reception/shifts/cash').send({ openingCash });
      expect(res.status, String(openingCash)).toBe(422);
    }
  });

  it('is null — not zero — until it is counted', async () => {
    const summary = await cash();
    expect(summary.openingCash).toBeNull();
    // And so is the ending figure: there is no honest one without a start.
    expect(summary.endingCash).toBeNull();
  });

  it('audits the first count and every correction', async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    setClock({ now: () => hcm('2026-09-19', '07:30') });
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7500000 });

    const audits = await testPrisma.receptionReportAudit.findMany({
      where: { action: 'OPENING_CASH' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.oldValue).toBeNull();
    expect(audits[0]!.newValue).toBe('7570000');
    expect(audits[1]!.oldValue).toBe('7570000');
    expect(audits[1]!.newValue).toBe('7500000');
    expect(audits[1]!.actorNameSnapshot).toBe('Nguyễn Văn A');
    // It belongs to the shift, not to any payment.
    expect(audits[1]!.reportId).toBeNull();
    expect(audits[1]!.shiftSessionId).not.toBeNull();
  });

  it('writes no audit row when the same figure is saved again', async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    expect(await testPrisma.receptionReportAudit.count({ where: { action: 'OPENING_CASH' } })).toBe(1);
  });
});

describe('the specification’s worked example', () => {
  it('7.570.000 + 4.400.000 − 100.000 = 11.870.000', async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });

    expect((await pay({ method: 'CASH', amount: 300000 })).status).toBe(201);
    expect((await pay({ method: 'TRANSFER', amount: 240000 })).status).toBe(201);
    expect((await pay({ method: 'CASH', amount: 950000 })).status).toBe(201);
    expect((await pay({ method: 'CASH', amount: 3150000 })).status).toBe(201);
    expect((await pay({ method: 'CARD', amount: 500000, expense: 100000 })).status).toBe(201);

    const summary = await cash();
    expect(summary.cashCollected).toBe(4400000);
    expect(summary.transferCollected).toBe(240000);
    expect(summary.cardCollected).toBe(500000);
    expect(summary.cashExpense).toBe(100000);
    expect(summary.endingCash).toBe(11870000);
    expect(summary.paymentCount).toBe(5);
  });
});

describe('only cash moves cash', () => {
  beforeEach(async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 1000000 });
  });

  it('a transfer-only shift leaves the drawer unchanged', async () => {
    await pay({ method: 'TRANSFER', amount: 5000000 });
    const summary = await cash();
    expect(summary.transferCollected).toBe(5000000);
    expect(summary.endingCash).toBe(1000000);
  });

  it('a card-only shift leaves the drawer unchanged', async () => {
    await pay({ method: 'CARD', amount: 5000000 });
    expect((await cash()).endingCash).toBe(1000000);
  });

  it('công nợ is recorded and does not move the drawer', async () => {
    await pay({ method: 'CASH', amount: 200000, receivable: 800000 });
    const summary = await cash();
    expect(summary.receivable).toBe(800000);
    expect(summary.endingCash).toBe(1200000);
  });

  it('chi tiền is cash even on a transfer row', async () => {
    await pay({ method: 'TRANSFER', amount: 900000, expense: 150000 });
    const summary = await cash();
    expect(summary.cashCollected).toBe(0);
    expect(summary.cashExpense).toBe(150000);
    expect(summary.endingCash).toBe(850000);
  });

  it('a cash expense with no payment still leaves the drawer', async () => {
    await pay({ method: 'CASH', amount: 0, expense: 120000 });
    expect((await cash()).endingCash).toBe(880000);
  });

  it('a shift with no payments at all ends where it started', async () => {
    expect((await cash()).endingCash).toBe(1000000);
  });
});

describe('recalculation triggers', () => {
  let paymentId = '';

  beforeEach(async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 1000000 });
    const res = await pay({ method: 'CASH', amount: 300000, guestName: 'Khách A', roomNumber: '101' });
    expect(res.status).toBe(201);
    paymentId = res.body.report.id;
    expect((await cash()).endingCash).toBe(1300000);
  });

  it('recalculates when the amount is corrected', async () => {
    const res = await letan
      .patch(`/api/reception/reports/${paymentId}`)
      .send({ payment: { amount: 3000000 } });
    expect(res.status).toBe(200);
    expect((await cash()).endingCash).toBe(4000000);
  });

  it('recalculates when the method changes', async () => {
    await letan.patch(`/api/reception/reports/${paymentId}`).send({ payment: { method: 'CARD' } });
    const summary = await cash();
    expect(summary.cashCollected).toBe(0);
    expect(summary.cardCollected).toBe(300000);
    expect(summary.endingCash).toBe(1000000);
  });

  it('recalculates when the expense changes', async () => {
    await letan.patch(`/api/reception/reports/${paymentId}`).send({ payment: { expense: 50000 } });
    expect((await cash()).endingCash).toBe(1250000);
  });

  it('recalculates when the row is voided, and never deletes it', async () => {
    const before = await testPrisma.receptionPayment.count();
    const res = await letan
      .post(`/api/reception/reports/${paymentId}/void`)
      .send({ reason: 'Nhập nhầm khách' });
    expect(res.status).toBe(200);

    const summary = await cash();
    expect(summary.cashCollected).toBe(0);
    expect(summary.endingCash).toBe(1000000);
    expect(summary.voidedCount).toBe(1);

    // The row is still there — that is the whole difference from a delete.
    expect(await testPrisma.receptionPayment.count()).toBe(before);
    expect(await testPrisma.receptionOperationalReport.count({ where: { id: paymentId } })).toBe(1);
  });
});

describe('money is a number, never a string', () => {
  it('refuses a formatted amount, an empty amount and a fractional one', async () => {
    for (const amount of ['300000', '3.150.000 ₫', '', null, undefined, 1.5, -5]) {
      const res = await pay({ method: 'CASH', amount });
      expect(res.status, String(amount)).toBe(422);
    }
  });

  it('accepts zero, which is a real amount and not a missing one', async () => {
    expect((await pay({ method: 'CASH', amount: 0 })).status).toBe(201);
  });

  it('stores the integer, and the drawer sums integers', async () => {
    await pay({ method: 'CASH', amount: 3150000 });
    const row = await testPrisma.receptionPayment.findFirstOrThrow();
    expect(row.amount).toBe(3150000);
    expect(Number.isInteger(row.amount)).toBe(true);
  });
});

describe('there is no manual tiền cuối ca', () => {
  it('ignores an ending figure sent with the opening one', async () => {
    const res = await letan
      .put('/api/reception/shifts/cash')
      .send({ openingCash: 1000000, endingCash: 99999999, cashCollected: 5000000 });
    expect(res.status).toBe(200);
    // Derived from the rows, not from anything the browser claimed.
    expect(res.body.cash.endingCash).toBe(1000000);
    expect(res.body.cash.cashCollected).toBe(0);
  });

  it('has no column to store one', async () => {
    const columns = await testPrisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'ReceptionShiftSession'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).toContain('openingCash');
    expect(names).not.toContain('endingCash');
    expect(names).not.toContain('closingCash');
  });
});

describe('the correction trail', () => {
  it('keeps the old value, the new value, who and when — per field', async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 0 });
    const created = await pay({ method: 'CASH', amount: 3000000, guestName: 'Khách A' });
    const id = created.body.report.id;

    setClock({ now: () => hcm('2026-09-19', '08:15') });
    const res = await letan.patch(`/api/reception/reports/${id}`).send({
      payment: { amount: 300000, guestName: 'Khách B' },
      reason: 'Nhập thừa một số 0',
    });
    expect(res.status).toBe(200);

    const edits = res.body.report.audits.filter((a: { action: string }) => a.action === 'EDIT');
    expect(edits).toHaveLength(2);

    const amount = edits.find((a: { field: string }) => a.field === 'amount');
    expect(amount.oldValue).toBe('3000000');
    expect(amount.newValue).toBe('300000');
    expect(amount.actor.name).toBe('Nguyễn Văn A');
    expect(amount.reason).toBe('Nhập thừa một số 0');
    expect(amount.createdAt).toBe(hcm('2026-09-19', '08:15').toISOString());

    const guest = edits.find((a: { field: string }) => a.field === 'guestName');
    expect(guest.oldValue).toBe('Khách A');
    expect(guest.newValue).toBe('Khách B');
    // One event: both rows share the instant.
    expect(guest.createdAt).toBe(amount.createdAt);

    // The operational view shows the CORRECTED value.
    expect(res.body.report.payment.amount).toBe(300000);
  });

  it('writes nothing when a save changes no value', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;
    const res = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ payment: { amount: 300000, method: 'CASH' } });
    expect(res.status).toBe(200);
    expect(res.body.report.audits).toHaveLength(0);
  });

  it('records who voided a row, when and why', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;

    setClock({ now: () => hcm('2026-09-19', '09:00') });
    const res = await letan
      .post(`/api/reception/reports/${id}/void`)
      .send({ reason: 'Khách hủy giao dịch' });
    expect(res.status).toBe(200);

    expect(res.body.report.voided).toBe(true);
    expect(res.body.report.voidedByName).toBe('Nguyễn Văn A');
    expect(res.body.report.voidReason).toBe('Khách hủy giao dịch');
    expect(res.body.report.voidedAt).toBe(hcm('2026-09-19', '09:00').toISOString());

    const voidAudit = res.body.report.audits.find((a: { action: string }) => a.action === 'VOID');
    expect(voidAudit.reason).toBe('Khách hủy giao dịch');
  });

  it('refuses a void with no reason', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const res = await letan
      .post(`/api/reception/reports/${created.body.report.id}/void`)
      .send({ reason: '   ' });
    expect(res.status).toBe(422);
  });

  it('corrects only the block belonging to the record’s own category', async () => {
    const created = await pay({ method: 'CASH', amount: 300000, guestName: 'Khách A' });
    const id = created.body.report.id;

    /*
      `guestName` exists on a payment AND on a complaint. A patch that names the
      wrong block must change nothing — the earlier implementation read the
      first block present and would have written this onto the payment.
    */
    const res = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ complaint: { guestName: 'Người Khác' } });
    expect(res.status).toBe(200);
    expect(res.body.report.payment.guestName).toBe('Khách A');
    expect(res.body.report.audits).toHaveLength(0);
  });

  /*
    THE AUDIT'S OLD VALUE IS THE VALUE THAT WAS ACTUALLY OVERWRITTEN.

    The old value used to be computed from a read taken BEFORE the transaction.
    Two receptionists correcting the same row from the same screen would then
    both write "300.000 → their own number": whoever lost the race vanished from
    the trail, and the history claimed a change that never happened.

    It is now read inside the transaction and carried in the UPDATE's own WHERE
    clause, so whichever order the two land in, the rows form a CHAIN — each
    one's old value is the previous one's new value. That is the property worth
    asserting, and it is asserted under a real race rather than in sequence.
  */
  it('keeps the edit trail a chain when two corrections race', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;

    const [a, b] = await Promise.all([
      letan.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 500000 } }),
      letan.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 900000 } }),
    ]);
    // One wins; the other either wins after it or is refused with 409. Both are
    // honest outcomes — silently overwriting without an audit row is not.
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect([a.status, b.status]).toContain(200);

    const audits = await testPrisma.receptionReportAudit.findMany({
      where: { reportId: id, action: 'EDIT', field: 'amount' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // The chain starts where the row started…
    expect(audits[0]!.oldValue).toBe('300000');
    // …every link continues from the last…
    for (let i = 1; i < audits.length; i += 1) {
      expect(audits[i]!.oldValue).toBe(audits[i - 1]!.newValue);
    }
    // …and it ends at the value the row actually holds.
    const row = await testPrisma.receptionPayment.findFirstOrThrow({ where: { reportId: id } });
    expect(String(row.amount)).toBe(audits[audits.length - 1]!.newValue);
  });

  it('records the value actually overwritten when corrections are sequential', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;

    expect(
      (await letan.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 500000 } })).status,
    ).toBe(200);
    expect(
      (await letan.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 900000 } })).status,
    ).toBe(200);

    const audits = await testPrisma.receptionReportAudit.findMany({
      where: { reportId: id, action: 'EDIT' },
      orderBy: { createdAt: 'asc' },
    });
    // 300.000 → 500.000 → 900.000, with no invented 300.000 → 900.000 step.
    expect(audits.map((x) => [x.oldValue, x.newValue])).toEqual([
      ['300000', '500000'],
      ['500000', '900000'],
    ]);
  });

  it('refuses an edit that races a void, leaving the voided amount untouched', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;
    expect(
      (await letan.post(`/api/reception/reports/${id}/void`).send({ reason: 'Nhập nhầm' })).status,
    ).toBe(200);

    const edit = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ payment: { amount: 900000 } });
    expect(edit.status).toBe(409);

    const row = await testPrisma.receptionPayment.findFirstOrThrow({ where: { reportId: id } });
    expect(row.amount).toBe(300000);
  });

  it('refuses a second void, and refuses to edit a voided row', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;
    await letan.post(`/api/reception/reports/${id}/void`).send({ reason: 'lý do' });

    expect((await letan.post(`/api/reception/reports/${id}/void`).send({ reason: 'lại' })).status).toBe(409);
    expect(
      (await letan.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 1 } })).status,
    ).toBe(409);
  });

  it('exposes no DELETE route for a financial record', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;
    // Awaited one at a time: supertest starts an ephemeral server per request,
    // and two built at once race on the bind.
    const deleted = await letan.delete(`/api/reception/reports/${id}`);
    expect([404, 405]).toContain(deleted.status);
    const replaced = await letan.put(`/api/reception/reports/${id}`).send({});
    expect([404, 405]).toContain(replaced.status);
    expect(await testPrisma.receptionPayment.count()).toBe(1);
  });

  it('names the corrector, who may be a different receptionist on a later shift', async () => {
    const created = await pay({ method: 'CASH', amount: 300000 });
    const id = created.body.report.id;

    setClock({ now: () => hcm('2026-09-19', '14:10') });
    const checkIn = await letanB
      .post('/api/reception/shifts/check-in')
      .send({ shiftType: 'B', receptionistName: 'Trần Thị B' });
    expect(checkIn.status).toBe(201);

    const res = await letanB.patch(`/api/reception/reports/${id}`).send({ payment: { amount: 350000 } });
    expect(res.status).toBe(200);

    // The record still says Nguyễn Văn A created it…
    expect(res.body.report.createdByName).toBe('Nguyễn Văn A');
    expect(res.body.report.shiftName).toBe('Ca A');
    // …and the audit says Trần Thị B, on Ca B, changed it.
    const edit = res.body.report.audits.find((a: { action: string }) => a.action === 'EDIT');
    expect(edit.actor.name).toBe('Trần Thị B');
    expect(edit.shiftType).toBe('B');
  });
});

describe('the admin sees the same figures', () => {
  it('reports the branch drawer without recomputing it differently', async () => {
    await letan.put('/api/reception/shifts/cash').send({ openingCash: 7570000 });
    await pay({ method: 'CASH', amount: 300000 });
    await pay({ method: 'CASH', amount: 950000 });
    await pay({ method: 'CASH', amount: 3150000 });
    await pay({ method: 'TRANSFER', amount: 240000 });
    await pay({ method: 'CARD', amount: 500000, expense: 100000 });

    const mine = await cash();
    const theirs = await admin.get(`/api/admin/reports/operational?branchId=${cn1}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.cash.endingCash).toBe(mine.endingCash);
    expect(theirs.body.cash.cashCollected).toBe(mine.cashCollected);
    expect(theirs.body.cash.cashExpense).toBe(mine.cashExpense);
    expect(theirs.body.cash.endingCash).toBe(11870000);
  });
});
