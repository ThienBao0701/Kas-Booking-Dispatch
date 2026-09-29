import { useQuery } from '@tanstack/react-query';
import { deliveriesApi } from '../api/receptionReports';
import { DELIVERIES_KEY } from '../lib/reportKeys';

/** Polled like the other live boards: a department watching this should see a new item arrive. */
const POLL_MS = 30_000;

/**
 * The deliveries the caller's role may read, on one side of the 12-hour rule.
 *
 * Which rows come back — the whole branch for Reception, one department for
 * Technical and Housekeeping — and which side of the rule each is on are the
 * SERVER's decisions; this hook filters nothing. `received` narrows the list to
 * the days a delivery was received on — sent to the server, never applied here.
 */
export function useDeliveries(
  scope: 'active' | 'archived',
  received?: { from: string; to: string } | null,
  enabled = true,
) {
  return useQuery({
    // The received-day window is part of the key: another period is another list.
    queryKey: [...DELIVERIES_KEY, scope, received ?? null],
    queryFn: () => deliveriesApi.list(scope, received ?? {}),
    enabled,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
}
