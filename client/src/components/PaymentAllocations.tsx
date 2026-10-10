/**
 * "PHƯƠNG THỨC THANH TOÁN" — ONE transaction, paid one or several ways.
 *
 *   Tổng tiền thu   1.000.000 ₫
 *   [Tiền mặt     ▾] [  500.000 ₫] [X]
 *   [Chuyển khoản ▾] [  500.000 ₫] [X]
 *   [+ Thêm phương thức]                       Khớp tổng ✓
 *
 * Each method at most once (a used method is not offered on another line), the
 * lines must add up to the total before Lưu is possible, and the server checks
 * the same sum again — this only keeps the operator from typing something it
 * would refuse. With one line its amount simply follows the total.
 *
 * Used by the new-payment form, the ledger's inline correction and the
 * supervisors' correction dialog — one editor, one set of rules.
 */
import { Plus, X } from 'lucide-react';
import type { PaymentMethod } from '../api/receptionReports';
import { MoneyInput } from './MoneyInput';
import { formatVnd, groupDigits } from '../lib/money';
import { METHOD_LABELS, allocationState, type AllocationLine } from '../lib/paymentAllocations';

export function PaymentAllocations({
  total,
  onTotal,
  lines,
  onLines,
  methods = METHOD_LABELS,
  compact = false,
  testId = 'payment-alloc',
}: {
  total: string;
  onTotal: (value: string) => void;
  lines: AllocationLine[];
  onLines: (lines: AllocationLine[]) => void;
  methods?: { code: PaymentMethod; label: string }[];
  /** The ledger row's inline editor: smaller controls, no field labels. */
  compact?: boolean;
  testId?: string;
}) {
  const state = allocationState(total, lines);
  const free = methods.filter((m) => !lines.some((l) => l.method === m.code));

  const setTotal = (value: string) => {
    onTotal(value);
    // One method: its amount IS the total.
    if (lines.length === 1) onLines([{ ...lines[0]!, amount: value }]);
  };
  const setLine = (index: number, patch: Partial<AllocationLine>) =>
    onLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const add = () => {
    const next = free[0];
    if (!next) return;
    const rest = state.remaining !== null && state.remaining > 0 ? groupDigits(String(state.remaining)) : '';
    onLines([...lines, { method: next.code, amount: rest }]);
  };
  const remove = (index: number) => {
    const left = lines.filter((_, i) => i !== index);
    // Back to one method: it carries the whole total again.
    onLines(left.length === 1 ? [{ ...left[0]!, amount: total }] : left);
  };

  const control = compact
    ? 'rounded-lg border border-line-strong bg-white px-2 py-1 text-xs'
    : 'min-h-[2.75rem] rounded-xl border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

  const balance =
    state.remaining === null ? null : state.remaining === 0 ? (
      <span className="font-medium text-emerald-700">Khớp tổng tiền thu</span>
    ) : state.remaining > 0 ? (
      <span className="font-medium text-amber-700">Còn thiếu {formatVnd(state.remaining)}</span>
    ) : (
      <span className="font-medium text-red-700">Vượt {formatVnd(-state.remaining)}</span>
    );

  return (
    <div data-testid={testId} className={compact ? 'space-y-1' : 'space-y-2.5'}>
      {compact ? (
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="shrink-0">Tổng</span>
          <input
            className={`${control} w-full text-right tabular-nums`}
            inputMode="numeric"
            aria-label="Tổng tiền thu"
            value={total}
            data-testid={`${testId}-total`}
            onChange={(e) => setTotal(groupDigits(e.target.value))}
          />
        </label>
      ) : (
        <MoneyInput label="Tổng tiền thu" required value={total} onChange={setTotal} data-testid={`${testId}-total`} />
      )}

      {compact ? null : <p className="text-sm font-medium text-slate-700">Phương thức thanh toán</p>}
      <ul className={compact ? 'space-y-1' : 'space-y-2'}>
        {lines.map((line, index) => (
          <li key={`${line.method}-${index}`} className="flex items-center gap-1.5" data-testid={`${testId}-line-${index}`}>
            <select
              aria-label={`Phương thức ${index + 1}`}
              value={line.method}
              onChange={(e) => setLine(index, { method: e.target.value as PaymentMethod })}
              data-testid={`${testId}-method-${index}`}
              className={`${control} min-w-0 flex-1`}
            >
              {methods
                .filter((m) => m.code === line.method || !lines.some((l) => l.method === m.code))
                .map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
            </select>
            <input
              aria-label={`Số tiền ${methods.find((m) => m.code === line.method)?.label ?? ''}`}
              inputMode="numeric"
              placeholder="0"
              value={line.amount}
              onChange={(e) => setLine(index, { amount: groupDigits(e.target.value) })}
              data-testid={`${testId}-amount-${index}`}
              className={`${control} w-32 text-right tabular-nums sm:w-36`}
            />
            <button
              type="button"
              onClick={() => remove(index)}
              disabled={lines.length === 1}
              aria-label={`Bỏ phương thức ${methods.find((m) => m.code === line.method)?.label ?? ''}`}
              data-testid={`${testId}-remove-${index}`}
              className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-line-strong text-slate-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-30 ${
                compact ? 'h-6 w-6' : 'h-10 w-10'
              }`}
            >
              <X className={compact ? 'h-3 w-3' : 'h-4 w-4'} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <div className={`flex flex-wrap items-center justify-between gap-2 ${compact ? 'text-xs' : 'text-sm'}`}>
        <button
          type="button"
          onClick={add}
          disabled={free.length === 0}
          data-testid={`${testId}-add-method`}
          className={`inline-flex items-center gap-1 rounded-lg border border-dashed border-line-strong font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-40 ${
            compact ? 'px-2 py-0.5' : 'px-3 py-1.5'
          }`}
        >
          <Plus className={compact ? 'h-3 w-3' : 'h-4 w-4'} aria-hidden="true" />
          Thêm phương thức
        </button>
        <span data-testid={`${testId}-balance`} aria-live="polite">
          {balance}
        </span>
      </div>
    </div>
  );
}
