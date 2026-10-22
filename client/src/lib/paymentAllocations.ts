/**
 * The rules of the "Phương thức thanh toán" editor (components/PaymentAllocations):
 * what its lines say, whether they may be saved, and what is sent. The server
 * checks the same sum again — this only stops a form it would refuse.
 */
import type { PaymentAllocation, PaymentMethod } from '../api/receptionReports';
import { groupDigits, parseVnd } from './money';

export interface AllocationLine {
  method: PaymentMethod;
  /** As typed, grouped ("500.000"). */
  amount: string;
}

export const METHOD_LABELS: { code: PaymentMethod; label: string }[] = [
  { code: 'CASH', label: 'Tiền mặt' },
  { code: 'TRANSFER', label: 'Chuyển khoản' },
  { code: 'CARD', label: 'Cà thẻ' },
  { code: 'DEBT', label: 'Công nợ' },
];

/** The editor's lines for a stored payment: its allocations, or one line for a legacy row. */
export function linesOf(p: { method: PaymentMethod; amount: number; allocations?: PaymentAllocation[] }): AllocationLine[] {
  const used = p.allocations && p.allocations.length > 0 ? p.allocations : [{ method: p.method, amount: p.amount }];
  return used.map((a) => ({ method: a.method, amount: groupDigits(String(a.amount)) }));
}

/** What the lines say: the parsed total and allocations, and whether they may be saved. */
export function allocationState(total: string, lines: AllocationLine[]) {
  const totalValue = parseVnd(total);
  const parsed = lines.map((l) => ({ method: l.method, amount: parseVnd(l.amount) }));
  const sum = parsed.reduce((n, l) => n + (l.amount ?? 0), 0);
  const distinct = new Set(lines.map((l) => l.method)).size === lines.length;
  const complete = lines.length > 0 && parsed.every((l) => l.amount !== null);
  return {
    total: totalValue,
    sum,
    allocations: parsed.map((l) => ({ method: l.method, amount: l.amount ?? 0 })) as PaymentAllocation[],
    /** Positive: still to allocate; negative: allocated too much. */
    remaining: totalValue === null ? null : totalValue - sum,
    valid: totalValue !== null && complete && distinct && sum === totalValue,
  };
}

/**
 * The money part of a create or correction body. One method is sent as the
 * older single-method body ({ method, amount }); several as the total and its
 * allocations. The server reads both as the same transaction.
 */
export function paymentMoneyPayload(total: string, lines: AllocationLine[]) {
  const state = allocationState(total, lines);
  const amount = state.total ?? 0;
  return lines.length === 1 ? { method: lines[0]!.method, amount } : { amount, allocations: state.allocations };
}
