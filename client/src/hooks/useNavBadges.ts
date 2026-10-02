import { useQuery } from '@tanstack/react-query';
import { navBadgesApi } from '../api/navBadges';

/**
 * Shared key so anything that changes a queue can invalidate the badges:
 * `queryClient.invalidateQueries({ queryKey: ['nav-badges'] })`.
 */
export const NAV_BADGES_KEY = ['nav-badges'] as const;

/**
 * Twenty seconds, matching the queues the badges summarise.
 *
 * Polling rather than a socket, deliberately: this reuses the architecture the
 * issue badge, the notification bell and every dispatch list already use, and a
 * WebSocket for six integers would be a second transport to operate, secure and
 * reconnect for no gain a 20-second refresh does not already provide.
 */
const POLL_MS = 20_000;

export function useNavBadges(enabled = true) {
  return useQuery({
    queryKey: NAV_BADGES_KEY,
    queryFn: () => navBadgesApi.get(),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    enabled,
  });
}
