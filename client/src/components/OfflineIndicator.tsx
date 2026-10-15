import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Wifi, WifiOff } from 'lucide-react';

/** How long the "connection restored" note stays before fading out. */
const RESTORED_MS = 4000;

/**
 * Connection state, as a banner.
 *
 * Offline it warns that what is on screen may be stale — operational data
 * already fetched stays visible on purpose, because a receptionist mid-check-in
 * needs the booking in front of them more than they need an empty screen.
 *
 * Coming back online it says so and refetches, rather than leaving the operator
 * to guess whether the figures are current. That confirmation matters: without
 * it the safe assumption is "still stale", and people reload the whole app.
 *
 * Retry exists because `navigator.onLine` only reports the network INTERFACE.
 * A machine on Wi-Fi with a dead uplink, or a server that is down, both report
 * "online" — so the operator needs a way to ask again that does not depend on
 * the browser having noticed anything.
 */
export function OfflineIndicator() {
  const queryClient = useQueryClient();
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  const [restored, setRestored] = useState(false);

  const retry = useCallback(() => {
    // Refetch everything currently mounted. Nothing is cached by the service
    // worker, so this genuinely goes to the server.
    void queryClient.refetchQueries();
  }, [queryClient]);

  useEffect(() => {
    const goOnline = () => {
      setOffline(false);
      setRestored(true);
      retry();
    };
    const goOffline = () => {
      setOffline(true);
      setRestored(false);
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [retry]);

  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => setRestored(false), RESTORED_MS);
    return () => clearTimeout(timer);
  }, [restored]);

  if (offline) {
    return (
      <div
        role="alert"
        data-testid="offline-banner"
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white"
      >
        <span className="inline-flex items-center gap-2">
          <WifiOff className="h-4 w-4" aria-hidden="true" />
          Mất kết nối mạng — dữ liệu có thể chưa được cập nhật.
        </span>
        <button
          type="button"
          onClick={retry}
          data-testid="offline-retry"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/20 px-2.5 py-1 font-medium underline-offset-2 hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Thử lại
        </button>
      </div>
    );
  }

  if (restored) {
    return (
      <div
        role="status"
        data-testid="online-banner"
        className="flex items-center justify-center gap-2 bg-green-600 px-4 py-1.5 text-sm font-medium text-white"
      >
        <Wifi className="h-4 w-4" aria-hidden="true" />
        Đã kết nối lại — đang tải dữ liệu mới nhất.
      </div>
    );
  }

  return null;
}
