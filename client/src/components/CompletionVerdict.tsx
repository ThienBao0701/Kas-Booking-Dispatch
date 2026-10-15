/**
 * "HOÀN THÀNH" — the one question every completion asks: was the report right?
 *
 *   ○ Đúng → "Cách xử lý (nếu có)", optional
 *   ○ Sai  → "Lý do báo cáo sai", required
 *
 * Shared by every "Hoàn thành" dialog (an incident, a guest request, a
 * service-quality report) so they cannot drift; the server applies the same
 * rule and refuses a completion without it.
 */
import type { ReportVerdict } from '../api/issues';
import type { VerdictValue } from '../lib/completionVerdict';

const FIELD =
  'mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function CompletionVerdictFields({
  value,
  onChange,
  resolutionLabel = 'Cách xử lý (nếu có)',
  resolutionPlaceholder,
}: {
  value: VerdictValue;
  onChange: (next: VerdictValue) => void;
  /** "Cách xử lý (nếu có)" / "Hướng xử lý (nếu có)". */
  resolutionLabel?: string;
  resolutionPlaceholder?: string;
}) {
  const option = (verdict: ReportVerdict, label: string) => (
    <label
      className={`flex flex-1 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-medium ${
        value.verdict === verdict ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-slate-700 hover:bg-slate-50'
      }`}
    >
      <input
        type="radio"
        name="report-verdict"
        checked={value.verdict === verdict}
        onChange={() => onChange({ ...value, verdict })}
        data-testid={`verdict-${verdict}`}
        className="h-4 w-4 accent-brand-600"
      />
      {label}
    </label>
  );
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">
          Vấn đề được báo cáo <span className="text-rose-600">*</span>
        </legend>
        <div className="flex gap-2">
          {option('CORRECT', 'Đúng')}
          {option('INCORRECT', 'Sai')}
        </div>
      </fieldset>
      {value.verdict === 'CORRECT' ? (
        <label className="block text-sm font-medium text-slate-700">
          {resolutionLabel}
          <textarea
            className={FIELD}
            rows={3}
            maxLength={2000}
            value={value.resolution}
            onChange={(e) => onChange({ ...value, resolution: e.target.value })}
            placeholder={resolutionPlaceholder}
            data-testid="verdict-resolution"
          />
        </label>
      ) : null}
      {value.verdict === 'INCORRECT' ? (
        <label className="block text-sm font-medium text-slate-700">
          Lý do báo cáo sai <span className="text-rose-600">*</span>
          <textarea
            className={FIELD}
            rows={3}
            maxLength={2000}
            value={value.reason}
            onChange={(e) => onChange({ ...value, reason: e.target.value })}
            placeholder="Ví dụ: Thiết bị vẫn hoạt động bình thường khi kiểm tra"
            aria-invalid={value.reason.trim() === '' ? true : undefined}
            data-testid="verdict-reason"
          />
        </label>
      ) : null}
    </div>
  );
}
