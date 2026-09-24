/**
 * A VND amount field that shows "3.150.000" while it is being typed.
 *
 * WHY THE VALUE IS A STRING AND THE CALLER PARSES IT
 *
 * An `<input>` holds a string, and half-typed money is a real state: "3", "31",
 * "3.15". A component that owned a number would have to guess what "" means, and
 * the only two available guesses — 0 and "unchanged" — are both wrong on a cash
 * field. So the string is the state, `parseVnd` turns it into an integer at the
 * moment of submission, and "nothing entered" stays distinguishable from "zero".
 *
 * `type="text"` with `inputMode="numeric"`, never `type="number"`: a number
 * input cannot display the grouped form, and several mobile browsers discard the
 * whole value when a stray character is typed.
 */
import { useId } from 'react';
import { MONEY_INPUT_PROPS, groupDigits } from '../lib/money';

interface MoneyInputProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Shown under the field — e.g. the live total this amount feeds. */
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  'data-testid'?: string;
  disabled?: boolean;
}

export function MoneyInput({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  placeholder = '0',
  disabled,
  'data-testid': testId,
}: MoneyInputProps) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <div className="relative">
        <input
          {...MONEY_INPUT_PROPS}
          id={id}
          data-testid={testId}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          // Regrouped on every keystroke, so the operator reads the same shape
          // they will see in the table a second later.
          onChange={(e) => onChange(groupDigits(e.target.value))}
          className={`block w-full rounded-xl border px-3 py-2.5 pr-8 text-right text-sm tabular-nums text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 ${
            error ? 'border-red-400 focus:ring-red-500' : 'border-slate-300 focus:ring-brand-600'
          }`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400">
          ₫
        </span>
      </div>
      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
