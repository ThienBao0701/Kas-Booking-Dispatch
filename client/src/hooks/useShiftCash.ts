import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '../api/receptionReports';
import { CASH_KEY } from '../lib/reportKeys';
import { useShiftSession } from './useShiftSession';

/**
 * The CURRENT shift's drawer, for every screen that shows it.
 *
 * Keyed by the session id: after "Kết thúc ca" and a new check-in the screen
 * stays mounted, and a key without the session would keep showing the previous
 * shift's "Tiền đầu ca" — which also hides the new shift's "chưa nhập" reminder.
 * The key still starts with `CASH_KEY`, so every existing invalidation reaches it.
 */
export function useShiftCash() {
  const { data } = useShiftSession();
  const sessionId = data?.session?.id ?? null;
  return useQuery({
    queryKey: [...CASH_KEY, sessionId],
    queryFn: () => reportsApi.cash(),
  });
}
