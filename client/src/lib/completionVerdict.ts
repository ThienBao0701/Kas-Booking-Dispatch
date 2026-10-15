/** The shared "Hoàn thành" answer — see components/CompletionVerdict. */
import type { ReportVerdict } from '../api/issues';

export interface VerdictValue {
  verdict: ReportVerdict | null;
  /** "Cách xử lý (nếu có)" — kept with "Đúng". */
  resolution: string;
  /** "Lý do báo cáo sai" — required with "Sai". */
  reason: string;
}

export const EMPTY_VERDICT: VerdictValue = { verdict: null, resolution: '', reason: '' };

/** Ready to send: a verdict, and a reason when it is "Sai". */
export function verdictReady(v: VerdictValue): boolean {
  return v.verdict === 'CORRECT' || (v.verdict === 'INCORRECT' && v.reason.trim().length > 0);
}

/** What the API takes, trimmed; nothing blank is sent. */
export function verdictPayload(v: VerdictValue): {
  verdict: ReportVerdict;
  resolution?: string;
  incorrectReason?: string;
} {
  return v.verdict === 'INCORRECT'
    ? { verdict: 'INCORRECT', incorrectReason: v.reason.trim() }
    : { verdict: 'CORRECT', ...(v.resolution.trim() ? { resolution: v.resolution.trim() } : {}) };
}

/**
 * What a completed record says about its handling: "Cách xử lý" for "Đúng",
 * "Báo cáo sai: <lý do>" for "Sai" — one wording on every table.
 */
export function completionText(c: {
  resolution?: string | null;
  reportVerdict?: ReportVerdict | null;
  incorrectReason?: string | null;
}): string | null {
  if (c.reportVerdict === 'INCORRECT') return `Báo cáo sai: ${c.incorrectReason ?? '—'}`;
  return c.resolution ?? null;
}
