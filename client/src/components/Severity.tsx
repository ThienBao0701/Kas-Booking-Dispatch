/**
 * "MỨC ĐỘ" — Cao / Trung bình / Thấp, the same everywhere a request, an incident
 * or a service-quality report is shown: Reception, the managers, the Admin and
 * Technical. The level is always WRITTEN beside its mark (a filled dot for Cao
 * and Trung bình, a ring for Thấp), so it never relies on colour alone.
 *
 * The server is the authority — it orders and filters by level, and supplies
 * the label on every record; the fallback words here only fill a selector
 * before the server has answered.
 */
import type { Severity } from '../api/receptionReports';
import { SEVERITY_OPTIONS } from '../lib/severity';


const STYLE: Record<Severity | 'NONE', { badge: string; mark: string }> = {
  HIGH: { badge: 'border-red-300 bg-red-50 text-red-800', mark: 'bg-red-600' },
  MEDIUM: { badge: 'border-orange-300 bg-orange-50 text-orange-800', mark: 'bg-orange-500' },
  LOW: { badge: 'border-slate-300 bg-white text-slate-700', mark: 'ring-1 ring-slate-500' },
  NONE: { badge: 'border-dashed border-slate-300 bg-white text-slate-500', mark: 'hidden' },
};

export function SeverityBadge({ severity, label }: { severity: Severity | null | undefined; label?: string }) {
  const style = STYLE[severity ?? 'NONE'];
  const text = label ?? SEVERITY_OPTIONS.find((o) => o.code === severity)?.label ?? 'Chưa phân mức';
  return (
    <span
      data-testid="severity-badge"
      data-severity={severity ?? 'NONE'}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${style.badge}`}
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${style.mark}`} />
      {text}
    </span>
  );
}

/** "Mức độ: Cao | Trung bình | Thấp" — required, one of three, as a segmented control. */
export function SeverityPicker({
  value,
  onChange,
  testId = 'severity-picker',
}: {
  /** '' only on a record from before the level existed, until one is chosen. */
  value: Severity | '';
  onChange: (value: Severity) => void;
  testId?: string;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend className="mb-1.5 block text-sm font-medium text-slate-700">
        Mức độ <span className="text-rose-600">*</span>
      </legend>
      <div role="radiogroup" aria-label="Mức độ" className="inline-flex overflow-hidden rounded-xl border border-line-strong">
        {SEVERITY_OPTIONS.map((o, i) => {
          const on = value === o.code;
          return (
            <button
              key={o.code}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.code)}
              data-testid={`${testId}-${o.code}`}
              className={`inline-flex min-h-[2.5rem] items-center gap-1.5 px-3.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                i > 0 ? 'border-l border-line-strong' : ''
              } ${on ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
            >
              <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${on ? 'bg-white' : STYLE[o.code].mark}`} />
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** "Tất cả mức độ / Cao / Trung bình / Thấp" — a filter the SERVER applies. */
export function SeverityFilter({
  value,
  onChange,
  testId = 'severity-filter',
  className = '',
}: {
  value: Severity | '';
  onChange: (value: Severity | '') => void;
  testId?: string;
  className?: string;
}) {
  return (
    <label className={`block text-sm font-medium text-slate-700 ${className}`}>
      <span className="mb-1.5 block">Mức độ</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Severity | '')}
        data-testid={testId}
        className="block min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm font-normal text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <option value="">Tất cả mức độ</option>
        {SEVERITY_OPTIONS.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
