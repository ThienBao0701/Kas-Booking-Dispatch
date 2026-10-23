import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '../api/receptionReports';
import { REPORTS_KEY } from '../lib/reportKeys';

/**
 * The reports still open, by category and department — the menu's per-category
 * counts. Under the reports' own key, so completing or adding a record (which
 * invalidates it) refreshes the count at once; otherwise it polls like the
 * other badges.
 */
export function useOpenReportCounts(enabled = true) {
  return useQuery({
    queryKey: [...REPORTS_KEY, 'open-counts'],
    queryFn: () => reportsApi.openCounts(),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled,
  });
}
