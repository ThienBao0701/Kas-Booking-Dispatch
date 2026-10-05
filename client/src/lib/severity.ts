/** "Mức độ" — the three levels in priority order; the server supplies each record's label. */
import type { Severity } from '../api/receptionReports';

export const SEVERITY_OPTIONS: { code: Severity; label: string }[] = [
  { code: 'HIGH', label: 'Cao' },
  { code: 'MEDIUM', label: 'Trung bình' },
  { code: 'LOW', label: 'Thấp' },
];

/** The level a new record starts on — the server's default as well. */
export const DEFAULT_SEVERITY: Severity = 'MEDIUM';
