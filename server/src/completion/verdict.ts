/**
 * "HOÀN THÀNH" — ONE RULE FOR EVERY ISSUE THAT CAN BE COMPLETED.
 *
 * An incident (the technician's "Đã xử lý xong"), a guest request and a
 * service-quality report are three tables, but finishing any of them asks the
 * same question: was the report right?
 *
 *   ĐÚNG — the problem was real and was handled; "Cách xử lý (nếu có)" is
 *          optional and stored as the record's resolution.
 *   SAI  — the report was wrong; "Lý do báo cáo sai" is REQUIRED.
 *
 * The verdict itself is required: a completion without it is refused here, so no
 * caller — whichever screen or a crafted request — can finish an issue without
 * answering. "Hoàn thành vấn đề → Vấn đề báo cáo đúng / sai" are views over this
 * column; nothing is moved. A NULL verdict (completed before the question existed)
 * reads as "Đúng".
 */
import type { ReportVerdict } from '@prisma/client';
import { ApiError } from '../lib/errors';

export const REPORT_VERDICTS = ['CORRECT', 'INCORRECT'] as const satisfies readonly ReportVerdict[];

export const REPORT_VERDICT_LABELS: Record<ReportVerdict, string> = {
  CORRECT: 'Báo cáo đúng',
  INCORRECT: 'Báo cáo sai',
};

export interface CompletionVerdictInput {
  verdict?: ReportVerdict | null;
  /** "Cách xử lý (nếu có)" — kept only for "Đúng". */
  resolution?: string | null;
  /** "Lý do báo cáo sai" — required for "Sai". */
  incorrectReason?: string | null;
}

export interface CompletionVerdict {
  reportVerdict: ReportVerdict;
  /** Null when "Đúng" was answered without a handling text, and always for "Sai". */
  resolution: string | null;
  incorrectReason: string | null;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Validates a completion's answer; throws a 422 the dialog shows as it is. */
export function parseCompletionVerdict(input: CompletionVerdictInput): CompletionVerdict {
  if (input.verdict !== 'CORRECT' && input.verdict !== 'INCORRECT') {
    throw ApiError.validation('Vui lòng chọn báo cáo Đúng hay Sai.');
  }
  if (input.verdict === 'INCORRECT') {
    const reason = text(input.incorrectReason);
    if (!reason) throw ApiError.validation('Vui lòng nhập lý do báo cáo sai.');
    if (reason.length > 2000) throw ApiError.validation('Lý do báo cáo sai quá dài.');
    return { reportVerdict: 'INCORRECT', resolution: null, incorrectReason: reason };
  }
  const resolution = text(input.resolution);
  if (resolution && resolution.length > 2000) throw ApiError.validation('Cách xử lý quá dài.');
  return { reportVerdict: 'CORRECT', resolution, incorrectReason: null };
}

/**
 * The archive's two views. "Đúng" includes the records completed before the
 * question existed (verdict NULL); "Sai" is only what was answered "Sai".
 */
export function verdictWhere(
  verdict: ReportVerdict,
): { reportVerdict: ReportVerdict } | { OR: ({ reportVerdict: ReportVerdict } | { reportVerdict: null })[] } {
  return verdict === 'INCORRECT' ? { reportVerdict: 'INCORRECT' } : { OR: [{ reportVerdict: 'CORRECT' }, { reportVerdict: null }] };
}
