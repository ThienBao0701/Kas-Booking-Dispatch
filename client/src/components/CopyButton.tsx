import { Check, Copy, Scissors } from 'lucide-react';
import { useCopy } from '../lib/copy';
import type { CutField } from '../api/bookings';
import { CUT_FIELD_LABELS, CUT_LABEL, CUT_PLACEHOLDER, type CutController } from '../lib/cut';

interface CopyButtonProps {
  value: string;
  /** Accessible label, e.g. "Sao chép tên khách". */
  label: string;
  /** Visible button text; defaults to "Sao chép". */
  text?: string;
  /** When set, the control is disabled and explains why (accessible title). */
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}

/** A compact copy control that briefly confirms with "Đã sao chép". */
export function CopyButton({ value, label, text = 'Sao chép', disabled = false, disabledReason, className = '' }: CopyButtonProps) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      disabled={disabled}
      aria-label={label}
      title={disabled ? disabledReason ?? label : label}
      className={`inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${className}`}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
          <span className="text-green-700">Đã sao chép</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{text}</span>
        </>
      )}
    </button>
  );
}

/**
 * The CẮT control — the receptionist's replacement for copying a field.
 *
 * Deliberately a distinct component rather than a mode of `CopyButton`: the two
 * do different things (one duplicates a value, one takes it away) and giving
 * them one implementation would make it far too easy to turn an Admin's copy
 * button into a cut by passing the wrong prop.
 */
export function CutButton({
  field,
  value,
  controller,
  className = '',
}: {
  field: CutField;
  /**
   * The EXACT string to place on the clipboard — passed in rather than derived,
   * so what is pasted is what was on screen, line breaks and all.
   */
  value: string;
  controller: CutController;
  className?: string;
}) {
  const pending = controller.pending === field;
  return (
    <button
      type="button"
      onClick={() => controller.cut(field, value)}
      disabled={controller.pending !== null}
      aria-label={`CẮT ${CUT_FIELD_LABELS[field]}`}
      data-testid={`cut-${field}`}
      className={`inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{pending ? 'Đang cắt…' : CUT_LABEL}</span>
    </button>
  );
}

/** What a field shows once its value has been taken. */
export function CutPlaceholder() {
  return (
    <p data-testid="cut-placeholder" className="mt-0.5 text-base font-medium italic text-slate-400">
      {CUT_PLACEHOLDER}
    </p>
  );
}

interface CopyFieldProps {
  label: string;
  value: string | null | undefined;
  /** The exact text to copy; defaults to the displayed value. */
  copyValue?: string;
  mono?: boolean;
  /**
   * Turns this field into a CẮT control.
   *
   * Absent on every Admin screen and on every list that is not a dispatch
   * queue, which is what keeps the rest of the application's copy buttons
   * exactly as they were.
   */
  cut?: { field: CutField; controller: CutController };
}

/**
 * A labelled read-only field with its own Copy button — the core receptionist
 * primitive so any single piece of a booking can be copied in one click.
 */
export function CopyField({ label, value, copyValue, mono = false, cut }: CopyFieldProps) {
  const display = value && value.length > 0 ? value : '—';
  const canCopy = !!value && value.length > 0;
  const isCut = cut ? cut.controller.isCut(cut.field) : false;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
        {isCut ? (
          <CutPlaceholder />
        ) : (
          <p className={`mt-0.5 break-words text-base font-medium text-slate-900 ${mono ? 'font-mono' : ''}`}>{display}</p>
        )}
      </div>
      {cut ? (
        isCut ? null : (
          <CutButton
            field={cut.field}
            // The same string the copy button would have put on the clipboard,
            // so replacing copy with cut changes what happens to the field on
            // screen and nothing about what gets pasted.
            value={copyValue ?? value ?? ''}
            controller={cut.controller}
            className="flex-shrink-0"
          />
        )
      ) : canCopy ? (
        <CopyButton value={copyValue ?? value} label={`Sao chép ${label}`} className="flex-shrink-0" />
      ) : null}
    </div>
  );
}
