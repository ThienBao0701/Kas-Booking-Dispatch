/**
 * WHERE A JOURNAL FORM SUBMITS. Normally `reportsApi.create`; the "Nhập bù"
 * dialog provides its own (the original shift + the required reason) so the
 * very same category forms — their fields and their checks — are reused, never
 * copied.
 */
import { createContext, useContext } from 'react';
import type { NewReportInput } from '../api/receptionReports';

export type ReportSubmit = (input: NewReportInput) => Promise<unknown>;

export const ReportSubmitContext = createContext<ReportSubmit | null>(null);

/** The override in scope, or null for the ordinary create. */
export function useReportSubmitOverride(): ReportSubmit | null {
  return useContext(ReportSubmitContext);
}
