/** The shared report filter's state and what it means — see components/ReportFilter. */
import type { DateRangeValue } from '../components/DateRangeField';

export type PeriodMode = 'TODAY' | 'DAY' | 'RANGE';
/** Not chosen yet · every branch of the scope · one branch. */
export type BranchChoice = number | 'ALL' | null;

export interface ReportFilterValue {
  mode: PeriodMode;
  /** "Ngày cụ thể": one business date. */
  day: string;
  /** "Khoảng ngày": one range, chosen in one calendar. */
  range: DateRangeValue;
  branch: BranchChoice;
  /** '' = "Tất cả ca". */
  shiftType: string;
}

export function initialReportFilter(today: string, over: Partial<ReportFilterValue> = {}): ReportFilterValue {
  return { mode: 'TODAY', day: today, range: { from: '', to: '' }, branch: null, shiftType: '', ...over };
}

/** The business dates the filter means — null while a range is half chosen. */
export function reportPeriod(v: ReportFilterValue, today: string): { from: string; to: string } | null {
  if (v.mode === 'TODAY') return { from: today, to: today };
  if (v.mode === 'DAY') return v.day ? { from: v.day, to: v.day } : null;
  if (!v.range.from || !v.range.to) return null;
  return v.range.from <= v.range.to ? { from: v.range.from, to: v.range.to } : { from: v.range.to, to: v.range.from };
}

export function reportBranchId(v: ReportFilterValue): number | undefined {
  return typeof v.branch === 'number' ? v.branch : undefined;
}
