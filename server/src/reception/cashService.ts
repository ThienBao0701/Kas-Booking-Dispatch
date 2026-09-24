/**
 * THE CASH DRAWER — "Tiền đầu ca", "Tiền cuối ca", and the one formula between
 * them.
 *
 *   TIỀN CUỐI CA = TIỀN ĐẦU CA + TỔNG THU TIỀN MẶT − TỔNG CHI TIỀN MẶT
 *
 * THIS IS THE ONLY PLACE THAT ARITHMETIC EXISTS. The reception screen shows it
 * live, the Admin drill-down shows it, the PDF prints it and the XLSX writes it —
 * all four are handed the result of this function. A second implementation in
 * React would be a second answer, and the two would disagree on exactly the
 * shift where somebody needed to explain a discrepancy.
 *
 * WHY TRANSFER AND CARD ARE ABSENT FROM IT
 *
 * They are real revenue and they are reported separately, but the money never
 * reaches the drawer. Adding them would show a desk holding millions of đồng
 * that are in a bank — and the receptionist counting the drawer at the end of
 * the shift would be blamed for a shortfall that never existed.
 *
 * WHY "CHI TIỀN" IS SUBTRACTED WHATEVER THE ROW'S PAYMENT METHOD IS
 *
 * Money paid out at the desk is cash by definition. That is why it is a column
 * on the payment row rather than a fourth payment method: it is not how a guest
 * paid, it is cash leaving the till.
 *
 * WHY THERE IS NO `endingCash` COLUMN
 *
 * It is derived on every read. A stored copy is a second source of truth that
 * can drift from the rows it came from, and the drift would surface as a cash
 * discrepancy nobody could trace.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { requireOpenSession, type ShiftActor } from '../shift/shiftService';
import { assertMoney } from './reportService';

export interface CashSummary {
  /** Null when the drawer was never counted — which is NOT the same as zero. */
  openingCash: number | null;
  /** Thu tiền mặt. */
  cashCollected: number;
  /** Chuyển khoản. */
  transferCollected: number;
  /** Cà thẻ. */
  cardCollected: number;
  /** Công nợ — recorded, and deliberately outside the cash arithmetic. */
  receivable: number;
  /** Chi tiền mặt. */
  cashExpense: number;
  /**
   * Tiền cuối ca. Null exactly when `openingCash` is null: without a counted
   * starting drawer there is no honest ending figure, and printing the takings
   * as though they were the balance would be worse than printing nothing.
   */
  endingCash: number | null;
  /** How many payment rows the figures came from, voided ones excluded. */
  paymentCount: number;
  /** Voided rows, counted but never summed. */
  voidedCount: number;
}

const EMPTY: Omit<CashSummary, 'openingCash' | 'endingCash'> = {
  cashCollected: 0,
  transferCollected: 0,
  cardCollected: 0,
  receivable: 0,
  cashExpense: 0,
  paymentCount: 0,
  voidedCount: 0,
};

/**
 * Sum the payment rows matching a filter.
 *
 * VOIDED ROWS ARE EXCLUDED FROM EVERY SUM and counted separately. That is the
 * whole behavioural difference between voiding and deleting: the row is still
 * there to be read, it simply stops moving the money.
 */
export async function sumPayments(
  where: Prisma.ReceptionOperationalReportWhereInput,
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<Omit<CashSummary, 'openingCash' | 'endingCash'>> {
  const rows = await client.receptionPayment.findMany({
    where: { report: { ...where, voidedAt: null } },
    select: { method: true, amount: true, receivable: true, expense: true },
  });
  const voidedCount = await client.receptionPayment.count({
    where: { report: { ...where, NOT: { voidedAt: null } } },
  });
  return accumulatePayments(rows, voidedCount);
}

type PaymentFigures = Pick<
  Prisma.ReceptionPaymentGetPayload<object>,
  'method' | 'amount' | 'receivable' | 'expense'
>;

/**
 * THE ONE PLACE PAYMENT ROWS BECOME TOTALS. `sumPayments` and the per-shift
 * figures of the official report both go through it, so there is exactly one
 * statement of which column a payment counts in.
 */
export function accumulatePayments(
  rows: PaymentFigures[],
  voidedCount: number,
): Omit<CashSummary, 'openingCash' | 'endingCash'> {
  const totals = { ...EMPTY, voidedCount, paymentCount: rows.length };
  for (const row of rows) {
    if (row.method === 'CASH') totals.cashCollected += row.amount;
    else if (row.method === 'TRANSFER') totals.transferCollected += row.amount;
    else totals.cardCollected += row.amount;
    totals.receivable += row.receivable;
    // Always cash, whatever `method` says — see the module comment.
    totals.cashExpense += row.expense;
  }
  return totals;
}

/**
 * Each shift's OWN drawer, for a set of shifts, in one read.
 *
 * The official report closes every shift with its figures — opening, takings,
 * outflow, ending — and asking the database once per shift would make a month's
 * export thousands of queries. One read of the payment rows, grouped here.
 */
export async function perShiftCash(
  sessions: { id: string; openingCash: number | null }[],
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<Map<string, CashSummary>> {
  const result = new Map<string, CashSummary>();
  if (sessions.length === 0) return result;
  const rows = await client.receptionPayment.findMany({
    where: { report: { shiftSessionId: { in: sessions.map((s) => s.id) } } },
    select: {
      method: true,
      amount: true,
      receivable: true,
      expense: true,
      report: { select: { shiftSessionId: true, voidedAt: true } },
    },
  });
  for (const session of sessions) {
    const mine = rows.filter((r) => r.report.shiftSessionId === session.id);
    const live = mine.filter((r) => r.report.voidedAt === null);
    result.set(
      session.id,
      withEndingCash(session.openingCash, accumulatePayments(live, mine.length - live.length)),
    );
  }
  return result;
}

/** The formula, applied. Null opening cash means null ending cash. */
export function withEndingCash(
  openingCash: number | null,
  totals: Omit<CashSummary, 'openingCash' | 'endingCash'>,
): CashSummary {
  return {
    openingCash,
    ...totals,
    endingCash:
      openingCash === null ? null : openingCash + totals.cashCollected - totals.cashExpense,
  };
}

/** One shift's drawer. */
/**
 * The drawer across a SET of shifts — a business date's, at one branch.
 *
 * Same arithmetic as every other summary here (`sumPayments` + `withEndingCash`,
 * unchanged): the opening figure is the EARLIEST of these shifts' own count, and
 * the payments are exactly the rows written on these shifts — so an after-
 * midnight payment on Ca C counts toward the day Ca C belongs to, not toward the
 * calendar day it happened to be typed on. No shifts means no drawer.
 */
export async function sessionsCashSummary(
  sessionIds: string[],
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<CashSummary> {
  if (sessionIds.length === 0) return withEndingCash(null, { ...EMPTY });
  const first = await client.receptionShiftSession.findFirst({
    where: { id: { in: sessionIds } },
    orderBy: { startedAt: 'asc' },
    select: { openingCash: true },
  });
  return withEndingCash(
    first?.openingCash ?? null,
    await sumPayments({ shiftSessionId: { in: sessionIds } }, client),
  );
}

export async function shiftCashSummary(
  shiftSessionId: string,
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<CashSummary> {
  const session = await client.receptionShiftSession.findUnique({
    where: { id: shiftSessionId },
    select: { openingCash: true },
  });
  const totals = await sumPayments({ shiftSessionId }, client);
  return withEndingCash(session?.openingCash ?? null, totals);
}

/**
 * A branch over a period — the Admin's figure.
 *
 * "TIỀN ĐẦU CA" OVER A PERIOD IS THE FIRST SHIFT'S COUNT, NOT THE SUM OF THEM.
 *
 * Summing them was the obvious reading of "tổng hợp" and it is arithmetically
 * nonsense, because each shift's counted opening IS (approximately) the previous
 * shift's ending — the same money is counted once per shift. A branch running
 * three shifts a day for a week would report a drawer roughly twenty times the
 * real one, on screen, in the PDF and in the XLSX.
 *
 * The drawer is a RUNNING BALANCE, so the period's arithmetic is the shift's
 * arithmetic with a wider set of rows:
 *
 *     opening(first shift) + all cash collected − all cash paid out
 *
 * Over a single shift that is exactly `shiftCashSummary`, which is the check
 * that the two cannot drift apart.
 *
 * WHICH SHIFT IS "FIRST" IS AN OVERLAP TEST, NOT `startedAt >= from`.
 *
 * A Ca C that starts at 22:00 on the 19th and records a payment at 01:30 on the
 * 20th belongs to a report for the 20th — its money is in the period. Selecting
 * sessions by `startedAt` inside the window would take that payment in while
 * leaving its opening count out, and the night shift would look like pure
 * profit. So a session counts when its own `[startedAt, closedAt)` interval
 * overlaps the period at all.
 *
 * AN UNCOUNTED FIRST SHIFT MAKES THE WHOLE FIGURE NULL, deliberately. Skipping
 * forward to the next shift that HAS a count would add the uncounted shift's
 * takings on top of a later shift's opening — the same error in a subtler place.
 * "Chưa xác định" is the honest answer.
 */
export async function branchCashSummary(
  branchId: number,
  range: { from?: Date; to?: Date } = {},
  client: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<CashSummary> {
  const reportWhere: Prisma.ReceptionOperationalReportWhereInput = {
    branchId,
    ...(range.from || range.to
      ? {
          createdAt: {
            ...(range.from ? { gte: range.from } : {}),
            ...(range.to ? { lt: range.to } : {}),
          },
        }
      : {}),
  };

  /*
    The EARLIEST shift whose own interval overlaps the period — counted or not.
    `closedAt: null` is an open shift, which overlaps anything that has not
    ended before it started.
  */
  const overlapping: Prisma.ReceptionShiftSessionWhereInput = { branchId };
  const bounds: Prisma.ReceptionShiftSessionWhereInput[] = [];
  if (range.to) bounds.push({ startedAt: { lt: range.to } });
  if (range.from) {
    bounds.push({ OR: [{ closedAt: null }, { closedAt: { gt: range.from } }] });
  }
  if (bounds.length) overlapping.AND = bounds;

  const first = await client.receptionShiftSession.findFirst({
    where: overlapping,
    orderBy: { startedAt: 'asc' },
    select: { openingCash: true },
  });

  return withEndingCash(first?.openingCash ?? null, await sumPayments(reportWhere, client));
}

/**
 * Set or correct "Tiền đầu ca" on the actor's OWN open shift.
 *
 * ONLY ON AN OPEN SESSION, and only on their own. A closed shift's drawer count
 * is a historical fact; letting the next receptionist edit it would let a
 * shortfall be moved from one shift to the previous one after the event.
 *
 * A CORRECTION IS AUDITED like any other. The first count writes an audit row
 * with `oldValue: null`, so "who decided the drawer held 7.570.000?" is always
 * answerable.
 */
export async function setOpeningCash(
  amount: number,
  actor: ShiftActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<CashSummary> {
  if (actor.role !== 'RECEPTIONIST') {
    throw ApiError.forbidden('Chỉ lễ tân mới nhập được tiền đầu ca.');
  }
  const value = assertMoney(amount, 'Tiền đầu ca');
  const session = await requireOpenSession(actor, client);
  const now = clock.now();

  const before = await client.receptionShiftSession.findUnique({
    where: { id: session.id },
    select: { openingCash: true },
  });
  const previous = before?.openingCash ?? null;
  if (previous === value) return shiftCashSummary(session.id, client);

  await client.$transaction(async (tx) => {
    await tx.receptionShiftSession.update({
      where: { id: session.id },
      data: { openingCash: value, openingCashSetAt: now },
    });
    await tx.receptionReportAudit.create({
      data: {
        branchId: session.branchId,
        // No `reportId`: the drawer belongs to the shift, not to any one payment.
        shiftSessionId: session.id,
        action: 'OPENING_CASH',
        field: 'openingCash',
        oldValue: previous === null ? null : String(previous),
        newValue: String(value),
        actorUserId: actor.id,
        actorNameSnapshot: session.receptionistName,
        actorShiftType: session.shiftType,
        createdAt: now,
      },
    });
  });

  return shiftCashSummary(session.id, client);
}
