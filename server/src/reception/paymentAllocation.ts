/**
 * ONE TRANSACTION, SEVERAL METHODS — how a payment row's money is split.
 *
 * A guest pays 1.000.000 ₫: 500.000 cash and 500.000 by transfer. That is ONE
 * transaction and ONE ledger row; the split lives on the row as four allocation
 * columns (`cashAmount`, `transferAmount`, `cardAmount`, `debtAmount`) that sum
 * to `amount`, the "Tổng tiền thu". A database CHECK holds them to that sum.
 *
 * ROWS FROM BEFORE THE SPLIT ARE NOT REWRITTEN. Their four columns are null and
 * they are read here, and only here, as `amount` under their one `method`. Every
 * reader — the drawer arithmetic, the ledger's columns, the PDF and the XLSX —
 * goes through `methodAmounts`, so the two shapes can never be summed two ways.
 */
import type { ReceptionPaymentMethod } from '@prisma/client';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, formatVnd } from './reportTypes';

export interface PaymentMoneyColumns {
  method: ReceptionPaymentMethod;
  amount: number;
  cashAmount: number | null;
  transferAmount: number | null;
  cardAmount: number | null;
  debtAmount: number | null;
}

export interface Allocation {
  method: ReceptionPaymentMethod;
  amount: number;
}

/** The allocation column of each method. */
export const ALLOCATION_COLUMN = {
  CASH: 'cashAmount',
  TRANSFER: 'transferAmount',
  CARD: 'cardAmount',
  DEBT: 'debtAmount',
} as const satisfies Record<ReceptionPaymentMethod, keyof PaymentMoneyColumns>;

/** Whether the row carries its own split (every row recorded since split payments). */
export function isAllocated(p: PaymentMoneyColumns): boolean {
  return p.cashAmount !== null && p.transferAmount !== null && p.cardAmount !== null && p.debtAmount !== null;
}

/** How much of the row each method holds — the four columns, or a legacy row's one method. */
export function methodAmounts(p: PaymentMoneyColumns): Record<ReceptionPaymentMethod, number> {
  if (isAllocated(p)) {
    return { CASH: p.cashAmount!, TRANSFER: p.transferAmount!, CARD: p.cardAmount!, DEBT: p.debtAmount! };
  }
  return { CASH: 0, TRANSFER: 0, CARD: 0, DEBT: 0, [p.method]: p.amount };
}

/** The methods actually used, in the selector's order, with their amounts. */
export function allocationsOf(p: PaymentMoneyColumns): Allocation[] {
  const amounts = methodAmounts(p);
  return PAYMENT_METHODS.filter((m) => amounts[m] > 0).map((method) => ({ method, amount: amounts[method] }));
}

/** "Tiền mặt 500.000 ₫ + Chuyển khoản 500.000 ₫" — also the audit trail's wording. */
export function describeAllocations(allocations: readonly Allocation[]): string {
  if (allocations.length === 0) return '—';
  return allocations.map((a) => `${PAYMENT_METHOD_LABELS[a.method]} ${formatVnd(a.amount)}`).join(' + ');
}

/**
 * The columns to store for a set of allocations that has ALREADY been validated
 * (non-negative, one per method). The primary method is the largest allocation,
 * the first one named winning a tie — so with nothing above zero it is the first
 * method named, and a zero-đồng single-method row keeps the method it was given.
 */
export function allocationColumns(allocations: readonly Allocation[]): Omit<PaymentMoneyColumns, 'amount'> {
  const amounts: Record<ReceptionPaymentMethod, number> = { CASH: 0, TRANSFER: 0, CARD: 0, DEBT: 0 };
  for (const a of allocations) amounts[a.method] += a.amount;
  let primary: ReceptionPaymentMethod = allocations[0]?.method ?? 'CASH';
  for (const m of PAYMENT_METHODS) if (amounts[m] > amounts[primary]) primary = m;
  return {
    method: primary,
    cashAmount: amounts.CASH,
    transferAmount: amounts.TRANSFER,
    cardAmount: amounts.CARD,
    debtAmount: amounts.DEBT,
  };
}
