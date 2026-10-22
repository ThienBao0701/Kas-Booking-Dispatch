/**
 * Watches the hotel server and shows the unavailable page when it stops
 * answering.
 *
 * Mounted once, beside the PWA manager, rather than inside the app shell: a
 * server that has gone away is not a routing concern, and putting the check
 * behind a route would mean the login screen — the first place anyone meets a
 * dead server — was the one screen that never reported it.
 */
import { ServerUnavailable } from './ServerUnavailable';
import { useServerReachable } from '../api/useServerReachable';

export function ServerWatch() {
  const { unavailable, retrying, retry } = useServerReachable();
  if (!unavailable) return null;
  return <ServerUnavailable onRetry={retry} retrying={retrying} />;
}
